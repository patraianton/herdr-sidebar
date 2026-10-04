'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDaemon } = require('../src/daemon');
const cp = require('../src/configpatch');

function setup(workspaces) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stars-'));
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

test('a star is put on and taken off, shows in the sidebar and in the window', async () => {
  const list = [ws('w1', '[WS] Ads'), ws('w2', 'autopase')];
  const x = setup(list);
  await x.d._test.cycle('t');
  const r = await x.d.handle('star.toggle', { wsId: 'w2' });
  assert.deepEqual(r, { starred: true, label: 'autopase', count: 1 });
  assert.equal(starTok(list, 'w2'), '★');
  assert.equal(starTok(list, 'w1'), undefined);
  let v = await x.d.handle('view');
  assert.equal(unitOf(v, 'w2').starred, true);
  assert.equal(unitOf(v, 'w1').starred, false);
  const off = await x.d.handle('star.toggle', { wsId: 'w2' });
  assert.deepEqual(off, { starred: false, label: 'autopase', count: 0 });
  assert.equal(starTok(list, 'w2'), undefined);
  v = await x.d.handle('view');
  assert.equal(unitOf(v, 'w2').starred, false);
  x.cleanup();
});

test('a star follows a rename', async () => {
  const list = [ws('w1', 'a'), ws('w2', 'b')];
  const x = setup(list);
  await x.d._test.cycle('t');
  await x.d.handle('star.toggle', { wsId: 'w1' });
  list[0].label = 'a2';
  await x.d._test.cycle('t2');
  assert.equal(x.d._test.state().stars[0].target.label, 'a2');
  assert.equal(starTok(list, 'w1'), '★');
  x.cleanup();
});

test('starring a workspace that is gone is refused', async () => {
  const x = setup([ws('w1', 'a')]);
  await x.d._test.cycle('t');
  await assert.rejects(x.d.handle('star.toggle', { wsId: 'w9' }), /уже нет/);
  x.cleanup();
});

test('the star keys are not offered as a hotkey', async () => {
  const x = setup([ws('w1', 'a')]);
  await x.d._test.cycle('t');
  await assert.rejects(x.d.handle('hotkey.set', { key: 'alt+backtick', wsId: 'w1' }), /уже занята: переход по звёздочкам/);
  await assert.rejects(x.d.handle('hotkey.set', { key: 'alt+ё', wsId: 'w1' }), /уже занята: переход по звёздочкам/);
  x.cleanup();
});

test('review 2: of two namesakes in one folder the one starred gets the star', async () => {
  const list = [{ ...ws('w1', 'api'), cwd: 'C:/x' }, { ...ws('w2', 'api'), cwd: 'C:/x' }];
  const x = setup(list);
  await x.d._test.cycle('t');
  await x.d.handle('star.toggle', { wsId: 'w2' });
  assert.equal(starTok(list, 'w2'), '★');
  assert.equal(starTok(list, 'w1'), undefined);
  const r = await x.d.handle('star.toggle', { wsId: 'w1' });
  assert.equal(r.starred, true, 'the other one can be starred too');
  x.cleanup();
});
