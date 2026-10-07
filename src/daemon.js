#!/usr/bin/env node
'use strict';
// Background helper, one per herdr session: keeps the Spaces order, publishes
// the $section/$project/$duty/$key/$star tokens, watches duty agents, keeps the jump
// hotkeys in config.toml and serves the window and CLI. Category titles are $section tokens drawn on top of the first project
// of each category; earlier versions used separate title workspaces, which the
// helper now closes.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeHerdr, PLUGIN_ID } = require('./herdr');
const rpc = require('./rpc');
const ipc = require('./ipc');
const paths = require('./paths');
const store = require('./store');
const model = require('./model');
const duty = require('./duty');
const notify = require('./notify');
const ops = require('./ops');
const hotkeys = require('./hotkeys');
const configpatch = require('./configpatch');
const stars = require('./stars');
const userSettings = require('./settings');

const SUBSCRIPTIONS = [
  'workspace.created', 'workspace.closed', 'workspace.moved', 'workspace.reordered', 'workspace.renamed',
  'worktree.created', 'worktree.opened', 'worktree.removed',
].map(type => ({ type }));
const TOKEN_KEYS = ['section', 'project', 'duty', 'key', 'star'];
const NOT_INSTALLED = 'The plugin is not set up in herdr\'s config yet. Run: herdr plugin action invoke setup --plugin anton.sidebar';

// config.toml access for the hotkeys; tests pass their own.
function defaultKeysConfig(configDir) {
  const bin = process.env.HERDR_BIN_PATH || 'herdr';
  const run = (args, env) => spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  let defaults = null;
  return {
    file: () => {
      const inst = store.loadJson(path.join(configDir, 'install.json'), null);
      return inst && inst.configFile && fs.existsSync(inst.configFile) ? inst.configFile : null;
    },
    read: file => fs.readFileSync(file, 'utf8'),
    // whole file at once: a reader never sees half of it
    write: (file, text) => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    },
    backup: file => {
      const b = `${file}.bak-${new Date().toISOString().slice(0, 10)}-sidebar-keys`;
      if (!fs.existsSync(b)) fs.copyFileSync(file, b);
    },
    // herdr's own check: the lines it prints besides the verdict. No verdict
    // means herdr did not run, and then nothing may be written.
    issues: file => {
      const r = run(['config', 'check'], { HERDR_CONFIG_PATH: file });
      const out = `${r.stdout || ''}\n${r.stderr || ''}`;
      if (r.error || !/^config: (ok|issues found)$/m.test(out)) {
        throw new Error(`Could not check herdr settings: ${r.error ? r.error.message : out.trim() || `exit code ${r.status}`}`);
      }
      return out.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^config: (ok|issues found)$/.test(l));
    },
    defaults: () => {
      if (defaults === null) {
        const r = run(['--default-config']);
        if (r.error || r.status !== 0 || !/\[keys\]/.test(r.stdout || '')) throw new Error('Could not read herdr\'s default keys.');
        defaults = r.stdout;
      }
      return defaults;
    },
  };
}

function createDaemon({ socketPath, dir, configDir, herdr: herdrIn, subscribe: subscribeIn, now: clockIn, sendTelegram: sendIn, keysConfig: keysIn }) {
  const herdr = herdrIn || makeHerdr(socketPath);
  const keysConfig = keysIn || defaultKeysConfig(configDir);
  const subscribe = subscribeIn || rpc.subscribe;
  const clock = clockIn || Date.now;
  const sendTelegram = sendIn || notify.sendTelegramWithRetry;
  const files = {
    state: path.join(dir, 'state.json'),
    original: path.join(dir, 'original.json'),
    log: path.join(dir, 'daemon.log'),
    headerDir: path.join(dir, 'header'),
  };
  userSettings.useConfigDir(configDir);
  const settings = { ...duty.DEFAULT_SETTINGS, ...userSettings.settings() };
  let state = store.loadState(files.state);
  let startedAt = clock();
  let chain = Promise.resolve();
  const last = { snap: null, units: null, sections: {} };
  let dragHints = []; // workspace ids herdr reported as moved by a reorder since the last cycle
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
  let lastTickAt = 0;
  let continuityBroken = true; // first cycle after start or after herdr came back

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

  // Title workspaces made by the previous version are not needed any more.
  async function closeOldHeaders(snap, h) {
    let changed = false;
    for (const wsId of h.ids) {
      if (await closeHeader(snap, wsId)) { log('old title workspace closed', wsId); changed = true; }
    }
    return changed;
  }

  function allowMove() {
    const now = clock();
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
    const now = clock();
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
    if (continuityBroken) {
      for (const id of model.staleDetached(state.detached, snap.workspaces, snap.paths)) {
        log('detached record dropped: the workspace id now belongs to another workspace', id);
        delete state.detached[id];
      }
    }
    let h = liveHeaders(snap);
    if (h.ids.size && await closeOldHeaders(snap, h)) { snap = await snapshot(); h = liveHeaders(snap); }
    for (const [cid, wsId] of Object.entries(state.headers)) if (!snap.byId.has(wsId)) delete state.headers[cid];
    const units = model.buildUnits(snap.workspaces, snap.paths, h.ids); // a title that would not close is not a project
    state = model.reconcile(state, units, now, { continuous: !continuityBroken });
    // A drag in the sidebar moves one project (or one worktree group); the
    // helper's own reorders move many, so they are not hints.
    const hints = dragHints.filter(ids => new Set(ids.map(id => units.unitOf[id])).size === 1).flat();
    dragHints = [];
    const learned = model.learnFromOrder(state, units, snap.order, hints);
    if (learned.moved.length) {
      log('moved by hand:', learned.moved.join(' '));
      state = learned.state;
    }
    const desired = now < pauseUntil ? null : model.desiredOrder(state, units, snap.order);
    if (desired && desired.join() !== snap.order.join() && allowMove()) {
      try {
        state.lastApplied = (await herdr.moveBlock(desired)) || desired;
        failCount = 0;
        log('order applied', reason);
      } catch (e) {
        state.lastApplied = snap.order;
        failCount++;
        log('move_block failed', e.message);
        if (failCount >= 3) { pauseUntil = clock() + 5 * 60000; failCount = 0; log('order paused for 5 minutes'); }
      }
    } else {
      state.lastApplied = snap.order;
    }
    const rk = hotkeys.refreshTargets(state.hotkeys || [], snap.workspaces, snap.paths, !continuityBroken);
    if (rk.changed) { state.hotkeys = rk.hotkeys; log('hotkey targets followed a rename or a new id'); }
    const tabWs = [...new Set(state.hotkeys.filter(k => k.target.tabId).map(k => k.target.wsId))];
    if (tabWs.length) {
      const tabsByWs = {};
      for (const id of tabWs) { try { tabsByWs[id] = await herdr.listTabs(id); } catch {} }
      const rt = hotkeys.refreshTabs(state.hotkeys, tabsByWs, !continuityBroken);
      if (rt.changed) { state.hotkeys = rt.hotkeys; log('hotkey tabs followed a rename or a new id'); }
    }
    const rs = hotkeys.refreshTargets(state.stars || [], snap.workspaces, snap.paths, !continuityBroken);
    if (rs.changed) { state.stars = rs.hotkeys; log('stars followed a rename or a new id'); }
    last.snap = snap;
    last.units = units;
    last.sections = model.sectionTokens(state, units, state.lastApplied);
    continuityBroken = false;
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
    for (const [wsId, title] of Object.entries(last.sections)) put(wsId, 'section', title);
    for (const [wsId, d] of Object.entries(state.detached)) put(wsId, 'project', `⎇ ${d.parentLabel}`);
    for (const d of Object.values(state.duty)) if (d.wsId) put(d.wsId, 'duty', duty.dutyToken(d, clock()));
    for (const [wsId, list] of keysByWs()) put(wsId, 'key', list.map(k => k.display).join(' '));
    for (const [wsId, kind] of starKinds(snap)) put(wsId, 'star', stars.token(kind));
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
    const body = event === 'alert' ? d.alert.text : 'working again';
    log('duty', event, label, body);
    herdr.notify(`Duty: ${label}`, body).catch(e => log('toast failed', e.message));
    const text = event === 'alert' ? duty.alertText(label, d) : duty.recoverText(label);
    sendTelegram(configDir, text, { log })
      .then(r => log('telegram', r === null ? 'not set up' : (r ? 'sent' : 'failed')));
  }

  async function checkDuty(snap) {
    const ids = Object.keys(state.duty);
    if (!ids.length) return;
    const agents = await herdr.listAgents();
    const now = clock();
    for (const id of ids) {
      const prev = state.duty[id];
      const agent = duty.locateAgent(prev, agents);
      const { duty: d, event } = duty.evaluate(prev, agent, now, settings, startedAt);
      const w = snap.byId.get(d.wsId);
      if (agent && w) d.label = w.label; // a vanished agent's workspace id may now belong to someone else
      state.duty[id] = d;
      if (event) signal(event, d);
    }
  }

  async function cycleInner(reason) {
    if (!connected || stopping) return;
    try {
      const snap = await syncOrder(reason);
      try { await checkDuty(snap); } catch (e) { log('duty check failed', e.message); }
      await publishTokens(snap);
    } finally {
      save();
    }
  }
  const cycle = reason => serial(() => cycleInner(reason)).catch(e => log('cycle failed', reason, e.message));
  function kick(reason, delayMs) {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => cycle(reason), delayMs);
    if (kickTimer.unref) kickTimer.unref();
  }

  function tick() {
    const t = clock();
    if (lastTickAt && t - lastTickAt > 3 * settings.tickSec * 1000) {
      startedAt = t;
      log('long pause between checks (computer asleep?); duty grace starts again');
    }
    lastTickAt = t;
    return cycle('tick');
  }

  function noteDrag(msg) {
    const d = msg && msg.data;
    if (!d) return;
    const kind = String(msg.event || d.type || '').replace('.', '_');
    if (kind === 'workspace_reordered' && Array.isArray(d.workspace_ids) && d.workspace_ids.length) dragHints.push(d.workspace_ids);
    else if (kind === 'workspace_moved' && d.workspace_id) dragHints.push([d.workspace_id]);
    if (dragHints.length > 50) dragHints.shift();
  }

  function connectEvents() {
    if (stopping) return;
    sub = subscribe(socketPath, SUBSCRIPTIONS, {
      onReady: () => { connected = true; lostSince = null; log('connected to herdr'); kick('connect', 0); },
      onEvent: msg => { noteDrag(msg); kick('event', 1000); },
      onClose: err => {
        const wasConnected = connected;
        connected = false;
        sub = null;
        if (wasConnected) serverWasDown = true; // herdr may have restarted: agents come back late
        if (stopping) return;
        log('event stream closed', err ? err.message : '');
        lostSince = lostSince || clock();
        const t = setTimeout(reconnect, 2000);
        if (t.unref) t.unref();
      },
    });
  }

  async function reconnect() {
    if (stopping) return;
    try {
      await herdr.ping();
    } catch {
      serverWasDown = true;
      if (clock() - lostSince > 10 * 60000) { log('herdr is gone for 10 minutes; exiting'); shutdown(0); return; }
      const t = setTimeout(reconnect, 5000);
      if (t.unref) t.unref();
      return;
    }
    if (serverWasDown) {
      startedAt = clock();
      serverWasDown = false;
      continuityBroken = true;
      log('herdr is back; duty grace starts again');
    }
    connectEvents();
  }

  // ---- commands from the window and the CLI ----

  const cleanName = name => {
    const n = String(name || '').replace(/[\r\n\t]+/g, ' ').replace(/━/g, '').trim().slice(0, 40);
    if (!n) throw new Error('The name is empty.');
    return n;
  };
  const catById = id => {
    const c = state.categories.find(x => x.id === id);
    if (!c) throw new Error('No such category.');
    return c;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function keysByWs() {
    const by = new Map();
    const rank = h => { const i = hotkeys.CHOICES.indexOf(h.key); return i < 0 ? 100 + h.slot : i; };
    for (const h of [...(state.hotkeys || [])].sort((a, b) => rank(a) - rank(b))) {
      if (!by.has(h.target.wsId)) by.set(h.target.wsId, []);
      by.get(h.target.wsId).push({ key: h.key, display: hotkeys.displayKey(h.key), tabLabel: h.target.tabLabel || null });
    }
    return by;
  }

  const starKinds = snap => stars.starKinds(state.stars, snap.workspaces, snap.paths);

  // 1…4, or 0 (no star) where taking the star off is allowed.
  function starKind(kind, zeroOk) {
    const k = Number(kind) || 0;
    if ((k || !zeroOk) && !stars.KINDS.some(x => x.kind === k)) throw new Error(`No such star: ${kind}.`);
    return k;
  }

  // One star per workspace: the new kind replaces the old one, 0 takes it off.
  function setStar(snap, wsId, k) {
    const w = snap.byId.get(wsId);
    if (!w) throw new Error('This workspace is gone.');
    const list = state.stars || [];
    const others = list.filter(s => (hotkeys.findWorkspace(s.target, snap.workspaces, snap.paths) || {}).workspace_id !== wsId);
    state.stars = k ? [...others, { kind: k, target: { wsId, label: w.label, path: hotkeys.wsPath(w, snap.paths) } }] : others;
    log('star', k, wsId);
    return { kind: k, label: w.label };
  }

  const usedElsewhere = () => {
    const file = keysConfig.file();
    if (!file) throw new Error(NOT_INSTALLED);
    const used = hotkeys.usedKeys(keysConfig.read(file), keysConfig.defaults(), configpatch.KEYS_BEGIN, configpatch.KEYS_END);
    used.set(hotkeys.normKey(configpatch.OPEN_KEY), 'the Sidebar Organizer window');
    stars.KINDS.forEach((k, i) => {
      used.set(hotkeys.normKey(configpatch.STAR_KEYS[i]), `stars ${k.kind} "${k.name}"`);
      used.set(hotkeys.normKey(configpatch.TOGGLE_KEYS[i]), `star ${k.kind}: put on or take off`);
    });
    used.set(hotkeys.normKey(configpatch.RESET_KEY), 'stars: take all off or bring back');
    return used;
  };

  // Other agents edit config.toml too, so the file is read again right before
  // each write and only our block is replaced in what is there at that moment.
  function putKeysBlock(file, list) {
    const text = keysConfig.read(file);
    let next;
    try { next = configpatch.setKeysBlock(text, hotkeys.bindingLines(list, PLUGIN_ID)); } catch { throw new Error(NOT_INSTALLED); }
    if (next !== text) keysConfig.write(file, next);
    return next !== text;
  }

  // Rewrite our bindings in config.toml; if herdr finds a new problem there,
  // put our old bindings back and refuse. Returns whether herdr re-read it.
  async function writeKeys(list) {
    const file = keysConfig.file();
    if (!file) throw new Error(NOT_INSTALLED);
    const was = new Set(keysConfig.issues(file).map(hotkeys.issueKey));
    keysConfig.backup(file);
    if (!putKeysBlock(file, list)) return true;
    const fresh = keysConfig.issues(file).filter(l => !was.has(hotkeys.issueKey(l)));
    if (fresh.length) {
      putKeysBlock(file, state.hotkeys || []);
      throw new Error(`herdr did not accept the key, settings untouched: ${fresh.join('; ')}`);
    }
    try { await herdr.reloadConfig(); return true; } catch (e) { log('reload_config failed', e.message); return false; }
  }

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
      id: d.id, paneId: d.paneId, text: duty.dutyToken(d, clock()), alert: !!d.alert, everyMs: d.everyMs,
    }));
    const keys = keysByWs();
    const keysOf = wsId => keys.get(wsId) || [];
    const kinds = starKinds(last.snap);
    const starOf = wsId => kinds.get(wsId) || 0;
    const unitView = u => ({
      key: u.key, kind: u.kind, label: u.label, anchorId: u.anchorId, wsIds: u.wsIds, linked: !!u.linked,
      detached: state.detached[u.anchorId] ? { parentLabel: state.detached[u.anchorId].parentLabel } : null,
      duty: dutyOf(u.anchorId), agents: agentsOf(u.anchorId), keys: keysOf(u.anchorId), star: starOf(u.anchorId),
      children: u.children.map(ch => ({
        wsId: ch.wsId, label: ch.label, duty: dutyOf(ch.wsId), agents: agentsOf(ch.wsId), keys: keysOf(ch.wsId),
        star: starOf(ch.wsId),
      })),
    });
    const assigned = new Set();
    const categories = state.categories.map(c => ({
      id: c.id, name: c.name,
      units: c.units.filter(k => units.byKey[k]).map(k => { assigned.add(k); return unitView(units.byKey[k]); }),
    }));
    categories.push({ id: model.NONE_ID, name: 'NO CATEGORY', units: units.units.filter(u => !assigned.has(u.key)).map(unitView) });
    return { ready: true, session: paths.sessionName(socketPath), categories, starNames: stars.KINDS.map(k => k.name) };
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
  const NO_DUTY = 'Duty is not on for this pane. First: herdr-duty start --every 30m';

  const handlers = {
    ping: async () => ({ pid: process.pid, session: paths.sessionName(socketPath), connected, startedAt }),
    view: () => buildView(),
    'category.create': async ({ name }) => {
      const n = cleanName(name);
      if (state.categories.some(c => c.name.toUpperCase() === n.toUpperCase())) throw new Error(`Category "${n}" already exists.`);
      state.categories.push({ id: `c${state.nextId++}`, name: n, units: [] });
    },
    'category.rename': async ({ id, name }) => { catById(id).name = cleanName(name); },
    'category.delete': async ({ id }) => { catById(id); state.categories = state.categories.filter(c => c.id !== id); },
    'category.move': async ({ id, toIndex }) => {
      const i = state.categories.findIndex(c => c.id === id);
      if (i < 0) throw new Error('No such category.');
      const [c] = state.categories.splice(i, 1);
      state.categories.splice(clamp(Number(toIndex) || 0, 0, state.categories.length), 0, c);
    },
    'unit.move': async ({ key, catId, index }) => {
      if (!last.units || !last.units.byKey[key]) throw new Error('This project is not in the list any more.');
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
      if (!everyMs) throw new Error(`Cannot read the interval "${args.every}". Examples: 30m, 1h, 90.`);
      const { pane, found } = await dutyTarget(args);
      if (!pane && !found) throw new Error('Cannot find the agent pane. Run the command from the agent\'s pane in herdr.');
      const now = clock();
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
      state.duty[found.id] = duty.applyOk(found, clock());
      return { id: found.id };
    },
    'duty.fail': async args => {
      const { found } = await dutyTarget(args);
      if (!found) throw new Error(NO_DUTY);
      state.duty[found.id] = duty.applyFail(found, clock(), args.reason);
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
      state.duty[found.id] = duty.applyReset(found, clock());
      return { id: found.id };
    },
    // What the window offers for one workspace: the free keys (ours show what
    // they jump to now), its tabs, and the keys it already has.
    'hotkey.menu': async ({ wsId }) => {
      const used = usedElsewhere();
      const mine = state.hotkeys || [];
      const choices = hotkeys.CHOICES.filter(k => !used.has(k)).map(k => {
        const h = mine.find(x => x.key === k);
        return { key: k, display: hotkeys.displayKey(k), owner: h ? hotkeys.targetText(h.target) : null };
      });
      let tabs = [];
      try { tabs = (await herdr.listTabs(wsId)).map(t => ({ tabId: t.tab_id, label: t.label || '' })); } catch {}
      return { choices, tabs, current: keysByWs().get(wsId) || [] };
    },
    'hotkey.set': async ({ key, wsId, tabId }) => {
      const k = hotkeys.normKey(key);
      if (!k) throw new Error(`"${key}" will not do. Examples: alt+1, f5, ctrl+alt+k, prefix+alt+1`);
      const show = hotkeys.displayKey(k);
      const used = usedElsewhere();
      if (used.has(k)) throw new Error(`${show} is taken: ${used.get(k)}`);
      const snap = last.snap || await snapshot();
      const w = snap.byId.get(wsId);
      if (!w) throw new Error('This workspace is gone.');
      let target = { wsId, label: w.label, path: hotkeys.wsPath(w, snap.paths) };
      if (tabId) {
        const t = (await herdr.listTabs(wsId)).find(x => x.tab_id === tabId);
        if (!t) throw new Error('This tab is gone.');
        target = { ...target, tabId, tabLabel: t.label || '' };
      }
      const prev = state.hotkeys || [];
      const sameTarget = h => h.target.wsId === wsId && (h.target.tabId || null) === (tabId || null);
      const was = prev.find(h => h.key === k);
      const old = prev.find(h => h.key !== k && sameTarget(h));
      const others = prev.filter(h => h.key !== k && !sameTarget(h));
      const slot = (was && was.slot) || (old && old.slot) || hotkeys.nextSlot(others);
      if (!slot) throw new Error(`No more than ${hotkeys.MAX_SLOTS} keys: remove one first.`);
      const next = [...others, { slot, key: k, target }];
      const reloaded = await writeKeys(next);
      state.hotkeys = next;
      log('hotkey', k, '->', wsId, tabId || '');
      return {
        display: show, label: hotkeys.targetText(target), reloaded,
        takenFrom: was && !sameTarget(was) ? hotkeys.targetText(was.target) : null,
        replaced: old ? hotkeys.displayKey(old.key) : null,
      };
    },
    'hotkey.clear': async ({ key }) => {
      const k = hotkeys.normKey(key);
      const prev = state.hotkeys || [];
      if (!prev.some(h => h.key === k)) throw new Error('This key is not bound.');
      const next = prev.filter(h => h.key !== k);
      const reloaded = await writeKeys(next);
      state.hotkeys = next;
      log('hotkey cleared', k);
      return { reloaded };
    },
    // A star of kind 1…4 marks an important workspace; Alt+N walks through
    // the workspaces of kind N. Kind 0 takes the star off.
    'star.set': async ({ wsId, kind }) => setStar(last.snap || await snapshot(), wsId, starKind(kind, true)),
    // F1…F4: the star of that kind on the workspace focused right now, or off if it is already there.
    'star.toggle': async ({ kind }) => {
      const k = starKind(kind, false);
      const snap = await snapshot();
      const w = snap.workspaces.find(x => x.focused);
      if (!w) throw new Error('No workspace is focused.');
      return setStar(snap, w.workspace_id, starKinds(snap).get(w.workspace_id) === k ? 0 : k);
    },
    // Alt+0: every star off, closed projects included, kept aside; pressed
    // again while there are no stars, the ones kept aside come back.
    'star.reset': async () => {
      const list = state.stars || [];
      if (list.length) {
        state.starsUndo = list;
        state.stars = [];
        log('stars reset', list.length);
        return { cleared: list.length };
      }
      const back = state.starsUndo || [];
      if (!back.length) return {};
      state.stars = back;
      state.starsUndo = [];
      log('stars restored', back.length);
      return { restored: back.length };
    },
    // Name a kind of star in settings.json; an empty name brings the default back.
    'star.rename': async ({ kind, name }) => {
      const k = starKind(kind, false);
      const file = path.join(configDir, 'settings.json');
      const s = store.loadJson(file, {}) || {};
      const names = stars.KINDS.map((x, i) => (Array.isArray(s.starNames) && s.starNames[i]) || '');
      names[k - 1] = String(name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30);
      store.saveJson(file, { ...s, starNames: names });
      userSettings.useConfigDir(configDir);
      log('star kind renamed', k);
      return { kind: k, name: stars.KINDS[k - 1].name };
    },
    'duty.status': async () => Object.values(state.duty).map(d => ({
      id: d.id, label: d.label, wsId: d.wsId, every: duty.fmtDur(d.everyMs), token: duty.dutyToken(d, clock()), alert: d.alert,
    })),
    uninstall: async () => {
      stopping = true;
      let detachedLeft = 0;
      let orig = null;
      try {
        let snap = await snapshot();
        const h = liveHeaders(snap);
        for (const id of h.ids) await closeHeader(snap, id);
        snap = await snapshot();
        orig = store.loadJson(files.original, null);
        if (orig && Array.isArray(orig.order)) {
          const live = new Set(snap.order);
          const desired = orig.order.filter(id => live.has(id));
          for (const id of snap.order) if (!desired.includes(id)) desired.push(id);
          if (desired.join() !== snap.order.join()) await herdr.moveBlock(desired);
        }
        for (const w of snap.workspaces) {
          const t = w.tokens || {};
          if (TOKEN_KEYS.some(k => t[k] != null)) await herdr.setTokens(w.workspace_id, Object.fromEntries(TOKEN_KEYS.map(k => [k, null]))).catch(() => {});
        }
        detachedLeft = Object.keys(state.detached).length;
        store.saveJson(path.join(dir, `state.uninstalled-${new Date().toISOString().slice(0, 10)}.json`), state);
        state = store.emptyState();
        save();
        try { fs.unlinkSync(files.original); } catch {}
        log('uninstalled: order restored, old title workspaces closed, tokens cleared');
      } catch (e) {
        stopping = false;
        log('uninstall failed', e.message);
        throw new Error(`Uninstall failed: ${e.message}. The plugin keeps working, nothing is switched off.`);
      }
      setTimeout(() => shutdown(0), 300);
      return { restored: !!orig, detachedLeft };
    },
    shutdown: async () => { setTimeout(() => shutdown(0), 100); return { ok: true }; },
  };
  const UNSERIALIZED = new Set(['ping', 'view']);
  const NO_CYCLE = new Set(['duty.status', 'hotkey.menu', 'star.rename', 'uninstall', 'shutdown']);

  function handle(cmd, args) {
    const fn = handlers[cmd];
    if (!fn) return Promise.reject(new Error(`Unknown command: ${cmd}`));
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
    setInterval(tick, settings.tickSec * 1000);
    return true;
  }

  return {
    start, handle, log,
    _test: {
      markConnected: () => { connected = true; },
      cycle: reason => serial(() => cycleInner(reason)),
      connectEvents, reconnect, tick,
      state: () => state, startedAt: () => startedAt, stopping: () => stopping,
    },
  };
}

if (require.main === module) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const stateRoot = process.env.HERDR_PLUGIN_STATE_DIR;
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!socketPath || !stateRoot || !configDir) {
    process.stderr.write('The helper is started by herdr (HERDR_* variables are not set).\n');
    process.exit(2);
  }
  if (paths.helperOff(stateRoot, socketPath)) process.exit(0);
  const d = createDaemon({ socketPath, dir: paths.sessionDir(stateRoot, socketPath), configDir });
  process.on('uncaughtException', e => { d.log('crash', e && e.stack); process.exit(1); });
  process.on('unhandledRejection', e => d.log('unhandled', e && (e.stack || e.message || e)));
  d.start().then(ok => { if (!ok) process.exit(0); }, e => { d.log('start failed', e.message); process.exit(1); });
}

module.exports = { createDaemon, _defaultKeysConfig: defaultKeysConfig };
