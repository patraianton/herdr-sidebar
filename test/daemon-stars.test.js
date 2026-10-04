'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDaemon } = require('../src/daemon');
const cp = require('../src/configpatch');
const store = require('../src/store');

function setup(workspaces, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stars-'));
  if (state) store.saveJson(path.join(dir, 'state.json'), { ...store.emptyState(), ...state });
  const herdr = {
    ping: async () => ({}),
    listWorkspaces: async () => JSON.parse(JSON.stringify(workspaces)),
    listPanes: async () => workspaces.map(w => ({ pane_id: `${w.workspace_id}:p1`, workspace_id: w.workspace_id, cwd: w.cwd || `C:/p/${w.workspace_id}` })),
    listAgents: async () => [],
    listTabs: async () => [],
    moveBlock: async ids => ids,
    setTokens: async (id, tokens) => {
      const w = workspaces.find(x => x.workspace_id === id);
      w.tokens = { ...(w.tokens || {}) };
      for (const [k, v] of Object.entries(tokens)) { if (v == null) delete w.tokens[k]; else w.tokens[k] = v; }
    },
    reloadConfig: async () => {},
    notify: async () => {},
  };
  const text = cp.patchConfig('').text;
  const keysConfig = {
    file: () => 'C:/fake/config.toml', read: () => text, write: () => {}, backup: () => {}, issues: () => [], defaults: () => '[keys]\n',
  };
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir: path.join(dir, 'config'), herdr, keysConfig,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
  });
  d._test.markConnected();
  return { d, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ws = (id, label) => ({ workspace_id: id, label });
const starTok = (list, id) => (list.find(w => w.workspace_id === id).tokens || {}).star;
const unitOf = (view, id) => view.categories.flatMap(c => c.units).find(u => u.anchorId === id);

test('a star of a kind is put on, changed and taken off; it shows in the sidebar and in the window', async () => {
  const list = [ws('w1', '[WS] Ads'), ws('w2', 'autopase')];
  const x = setup(list);
  await x.d._test.cycle('t');
  assert.deepEqual(await x.d.handle('star.set', { wsId: 'w2', kind: 1 }), { kind: 1, label: 'autopase' });
  assert.equal(starTok(list, 'w2'), '★1');
  assert.equal(starTok(list, 'w1'), undefined);
  let v = await x.d.handle('view');
  assert.equal(unitOf(v, 'w2').star, 1);
  assert.equal(unitOf(v, 'w1').star, 0);
  await x.d.handle('star.set', { wsId: 'w2', kind: 3 });
  assert.equal(starTok(list, 'w2'), '★3');
  assert.equal(x.d._test.state().stars.length, 1, 'one star per workspace');
  assert.deepEqual(await x.d.handle('star.set', { wsId: 'w2', kind: 0 }), { kind: 0, label: 'autopase' });
  assert.equal(starTok(list, 'w2'), undefined);
  v = await x.d.handle('view');
  assert.equal(unitOf(v, 'w2').star, 0);
  x.cleanup();
});

test('a star saved before kinds existed counts as «my project»', async () => {
  const list = [ws('w1', 'a')];
  const x = setup(list, { stars: [{ target: { wsId: 'w1', label: 'a', path: 'c:/p/w1' } }] });
  await x.d._test.cycle('t');
  assert.equal(starTok(list, 'w1'), '★1');
  x.cleanup();
});

test('a star follows a rename', async () => {
  const list = [ws('w1', 'a'), ws('w2', 'b')];
  const x = setup(list);
  await x.d._test.cycle('t');
  await x.d.handle('star.set', { wsId: 'w1', kind: 2 });
  list[0].label = 'a2';
  await x.d._test.cycle('t2');
  assert.equal(x.d._test.state().stars[0].target.label, 'a2');
  assert.equal(x.d._test.state().stars[0].kind, 2);
  assert.equal(starTok(list, 'w1'), '★2');
  x.cleanup();
});

test('a workspace that is gone or a kind that does not exist is refused', async () => {
  const x = setup([ws('w1', 'a')]);
  await x.d._test.cycle('t');
  await assert.rejects(x.d.handle('star.set', { wsId: 'w9', kind: 1 }), /уже нет/);
  await assert.rejects(x.d.handle('star.set', { wsId: 'w1', kind: 5 }), /вида/);
  x.cleanup();
});

test('Alt+1…Alt+4 are not offered as a hotkey', async () => {
  const x = setup([ws('w1', 'a')]);
  await x.d._test.cycle('t');
  for (const k of ['alt+1', 'alt+4']) {
    await assert.rejects(x.d.handle('hotkey.set', { key: k, wsId: 'w1' }), /уже занята: звёздочки/);
  }
  const menu = await x.d.handle('hotkey.menu', { wsId: 'w1' });
  assert.ok(!menu.choices.some(c => ['alt+1', 'alt+2', 'alt+3', 'alt+4'].includes(c.key)));
  assert.ok(menu.choices.some(c => c.key === 'alt+5'));
  x.cleanup();
});

test('review 2: of two namesakes in one folder the one starred gets the star', async () => {
  const list = [{ ...ws('w1', 'api'), cwd: 'C:/x' }, { ...ws('w2', 'api'), cwd: 'C:/x' }];
  const x = setup(list);
  await x.d._test.cycle('t');
  await x.d.handle('star.set', { wsId: 'w2', kind: 1 });
  assert.equal(starTok(list, 'w2'), '★1');
  assert.equal(starTok(list, 'w1'), undefined);
  await x.d.handle('star.set', { wsId: 'w1', kind: 2 });
  assert.equal(starTok(list, 'w1'), '★2');
  assert.equal(starTok(list, 'w2'), '★1');
  x.cleanup();
});

test('F1…F4: the key puts its star on the focused workspace, a second press takes it off', async () => {
  const list = [ws('w1', 'a'), { ...ws('w2', 'b'), focused: true }, ws('w3', 'c')];
  const x = setup(list);
  await x.d._test.cycle('t');
  assert.deepEqual(await x.d.handle('star.toggle', { kind: 2 }), { kind: 2, label: 'b' });
  assert.equal(starTok(list, 'w2'), '★2');
  assert.deepEqual(await x.d.handle('star.toggle', { kind: 3 }), { kind: 3, label: 'b' }, 'another kind replaces it');
  assert.equal(starTok(list, 'w2'), '★3');
  assert.deepEqual(await x.d.handle('star.toggle', { kind: 3 }), { kind: 0, label: 'b' });
  assert.equal(starTok(list, 'w2'), undefined);
  list[1].focused = false; list[2].focused = true;
  await x.d.handle('star.toggle', { kind: 1 });
  assert.equal(starTok(list, 'w3'), '★1', 'follows the focus herdr reports now, not the last cycle');
  x.cleanup();
});

test('F1…F4 with nothing focused or a kind that does not exist is refused', async () => {
  const x = setup([ws('w1', 'a')]);
  await x.d._test.cycle('t');
  await assert.rejects(x.d.handle('star.toggle', { kind: 1 }), /не выбрано/);
  await assert.rejects(x.d.handle('star.toggle', { kind: 7 }), /вида/);
  x.cleanup();
});

test('F1…F4 are not offered as a hotkey', async () => {
  const x = setup([ws('w1', 'a')]);
  await x.d._test.cycle('t');
  await assert.rejects(x.d.handle('hotkey.set', { key: 'f2', wsId: 'w1' }), /уже занята: звёздочка 2/);
  const menu = await x.d.handle('hotkey.menu', { wsId: 'w1' });
  assert.ok(!menu.choices.some(c => ['f1', 'f2', 'f3', 'f4'].includes(c.key)));
  assert.ok(menu.choices.some(c => c.key === 'f5'));
  x.cleanup();
});
