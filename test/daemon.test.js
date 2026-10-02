'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDaemon } = require('../src/daemon');
const store = require('../src/store');

const MIN = 60000;

function fakeHerdr(workspaces, panes, agents = []) {
  const calls = [];
  let next = 100;
  const h = {
    calls, failAgents: false, failMove: false,
    ping: async () => ({ type: 'pong' }),
    listWorkspaces: async () => JSON.parse(JSON.stringify(workspaces)),
    listPanes: async () => panes.slice(),
    listAgents: async () => { if (h.failAgents) throw new Error('agent.list boom'); return agents; },
    createWorkspace: async (label, cwd) => {
      const id = `w${next++}`;
      workspaces.push({ workspace_id: id, label });
      panes.push({ pane_id: `${id}:p1`, workspace_id: id, cwd });
      calls.push(['create', label]);
      return { workspace_id: id };
    },
    closeWorkspace: async id => {
      calls.push(['close', id]);
      workspaces.splice(workspaces.findIndex(w => w.workspace_id === id), 1);
    },
    renameWorkspace: async (id, label) => { workspaces.find(w => w.workspace_id === id).label = label; },
    moveBlock: async ids => {
      if (h.failMove) throw new Error('move_block boom');
      calls.push(['move', ids.join(',')]);
      const by = new Map(workspaces.map(w => [w.workspace_id, w]));
      workspaces.splice(0, workspaces.length, ...ids.map(id => by.get(id)));
      return ids;
    },
    setTokens: async (id, tokens) => {
      calls.push(['tokens', id, tokens]);
      const w = workspaces.find(x => x.workspace_id === id);
      w.tokens = { ...(w.tokens || {}) };
      for (const [k, v] of Object.entries(tokens)) { if (v == null) delete w.tokens[k]; else w.tokens[k] = v; }
    },
    notify: async (title, body) => { calls.push(['notify', title, body]); },
    panesRef: panes,
    listWorkspacesSync: id => workspaces.find(w => w.workspace_id === id),
    reorder: ids => { const by = new Map(workspaces.map(w => [w.workspace_id, w])); workspaces.splice(0, workspaces.length, ...ids.map(id => by.get(id))); },
  };
  return h;
}

function fakeSubscribe() {
  const s = { last: null };
  s.fn = (_sock, _subs, cbs) => { s.last = cbs; return { close() {} }; };
  return s;
}

function setup({ workspaces, panes, agents, state }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-daemon-'));
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir);
  if (state) store.saveJson(path.join(dir, 'state.json'), { ...store.emptyState(), ...state });
  const herdr = fakeHerdr(workspaces, panes, agents);
  const sub = fakeSubscribe();
  const clock = { t: 1_000_000_000 };
  const telegram = [];
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir, herdr, subscribe: sub.fn, now: () => clock.t,
    sendTelegram: async (_dir, text) => { telegram.push(text); return true; },
  });
  return { d, herdr, sub, clock, dir, telegram, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const plain = (id, label) => ({ workspace_id: id, label });
const pane = (wsId, cwd) => ({ pane_id: `${wsId}:p1`, workspace_id: wsId, cwd });

test('one failing step still publishes tokens and saves the state', async () => {
  const x = setup({
    workspaces: [plain('w1', 'cookie'), plain('w2', 'other')],
    panes: [pane('w1', 'C:/wt/cookie'), pane('w2', 'C:/p/other')],
    state: {
      detached: { w1: { name: 'cookie', checkout: 'C:/wt/cookie', parentLabel: 'autopase' } },
      duty: { d1: { id: 'd1', wsId: 'w2', label: 'other', everyMs: 30 * MIN, lastLifeAt: 0, lastSeq: null, blockedSince: null, missingSince: null, fail: null, alert: null } },
    },
  });
  fs.rmSync(path.join(x.dir, 'state.json'));
  x.herdr.failAgents = true;
  x.d._test.markConnected();
  await x.d._test.cycle('test');
  assert.ok(x.herdr.calls.some(c => c[0] === 'tokens' && c[1] === 'w1' && c[2].project === '⎇ autopase'), 'project token published');
  assert.ok(fs.existsSync(path.join(x.dir, 'state.json')), 'state saved');
  x.cleanup();
});

test('after a gap, a detached record on a reused id is dropped and gets no token', async () => {
  const x = setup({
    workspaces: [plain('w1', 'fix-pc')],
    panes: [pane('w1', 'C:/p/fix-pc')],
    state: { detached: { w1: { name: 'cookie', checkout: 'C:/wt/cookie', parentLabel: 'autopase' } } },
  });
  x.d._test.markConnected();
  await x.d._test.cycle('first');
  assert.deepEqual(x.d._test.state().detached, {});
  assert.ok(!x.herdr.calls.some(c => c[0] === 'tokens'));
  x.cleanup();
});

test('a duty keeps the label of its own agent when the workspace id is reused', async () => {
  const x = setup({
    workspaces: [plain('w5', 'stranger')],
    panes: [pane('w5', 'C:/p/stranger')],
    agents: [],
    state: { duty: { d1: { id: 'd1', wsId: 'w5', label: 'google-ads', paneId: 'w5:p1', terminalId: 't-old', agentSession: 's1', everyMs: 30 * MIN, lastLifeAt: 0, lastSeq: null, blockedSince: null, missingSince: null, fail: null, alert: null } } },
  });
  x.d._test.markConnected();
  await x.d._test.cycle('t');
  assert.equal(x.d._test.state().duty.d1.label, 'google-ads');
  x.cleanup();
});

test('when the event stream drops and herdr answers again, duty grace starts again', async () => {
  const x = setup({ workspaces: [], panes: [] });
  x.d._test.connectEvents();
  x.sub.last.onReady();
  x.clock.t += 60 * MIN;
  x.sub.last.onClose();
  await x.d._test.reconnect();
  assert.equal(x.d._test.startedAt(), x.clock.t);
  x.cleanup();
});

test('a long pause between ticks (machine asleep) starts the duty grace again', async () => {
  const x = setup({ workspaces: [], panes: [] });
  await x.d._test.tick();
  x.clock.t += 30 * 1000;
  await x.d._test.tick();
  const before = x.d._test.startedAt();
  x.clock.t += 20 * MIN;
  await x.d._test.tick();
  assert.notEqual(before, x.clock.t);
  assert.equal(x.d._test.startedAt(), x.clock.t);
  x.cleanup();
});

test('a failed uninstall leaves the helper working and the categories in place', async () => {
  const x = setup({
    workspaces: [plain('w1', 'a'), plain('w2', 'b')],
    panes: [pane('w1', 'C:/p/a'), pane('w2', 'C:/p/b')],
    state: { categories: [{ id: 'c1', name: 'A', units: ['ws:w2'] }] },
  });
  x.d._test.markConnected();
  await x.d._test.cycle('t');
  store.saveJson(path.join(x.dir, 'original.json'), { order: ['w1', 'w2'] });
  x.herdr.failMove = true;
  await assert.rejects(x.d.handle('uninstall', {}), /move_block boom/);
  assert.equal(x.d._test.stopping(), false);
  assert.equal(x.d._test.state().categories.length, 1);
  x.cleanup();
});

test('category titles are drawn as tokens on the first projects; no title workspaces are made', async () => {
  const x = setup({
    workspaces: [plain('w1', 'a'), plain('w2', 'b'), plain('w3', 'c')],
    panes: [pane('w1', 'C:/p/a'), pane('w2', 'C:/p/b'), pane('w3', 'C:/p/c')],
    state: { categories: [{ id: 'c1', name: 'Реклама', units: ['ws:w2'] }] },
  });
  x.d._test.markConnected();
  await x.d._test.cycle('t');
  assert.ok(!x.herdr.calls.some(c => c[0] === 'create'), 'no workspace created');
  assert.deepEqual(x.herdr.calls.find(c => c[0] === 'move'), ['move', 'w2,w1,w3']);
  const tok = id => (x.herdr.listWorkspacesSync(id).tokens || {}).section;
  assert.equal(tok('w2'), '━━ РЕКЛАМА ━━');
  assert.equal(tok('w1'), '━━ БЕЗ КАТЕГОРИИ ━━');
  assert.equal(tok('w3'), undefined);
  x.cleanup();
});

test('title workspaces left by the previous version are closed, foreign look-alikes are not', async () => {
  const x = setup({
    workspaces: [plain('h1', '━━ РЕКЛАМА ━━'), plain('w1', 'a'), plain('f1', '━━ ЧУЖОЕ ━━')],
    panes: [],
    state: { headers: { c1: 'h1' }, categories: [{ id: 'c1', name: 'Реклама', units: ['ws:w1'] }] },
  });
  x.herdr.panesRef.push(pane('h1', path.join(x.dir, 'header')), pane('w1', 'C:/p/a'), pane('f1', 'C:/p/other'));
  x.d._test.markConnected();
  await x.d._test.cycle('t');
  assert.deepEqual(x.herdr.calls.filter(c => c[0] === 'close'), [['close', 'h1']]);
  assert.deepEqual(x.d._test.state().headers, {});
  x.cleanup();
});

test('a drag reported by herdr decides which project moved across a category border', async () => {
  const x = setup({
    workspaces: [plain('w1', 'a'), plain('w6', 'n'), plain('w3', 'c')],
    panes: [pane('w1', 'C:/p/a'), pane('w6', 'C:/p/n'), pane('w3', 'C:/p/c')],
    state: { categories: [{ id: 'cX', name: 'X', units: ['ws:w1', 'ws:w6'] }, { id: 'cY', name: 'Y', units: ['ws:w3'] }] },
  });
  x.d._test.markConnected();
  await x.d._test.cycle('t');
  x.d._test.connectEvents();
  x.herdr.reorder(['w1', 'w3', 'w6']);
  x.sub.last.onEvent({ event: 'workspace_reordered', data: { type: 'workspace_reordered', workspace_ids: ['w3'] } });
  await x.d._test.cycle('t2');
  assert.deepEqual(x.d._test.state().categories.map(c => c.units), [['ws:w1', 'ws:w3', 'ws:w6'], []]);
  x.cleanup();
});

test('uninstall clears the title tokens', async () => {
  const x = setup({
    workspaces: [plain('w1', 'a'), plain('w2', 'b')],
    panes: [pane('w1', 'C:/p/a'), pane('w2', 'C:/p/b')],
    state: { categories: [{ id: 'c1', name: 'A', units: ['ws:w2'] }] },
  });
  x.d._test.markConnected();
  await x.d._test.cycle('t');
  await x.d.handle('uninstall', {});
  for (const id of ['w1', 'w2']) assert.equal((x.herdr.listWorkspacesSync(id).tokens || {}).section, undefined);
  x.cleanup();
});
