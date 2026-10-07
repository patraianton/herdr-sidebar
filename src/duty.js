'use strict';
// Duty agents: when is a 24/7 agent broken. Pure functions, time is passed in.
const MIN = 60000;
const DEFAULT_SETTINGS = { tickSec: 30, blockedMin: 10, missingMin: 3, graceMin: 10, silenceMarginMin: 10 };

const UNIT_MS = { s: 1000, m: MIN, min: MIN, h: 60 * MIN, d: 1440 * MIN };

function parseEvery(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(s|m|min|h|d)?$/);
  if (!m) return null;
  const ms = Math.round(parseFloat(m[1].replace(',', '.')) * UNIT_MS[m[2] || 'm']);
  return ms > 0 ? ms : null;
}

function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h}h${r}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${Math.floor(h / 24)}d`;
}

// How long a duty has been on. Whole hours after the first one, so the
// sidebar mark changes once a minute at most at first and then hourly.
function fmtAge(ms) {
  const m = Math.max(0, Math.floor(ms / MIN));
  return m < 60 ? `${m}m` : fmtDur(Math.floor(m / 60) * 60 * MIN);
}

function newDuty({ id, wsId, label, paneId, terminalId, agentSession, everyMs, note, source, now }) {
  return {
    id, wsId, label: label || '', paneId: paneId || null, terminalId: terminalId || null,
    agentSession: agentSession || null, everyMs, note: note || '', source: source || 'agent',
    createdAt: now, lastLifeAt: now, lastActiveAt: now, lastSeq: null, blockedSince: null, missingSince: null,
    fail: null, alert: null,
  };
}

function locateAgent(d, agents) {
  return (d.terminalId && agents.find(a => a.terminal_id === d.terminalId))
    || (d.agentSession && agents.find(a => a.agent_session && a.agent_session.value === d.agentSession))
    // Same pane id only if nothing says it is another agent (pane ids survive a restart).
    || (d.paneId && agents.find(a => a.pane_id === d.paneId
      && !(d.agentSession && a.agent_session && a.agent_session.value && a.agent_session.value !== d.agentSession)))
    || null;
}

function observe(prev, agent, now) {
  const d = { ...prev };
  if (agent) {
    // A new terminal means herdr or the agent was restarted: its counter starts over.
    const newTerminal = !!(prev.terminalId && agent.terminal_id && agent.terminal_id !== prev.terminalId);
    d.missingSince = null;
    if (agent.terminal_id) d.terminalId = agent.terminal_id;
    if (agent.pane_id) d.paneId = agent.pane_id;
    if (agent.workspace_id) d.wsId = agent.workspace_id;
    if (agent.agent_session && agent.agent_session.value) d.agentSession = agent.agent_session.value;
    const seq = agent.state_change_seq ?? null;
    const woke = !newTerminal && d.lastSeq !== null && seq !== null && seq > d.lastSeq;
    if (agent.agent_status === 'working' || woke) {
      d.lastLifeAt = now;
      d.lastActiveAt = now;
    } else if (newTerminal) {
      d.lastLifeAt = now; // a restarted agent gets a fresh interval, but this is not activity
    }
    d.lastSeq = seq;
    d.blockedSince = agent.agent_status === 'blocked' ? (d.blockedSince ?? now) : null;
  } else {
    d.missingSince = d.missingSince ?? now;
    d.blockedSince = null;
  }
  return d;
}

function condition(d, now, settings) {
  if (d.fail) return { kind: 'fail', text: d.fail.reason };
  if (d.missingSince !== null && now - d.missingSince >= settings.missingMin * MIN) {
    return { kind: 'gone', text: 'agent pane is gone' };
  }
  if (d.blockedSince !== null && now - d.blockedSince >= settings.blockedMin * MIN) {
    return { kind: 'blocked', text: `waiting for input ${fmtDur(now - d.blockedSince)}` };
  }
  const silent = now - d.lastLifeAt;
  if (silent > d.everyMs + Math.max(d.everyMs / 2, settings.silenceMarginMin * MIN)) {
    return { kind: 'sleep', text: `no wake-up for ${fmtDur(silent)}` };
  }
  return null;
}

// One alert per incident: 'alert' when it starts, 'recover' when it ends.
// During the grace period after the helper starts (agents are still being
// restored) no new alert is raised, except one the agent reported itself;
// recoveries and updates of a standing alert still happen.
function evaluate(prev, agent, now, settings, startedAt) {
  const d = observe(prev, agent, now);
  const cond = condition(d, now, settings);
  const inGrace = now - startedAt < settings.graceMin * MIN;
  if (cond) {
    if (d.alert) {
      d.alert = { ...d.alert, kind: cond.kind, text: cond.text };
      return { duty: d, event: null };
    }
    if (inGrace && cond.kind !== 'fail') return { duty: d, event: null };
    d.alert = { kind: cond.kind, text: cond.text, since: now };
    return { duty: d, event: 'alert' };
  }
  if (d.alert) {
    // Recovery needs the agent in sight: a window that just vanished is not "fixed".
    if (!agent) return { duty: d, event: null };
    // "Stopped waking" ends only with real activity seen after the alert began.
    if (d.alert.kind === 'sleep' && !(d.lastActiveAt > d.alert.since)) {
      d.alert = { ...d.alert, text: `no wake-up for ${fmtDur(now - (d.lastActiveAt || d.alert.since))}` };
      return { duty: d, event: null };
    }
    d.alert = null;
    return { duty: d, event: 'recover' };
  }
  return { duty: d, event: null };
}

function applyOk(d, now) { return { ...d, lastLifeAt: now, lastActiveAt: now, fail: null }; }

function applyFail(d, now, reason) {
  const text = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'the agent reported a problem';
  return { ...d, fail: { reason: text, at: now } };
}

function applyReset(d, now) { return { ...d, fail: null, alert: null, lastLifeAt: now, lastActiveAt: now, blockedSince: null, missingSince: null }; }

function dutyToken(d, now) {
  if (d.alert) return `▲ ${d.alert.text}`;
  const age = now && d.createdAt ? ` ${fmtAge(now - d.createdAt)}` : '';
  return `◆ on duty${age} · every ${fmtDur(d.everyMs)}`;
}

function alertText(label, d) { return `🔴 Duty: ${label} — ${d.alert ? d.alert.text : 'alarm'}`; }
function recoverText(label) { return `🟢 Duty: ${label} — working again`; }

module.exports = {
  DEFAULT_SETTINGS, parseEvery, fmtDur, fmtAge, newDuty, locateAgent, evaluate,
  applyOk, applyFail, applyReset, dutyToken, alertText, recoverText,
};
