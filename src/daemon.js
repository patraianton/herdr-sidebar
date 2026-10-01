#!/usr/bin/env node
'use strict';
// Background helper, one per herdr session: keeps the Spaces order, publishes
// the $project/$duty tokens, watches duty agents and serves the window and CLI.
const fs = require('node:fs');
const path = require('node:path');
const { makeHerdr } = require('./herdr');
const rpc = require('./rpc');
const ipc = require('./ipc');
const paths = require('./paths');
const store = require('./store');
const model = require('./model');
const duty = require('./duty');
const notify = require('./notify');
const ops = require('./ops');

const SUBSCRIPTIONS = [
  'workspace.created', 'workspace.closed', 'workspace.moved', 'workspace.reordered', 'workspace.renamed',
  'worktree.created', 'worktree.opened', 'worktree.removed',
].map(type => ({ type }));
const TOKEN_KEYS = ['project', 'duty'];

function createDaemon({ socketPath, dir, configDir }) {
  const herdr = makeHerdr(socketPath);
  const files = {
    state: path.join(dir, 'state.json'),
    original: path.join(dir, 'original.json'),
    log: path.join(dir, 'daemon.log'),
    headerDir: path.join(dir, 'header'),
  };
  const settings = { ...duty.DEFAULT_SETTINGS, ...store.loadJson(path.join(configDir, 'settings.json'), {}) };
  let state = store.loadState(files.state);
  let startedAt = Date.now();
  let chain = Promise.resolve();
  const last = { snap: null, units: null, headers: {} };
  let sub = null;
  let server = null;
  let connected = false;
  let serverWasDown = false;
  let lostSince = null;
  let kickTimer = null;
  let pauseUntil = 0;
  let failCount = 0;
  const recentMoves = [];
  let stopping = false;

  function log(...parts) {
    const line = `${new Date().toISOString()} ${parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(files.log).size > 1024 * 1024) fs.renameSync(files.log, `${files.log}.1`); } catch {}
      fs.appendFileSync(files.log, line);
    } catch {}
  }
  const save = () => store.saveJson(files.state, state);
  function serial(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  async function snapshot() {
    const [workspaces, panes] = await Promise.all([herdr.listWorkspaces(), herdr.listPanes()]);
    const firstCwd = {};
    for (const p of panes) if (!(p.workspace_id in firstCwd)) firstCwd[p.workspace_id] = p.cwd || '';
    return {
      workspaces, panes, paths: firstCwd,
      order: workspaces.map(w => w.workspace_id),
      byId: new Map(workspaces.map(w => [w.workspace_id, w])),
    };
  }

  const inHeaderDir = (snap, wsId) => paths.normPath(snap.paths[wsId]) === paths.normPath(files.headerDir);

  function isOurHeader(snap, wsId) {
    const w = snap.byId.get(wsId);
    if (!w || !model.isHeaderLabel(w.label)) return false;
    return Object.values(state.headers).includes(wsId) || inHeaderDir(snap, wsId);
  }

  function liveHeaders(snap) {
    const headers = {};
    const ids = new Set();
    const orphans = [];
    for (const [cid, wsId] of Object.entries(state.headers)) {
      const w = snap.byId.get(wsId);
      if (w && model.isHeaderLabel(w.label)) { headers[cid] = wsId; ids.add(wsId); }
    }
    for (const w of snap.workspaces) {
      if (ids.has(w.workspace_id) || !model.isHeaderLabel(w.label) || !inHeaderDir(snap, w.workspace_id)) continue;
      orphans.push(w.workspace_id);
      ids.add(w.workspace_id);
    }
    return { headers, ids, orphans };
  }

  async function closeHeader(snap, wsId) {
    if (!isOurHeader(snap, wsId)) { log('refusing to close a workspace that is not our header', wsId); return false; }
    try { await herdr.closeWorkspace(wsId); return true; } catch (e) { log('closing header failed', wsId, e.message); return false; }
  }

  async function ensureHeaders(snap, h) {
    let changed = false;
    const want = state.categories.length
      ? [...state.categories.map(c => [c.id, model.headerLabel(c.name)]), [model.NONE_ID, model.NONE_LABEL]]
      : [];
    const wantIds = new Set(want.map(([id]) => id));
    for (const [cid, wsId] of Object.entries(h.headers)) {
      if (!wantIds.has(cid) && await closeHeader(snap, wsId)) changed = true;
    }
    for (const wsId of h.orphans) if (await closeHeader(snap, wsId)) changed = true;
    for (const cid of Object.keys(state.headers)) if (!h.headers[cid] || !wantIds.has(cid)) delete state.headers[cid];
    if (want.length) fs.mkdirSync(files.headerDir, { recursive: true });
    for (const [cid, label] of want) {
      const wsId = state.headers[cid];
      if (wsId) {
        if (snap.byId.get(wsId).label !== label) { await herdr.renameWorkspace(wsId, label); changed = true; }
        continue;
      }
      const ws = await herdr.createWorkspace(label, files.headerDir);
      state.headers[cid] = ws.workspace_id;
      log('header created', label, ws.workspace_id);
      changed = true;
    }
    return changed;
  }

  function allowMove() {
    const now = Date.now();
    while (recentMoves.length && now - recentMoves[0] > 60000) recentMoves.shift();
    if (recentMoves.length >= 10) {
      pauseUntil = now + 5 * 60000;
      log('too many reorders within a minute; order paused for 5 minutes');
      return false;
    }
    recentMoves.push(now);
    return true;
  }

  async function syncOrder(reason) {
    const now = Date.now();
    let snap = await snapshot();
    if (!fs.existsSync(files.original)) {
      store.saveJson(files.original, {
        savedAt: new Date(now).toISOString(), order: snap.order,
        labels: Object.fromEntries(snap.workspaces.map(w => [w.workspace_id, w.label])),
      });
      log('original order saved', snap.order.length);
    }
    for (const id of Object.keys(state.detached)) {
      if (!snap.byId.has(id)) { log('detached workspace is gone', id); delete state.detached[id]; }
    }
    let h = liveHeaders(snap);
    let units = model.buildUnits(snap.workspaces, snap.paths, h.ids);
    state = model.reconcile(state, units, now);
    const learned = model.learnFromOrder(state, units, snap.order, h.headers);
    if (learned.moved.length) {
      log('moved by hand:', learned.moved.join(' '), learned.headerMoved ? '(a header: put back)' : '');
      state = learned.state;
    }
    if (await ensureHeaders(snap, h)) {
      snap = await snapshot();
      h = liveHeaders(snap);
      units = model.buildUnits(snap.workspaces, snap.paths, h.ids);
    }
    const desired = now < pauseUntil ? null : model.desiredOrder(state, units, snap.order, h.headers);
    if (desired && desired.join() !== snap.order.join() && allowMove()) {
      try {
        state.lastApplied = (await herdr.moveBlock(desired)) || desired;
        failCount = 0;
        log('order applied', reason);
      } catch (e) {
        state.lastApplied = snap.order;
        failCount++;
        log('move_block failed', e.message);
        if (failCount >= 3) { pauseUntil = Date.now() + 5 * 60000; failCount = 0; log('order paused for 5 minutes'); }
      }
    } else {
      state.lastApplied = snap.order;
    }
    last.snap = snap;
    last.units = units;
    last.headers = h.headers;
    return snap;
  }

  function wantedTokens(snap) {
    const want = new Map();
    const put = (wsId, k, v) => {
      if (!snap.byId.has(wsId)) return;
      const t = want.get(wsId) || {};
      if (k === 'duty' && t.duty && t.duty.startsWith('▲')) return; // an alert wins over an ok mark
      t[k] = v;
      want.set(wsId, t);
    };
    for (const [wsId, d] of Object.entries(state.detached)) put(wsId, 'project', `⎇ ${d.parentLabel}`);
    for (const d of Object.values(state.duty)) if (d.wsId) put(d.wsId, 'duty', duty.dutyToken(d));
    return want;
  }

  async function publishTokens(snap) {
    const want = wantedTokens(snap);
    for (const w of snap.workspaces) {
      const have = w.tokens || {};
      const t = want.get(w.workspace_id) || {};
      const patch = {};
      for (const k of TOKEN_KEYS) {
        const v = t[k] || null;
        if ((have[k] || null) !== v) patch[k] = v;
      }
      if (!Object.keys(patch).length) continue;
      try { await herdr.setTokens(w.workspace_id, patch); } catch (e) { log('tokens failed', w.workspace_id, e.message); }
    }
  }

  function signal(event, d) {
    const label = d.label || d.wsId;
    const body = event === 'alert' ? d.alert.text : 'снова работает';
    log('duty', event, label, body);
    herdr.notify(`Дежурство: ${label}`, body).catch(e => log('toast failed', e.message));
    const text = event === 'alert' ? duty.alertText(label, d) : duty.recoverText(label);
    notify.sendTelegramWithRetry(configDir, text, { log })
      .then(r => log('telegram', r === null ? 'not set up' : (r ? 'sent' : 'failed')));
  }

  async function checkDuty(snap) {
    const ids = Object.keys(state.duty);
    if (!ids.length) return;
    const agents = await herdr.listAgents();
    const now = Date.now();
    for (const id of ids) {
      const prev = state.duty[id];
      const { duty: d, event } = duty.evaluate(prev, duty.locateAgent(prev, agents), now, settings, startedAt);
      const w = snap.byId.get(d.wsId);
      if (w) d.label = w.label;
      state.duty[id] = d;
      if (event) signal(event, d);
    }
  }

  async function cycleInner(reason) {
    if (!connected || stopping) return;
    const snap = await syncOrder(reason);
    await checkDuty(snap);
    await publishTokens(snap);
    save();
  }
  const cycle = reason => serial(() => cycleInner(reason)).catch(e => log('cycle failed', reason, e.message));
  function kick(reason, delayMs) {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => cycle(reason), delayMs);
  }

  function connectEvents() {
    if (stopping) return;
    sub = rpc.subscribe(socketPath, SUBSCRIPTIONS, {
      onReady: () => { connected = true; lostSince = null; log('connected to herdr'); kick('connect', 0); },
      onEvent: () => kick('event', 1000),
      onClose: err => {
        connected = false;
        sub = null;
        if (stopping) return;
        log('event stream closed', err ? err.message : '');
        lostSince = lostSince || Date.now();
        setTimeout(reconnect, 2000);
      },
    });
  }

  async function reconnect() {
    if (stopping) return;
    try {
      await herdr.ping();
    } catch {
      serverWasDown = true;
      if (Date.now() - lostSince > 10 * 60000) { log('herdr is gone for 10 minutes; exiting'); shutdown(0); return; }
      setTimeout(reconnect, 5000);
      return;
    }
    if (serverWasDown) { startedAt = Date.now(); serverWasDown = false; log('herdr is back; duty grace starts again'); }
    connectEvents();
  }

  // ---- commands from the window and the CLI ----

  const cleanName = name => {
    const n = String(name || '').replace(/[\r\n\t]+/g, ' ').replace(/━/g, '').trim().slice(0, 40);
    if (!n) throw new Error('Пустое название.');
    return n;
  };
  const catById = id => {
    const c = state.categories.find(x => x.id === id);
    if (!c) throw new Error('Такой категории нет.');
    return c;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  async function buildView() {
    if (!last.snap) await cycle('view');
    const units = last.units;
    if (!last.snap || !units) return { ready: false, session: paths.sessionName(socketPath), categories: [] };
    let agents = [];
    try { agents = await herdr.listAgents(); } catch {}
    const agentsOf = wsId => agents.filter(a => a.workspace_id === wsId).map(a => ({
      paneId: a.pane_id, agent: a.agent || 'agent', title: a.terminal_title_stripped || '', status: a.agent_status,
    }));
    const dutyOf = wsId => Object.values(state.duty).filter(d => d.wsId === wsId).map(d => ({
      id: d.id, paneId: d.paneId, text: duty.dutyToken(d), alert: !!d.alert, everyMs: d.everyMs,
    }));
    const unitView = u => ({
      key: u.key, kind: u.kind, label: u.label, anchorId: u.anchorId, wsIds: u.wsIds, linked: !!u.linked,
      detached: state.detached[u.anchorId] ? { parentLabel: state.detached[u.anchorId].parentLabel } : null,
      duty: dutyOf(u.anchorId), agents: agentsOf(u.anchorId),
      children: u.children.map(ch => ({ wsId: ch.wsId, label: ch.label, duty: dutyOf(ch.wsId), agents: agentsOf(ch.wsId) })),
    });
    const assigned = new Set();
    const categories = state.categories.map(c => ({
      id: c.id, name: c.name,
      units: c.units.filter(k => units.byKey[k]).map(k => { assigned.add(k); return unitView(units.byKey[k]); }),
    }));
    categories.push({ id: model.NONE_ID, name: 'БЕЗ КАТЕГОРИИ', units: units.units.filter(u => !assigned.has(u.key)).map(unitView) });
    return { ready: true, session: paths.sessionName(socketPath), categories };
  }

  async function dutyTarget(args) {
    let pane = null;
    if (args.paneId) { try { pane = await herdr.getPane(args.paneId); } catch {} }
    const all = Object.values(state.duty);
    const found = (args.id && state.duty[args.id])
      || (pane && pane.terminal_id && all.find(d => d.terminalId === pane.terminal_id))
      || (args.paneId && all.find(d => d.paneId === (pane ? pane.pane_id : args.paneId)))
      || (!args.paneId && args.wsId && all.find(d => d.wsId === args.wsId))
      || null;
    return { pane, found };
  }
  const NO_DUTY = 'Для этого окна дежурство не включено. Сначала: herdr-duty start --every 30m';

  const handlers = {
    ping: async () => ({ pid: process.pid, session: paths.sessionName(socketPath), connected, startedAt }),
    view: () => buildView(),
    'category.create': async ({ name }) => {
      const n = cleanName(name);
      if (state.categories.some(c => c.name.toUpperCase() === n.toUpperCase())) throw new Error(`Категория «${n}» уже есть.`);
      state.categories.push({ id: `c${state.nextId++}`, name: n, units: [] });
    },
    'category.rename': async ({ id, name }) => { catById(id).name = cleanName(name); },
    'category.delete': async ({ id }) => { catById(id); state.categories = state.categories.filter(c => c.id !== id); },
    'category.move': async ({ id, toIndex }) => {
      const i = state.categories.findIndex(c => c.id === id);
      if (i < 0) throw new Error('Такой категории нет.');
      const [c] = state.categories.splice(i, 1);
      state.categories.splice(clamp(Number(toIndex) || 0, 0, state.categories.length), 0, c);
    },
    'unit.move': async ({ key, catId, index }) => {
      if (!last.units || !last.units.byKey[key]) throw new Error('Этого проекта уже нет в списке.');
      for (const c of state.categories) c.units = c.units.filter(k => k !== key);
      if (catId && catId !== model.NONE_ID) {
        const c = catById(catId);
        c.units.splice(clamp(index === undefined ? c.units.length : Number(index), 0, c.units.length), 0, key);
      }
    },
    'unit.detach': async ({ wsId, catId }) => ops.detach(herdr, state, { wsId, catId }),
    'unit.reattach': async ({ wsId }) => ops.reattach(herdr, state, { wsId }),
    'duty.start': async args => {
      const everyMs = duty.parseEvery(args.every);
      if (!everyMs) throw new Error(`Не понял интервал «${args.every}». Пример: 30m, 1h, 2ч.`);
      const { pane, found } = await dutyTarget(args);
      if (!pane && !found) throw new Error('Не нашёл окно агента. Команду надо запускать из окна агента в herdr.');
      const now = Date.now();
      let d;
      if (found) {
        d = { ...duty.applyReset(found, now), everyMs, note: args.note || found.note };
      } else {
        const agents = await herdr.listAgents().catch(() => []);
        const ag = agents.find(a => a.terminal_id === pane.terminal_id) || agents.find(a => a.pane_id === pane.pane_id);
        const w = last.snap && last.snap.byId.get(pane.workspace_id);
        d = duty.newDuty({
          id: `d${state.nextId++}`, wsId: pane.workspace_id, label: w ? w.label : '', paneId: pane.pane_id,
          terminalId: pane.terminal_id, agentSession: ag && ag.agent_session ? ag.agent_session.value : null,
          everyMs, note: args.note, source: args.source || 'agent', now,
        });
      }
      state.duty[d.id] = d;
      log('duty start', d.id, d.wsId, duty.fmtDur(everyMs));
      return { id: d.id, wsId: d.wsId, label: d.label, every: duty.fmtDur(everyMs) };
    },
    'duty.ok': async args => {
      const { found } = await dutyTarget(args);
      if (!found) throw new Error(NO_DUTY);
      state.duty[found.id] = duty.applyOk(found, Date.now());
      return { id: found.id };
    },
    'duty.fail': async args => {
      const { found } = await dutyTarget(args);
      if (!found) throw new Error(NO_DUTY);
      state.duty[found.id] = duty.applyFail(found, Date.now(), args.reason);
      return { id: found.id };
    },
    'duty.stop': async args => {
      const { found } = await dutyTarget(args);
      if (!found) throw new Error(NO_DUTY);
      delete state.duty[found.id];
      log('duty stop', found.id);
      return { id: found.id };
    },
    'duty.reset': async args => {
      const { found } = await dutyTarget(args);
      if (!found) throw new Error(NO_DUTY);
      state.duty[found.id] = duty.applyReset(found, Date.now());
      return { id: found.id };
    },
    'duty.status': async () => Object.values(state.duty).map(d => ({
      id: d.id, label: d.label, wsId: d.wsId, every: duty.fmtDur(d.everyMs), token: duty.dutyToken(d), alert: d.alert,
    })),
    uninstall: async () => {
      stopping = true;
      let snap = await snapshot();
      const h = liveHeaders(snap);
      for (const id of h.ids) await closeHeader(snap, id);
      snap = await snapshot();
      const orig = store.loadJson(files.original, null);
      if (orig && Array.isArray(orig.order)) {
        const live = new Set(snap.order);
        const desired = orig.order.filter(id => live.has(id));
        for (const id of snap.order) if (!desired.includes(id)) desired.push(id);
        if (desired.join() !== snap.order.join()) await herdr.moveBlock(desired);
      }
      for (const w of snap.workspaces) {
        const t = w.tokens || {};
        if (t.project != null || t.duty != null) await herdr.setTokens(w.workspace_id, { project: null, duty: null }).catch(() => {});
      }
      const detachedLeft = Object.keys(state.detached).length;
      store.saveJson(path.join(dir, `state.uninstalled-${new Date().toISOString().slice(0, 10)}.json`), state);
      state = store.emptyState();
      save();
      try { fs.unlinkSync(files.original); } catch {}
      log('uninstalled: order restored, headers closed, tokens cleared');
      setTimeout(() => shutdown(0), 300);
      return { restored: !!orig, detachedLeft };
    },
    shutdown: async () => { setTimeout(() => shutdown(0), 100); return { ok: true }; },
  };
  const UNSERIALIZED = new Set(['ping', 'view']);
  const NO_CYCLE = new Set(['duty.status', 'uninstall', 'shutdown']);

  function handle(cmd, args) {
    const fn = handlers[cmd];
    if (!fn) return Promise.reject(new Error(`Неизвестная команда: ${cmd}`));
    if (UNSERIALIZED.has(cmd)) return fn(args);
    return serial(async () => {
      const result = await fn(args);
      if (!NO_CYCLE.has(cmd)) {
        save();
        await cycleInner(cmd).catch(e => log('cycle after', cmd, 'failed', e.message));
      }
      return result === undefined ? { ok: true } : result;
    });
  }

  function shutdown(code) {
    stopping = true;
    if (sub) sub.close();
    if (server) server.close();
    try { save(); } catch {}
    log('helper stopped');
    process.exit(code);
  }

  async function start() {
    fs.mkdirSync(dir, { recursive: true });
    try {
      server = await ipc.serve(paths.daemonPipe(socketPath), handle);
    } catch (e) {
      if (e.code === 'EADDRINUSE') return false; // another helper already serves this session
      throw e;
    }
    log('helper started, pid', process.pid, 'session', paths.sessionName(socketPath));
    connectEvents();
    setInterval(() => cycle('tick'), settings.tickSec * 1000);
    return true;
  }

  return { start, handle, log };
}

if (require.main === module) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const stateRoot = process.env.HERDR_PLUGIN_STATE_DIR;
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!socketPath || !stateRoot || !configDir) {
    process.stderr.write('Помощник запускается из herdr (нет переменных HERDR_*).\n');
    process.exit(2);
  }
  const d = createDaemon({ socketPath, dir: paths.sessionDir(stateRoot, socketPath), configDir });
  process.on('uncaughtException', e => { d.log('crash', e && e.stack); process.exit(1); });
  process.on('unhandledRejection', e => d.log('unhandled', e && (e.stack || e.message || e)));
  d.start().then(ok => { if (!ok) process.exit(0); }, e => { d.log('start failed', e.message); process.exit(1); });
}

module.exports = { createDaemon };
