'use strict';
// Duty agents: when is a 24/7 agent broken. Pure functions, time is passed in.
const MIN = 60000;
const DEFAULT_SETTINGS = { tickSec: 30, blockedMin: 10, missingMin: 3, graceMin: 10, silenceMarginMin: 10 };

const UNIT_MS = {
  s: 1000, 'с': 1000,
  m: MIN, 'м': MIN, min: MIN, 'мин': MIN,
  h: 60 * MIN, 'ч': 60 * MIN,
  d: 1440 * MIN, 'д': 1440 * MIN,
};

function parseEvery(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(s|с|m|м|min|мин|h|ч|d|д)?$/);
  if (!m) return null;
  const ms = Math.round(parseFloat(m[1].replace(',', '.')) * UNIT_MS[m[2] || 'm']);
  return ms > 0 ? ms : null;
}

function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 60) return `${m}м`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h}ч${r}м` : `${h}ч`;
  return `${Math.floor(h / 24)}д`;
}

function newDuty({ id, wsId, label, paneId, terminalId, agentSession, everyMs, note, source, now }) {
  return {
    id, wsId, label: label || '', paneId: paneId || null, terminalId: terminalId || null,
    agentSession: agentSession || null, everyMs, note: note || '', source: source || 'agent',
    createdAt: now, lastLifeAt: now, lastSeq: null, blockedSince: null, missingSince: null,
    fail: null, alert: null,
  };
}

function locateAgent(d, agents) {
  return (d.terminalId && agents.find(a => a.terminal_id === d.terminalId))
    || (d.agentSession && agents.find(a => a.agent_session && a.agent_session.value === d.agentSession))
    || (d.paneId && agents.find(a => a.pane_id === d.paneId))
    || null;
}

function observe(prev, agent, now) {
  const d = { ...prev };
  if (agent) {
    d.missingSince = null;
    if (agent.terminal_id) d.terminalId = agent.terminal_id;
    if (agent.pane_id) d.paneId = agent.pane_id;
    if (agent.workspace_id) d.wsId = agent.workspace_id;
    if (agent.agent_session && agent.agent_session.value) d.agentSession = agent.agent_session.value;
    const seq = agent.state_change_seq ?? null;
    const woke = d.lastSeq !== null && seq !== null && seq !== d.lastSeq;
    if (agent.agent_status === 'working' || woke) d.lastLifeAt = now;
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
    return { kind: 'gone', text: 'окно агента пропало' };
  }
  if (d.blockedSince !== null && now - d.blockedSince >= settings.blockedMin * MIN) {
    return { kind: 'blocked', text: `ждёт ответа ${fmtDur(now - d.blockedSince)}` };
  }
  const silent = now - d.lastLifeAt;
  if (silent > d.everyMs + Math.max(d.everyMs / 2, settings.silenceMarginMin * MIN)) {
    return { kind: 'sleep', text: `не просыпался ${fmtDur(silent)}` };
  }
  return null;
}

// One alert per incident: 'alert' when it starts, 'recover' when it ends.
function evaluate(prev, agent, now, settings, startedAt) {
  const d = observe(prev, agent, now);
  const cond = condition(d, now, settings);
  const inGrace = now - startedAt < settings.graceMin * MIN;
  if (inGrace && !(cond && cond.kind === 'fail')) return { duty: d, event: null };
  if (cond) {
    if (!d.alert) {
      d.alert = { kind: cond.kind, text: cond.text, since: now };
      return { duty: d, event: 'alert' };
    }
    d.alert = { ...d.alert, kind: cond.kind, text: cond.text };
    return { duty: d, event: null };
  }
  if (d.alert) {
    // Recovery needs the agent in sight: a window that just vanished is not "fixed".
    if (!agent) return { duty: d, event: null };
    d.alert = null;
    return { duty: d, event: 'recover' };
  }
  return { duty: d, event: null };
}

function applyOk(d, now) { return { ...d, lastLifeAt: now, fail: null }; }

function applyFail(d, now, reason) {
  const text = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'агент сообщил о беде';
  return { ...d, fail: { reason: text, at: now } };
}

function applyReset(d, now) { return { ...d, fail: null, alert: null, lastLifeAt: now, blockedSince: null, missingSince: null }; }

function dutyToken(d) {
  return d.alert ? `▲ ${d.alert.text}` : `◆ дежурит · ${fmtDur(d.everyMs)}`;
}

function alertText(label, d) { return `🔴 Дежурство: ${label} — ${d.alert ? d.alert.text : 'тревога'}`; }
function recoverText(label) { return `🟢 Дежурство: ${label} — снова работает`; }

module.exports = {
  DEFAULT_SETTINGS, parseEvery, fmtDur, newDuty, locateAgent, evaluate,
  applyOk, applyFail, applyReset, dutyToken, alertText, recoverText,
};
