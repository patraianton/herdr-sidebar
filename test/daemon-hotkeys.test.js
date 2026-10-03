'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDaemon } = require('../src/daemon');
const store = require('../src/store');
const cp = require('../src/configpatch');

const BASE = cp.patchConfig('[[keys.command]]\nkey = "f7"\ntype = "plugin_action"\ncommand = "annotate.capture"\ndescription = "annotate text"\n').text;

function setup({ workspaces, tabs = [], state, issuesAfter }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-keys-'));
  if (state) store.saveJson(path.join(dir, 'state.json'), { ...store.emptyState(), ...state });
  const calls = [];
  const herdr = {
    ping: async () => ({}),
    listWorkspaces: async () => JSON.parse(JSON.stringify(workspaces)),
    listPanes: async () => workspaces.map(w => ({ pane_id: `${w.workspace_id}:p1`, workspace_id: w.workspace_id, cwd: `C:/p/${w.workspace_id}` })),
    listAgents: async () => [],
    listTabs: async wsId => tabs.filter(t => t.workspace_id === wsId),
    moveBlock: async ids => ids,
    setTokens: async (id, tokens) => {
      calls.push(['tokens', id, tokens]);
      const w = workspaces.find(x => x.workspace_id === id);
      w.tokens = { ...(w.tokens || {}) };
      for (const [k, v] of Object.entries(tokens)) { if (v == null) delete w.tokens[k]; else w.tokens[k] = v; }
    },
    reloadConfig: async () => { calls.push(['reload']); },
    notify: async () => {},
  };
  const cfg = { text: BASE, file: 'C:/fake/config.toml', installed: true, writes: 0, backups: 0 };
  const keysConfig = {
    file: () => (cfg.installed ? cfg.file : null),
    read: () => cfg.text,
    write: (_f, t) => { cfg.text = t; cfg.writes++; },
    backup: () => { cfg.backups++; },
    issues: () => (issuesAfter && cfg.text.includes(issuesAfter.when) ? [issuesAfter.line] : []),
    defaults: () => '[keys]\n# new_tab = "prefix+c"\n',
  };
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir: path.join(dir, 'config'), herdr, keysConfig,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
  });
  d._test.markConnected();
  return { d, herdr, calls, cfg, workspaces, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ws = (id, label) => ({ workspace_id: id, label });
const keyTok = (x, id) => (x.workspaces.find(w => w.workspace_id === id).tokens || {}).key;

test('assigning a key writes a binding to a jump action, reloads herdr and shows the key on the row', async () => {
  const x = setup({ workspaces: [ws('w1', '[WS] Ads'), ws('w2', 'autopase')] });
  await x.d._test.cycle('t');
  const r = await x.d.handle('hotkey.set', { key: 'Alt+1', wsId: 'w1' });
  assert.equal(r.display, 'Alt+1');
  assert.equal(r.label, '[WS] Ads');
  assert.ok(x.cfg.text.includes('key = "alt+1"\ntype = "plugin_action"\ncommand = "anton.sidebar.jump-1"'));
  assert.ok(x.cfg.text.includes('description = "прыжок: [WS] Ads"'));
  assert.ok(x.cfg.text.includes('annotate.capture'), 'other bindings stay');
  assert.ok(x.calls.some(c => c[0] === 'reload'));
  assert.equal(x.cfg.backups, 1);
  assert.equal(keyTok(x, 'w1'), 'Alt+1');
  assert.equal(keyTok(x, 'w2'), undefined);
  const view = await x.d.handle('view', {});
  const unit = view.categories.flatMap(c => c.units).find(u => u.anchorId === 'w1');
  assert.deepEqual(unit.keys, [{ key: 'alt+1', display: 'Alt+1', tabLabel: null }]);
  x.cleanup();
});

test('a key taken by another plugin or by herdr is refused and not offered', async () => {
  const x = setup({ workspaces: [ws('w1', 'a')] });
  await x.d._test.cycle('t');
  await assert.rejects(x.d.handle('hotkey.set', { key: 'f7', wsId: 'w1' }), /F7 уже занята: «annotate text»/);
  await assert.rejects(x.d.handle('hotkey.set', { key: 'prefix+c', wsId: 'w1' }), /herdr: new_tab/);
  await assert.rejects(x.d.handle('hotkey.set', { key: 'k', wsId: 'w1' }), /не годится/);
  const m = await x.d.handle('hotkey.menu', { wsId: 'w1' });
  assert.ok(!m.choices.some(c => c.key === 'f7'));
  assert.equal(m.choices.length, 20);
  assert.equal(x.cfg.writes, 0);
  x.cleanup();
});

test('moving a key to another project keeps its slot; a new key for the same project replaces the old one', async () => {
  const x = setup({ workspaces: [ws('w1', 'a'), ws('w2', 'b')] });
  await x.d._test.cycle('t');
  await x.d.handle('hotkey.set', { key: 'alt+1', wsId: 'w1' });
  await x.d.handle('hotkey.set', { key: 'alt+2', wsId: 'w2' });
  const moved = await x.d.handle('hotkey.set', { key: 'alt+2', wsId: 'w1' });
  assert.equal(moved.takenFrom, 'b');
  assert.equal(moved.replaced, 'Alt+1');
  const hk = x.d._test.state().hotkeys;
  assert.deepEqual(hk.map(h => [h.slot, h.key, h.target.wsId]), [[2, 'alt+2', 'w1']]);
  assert.ok(!x.cfg.text.includes('alt+1'));
  assert.equal(keyTok(x, 'w1'), 'Alt+2');
  assert.equal(keyTok(x, 'w2'), undefined, 'the old token is cleared');
  const m = await x.d.handle('hotkey.menu', { wsId: 'w2' });
  assert.equal(m.choices.find(c => c.key === 'alt+2').owner, 'a');
  x.cleanup();
});

test('a key can point at one tab of a workspace', async () => {
  const x = setup({
    workspaces: [ws('w4', 'autopase-cto')],
    tabs: [{ tab_id: 'w4:t1', workspace_id: 'w4', label: 'main' }, { tab_id: 'w4:t2', workspace_id: 'w4', label: 'bots' }],
  });
  await x.d._test.cycle('t');
  const m = await x.d.handle('hotkey.menu', { wsId: 'w4' });
  assert.deepEqual(m.tabs, [{ tabId: 'w4:t1', label: 'main' }, { tabId: 'w4:t2', label: 'bots' }]);
  await x.d.handle('hotkey.set', { key: 'f5', wsId: 'w4', tabId: 'w4:t2' });
  await x.d.handle('hotkey.set', { key: 'f6', wsId: 'w4' });
  const hk = x.d._test.state().hotkeys;
  assert.equal(hk.length, 2, 'the tab and the whole workspace are different targets');
  assert.deepEqual(hk.find(h => h.key === 'f5').target, { wsId: 'w4', label: 'autopase-cto', path: 'c:/p/w4', tabId: 'w4:t2', tabLabel: 'bots' });
  assert.ok(x.cfg.text.includes('description = "прыжок: autopase-cto › bots"'));
  assert.equal(keyTok(x, 'w4'), 'F5 F6');
  x.cleanup();
});

test('when herdr rejects the new bindings, config.toml and the hotkeys stay as they were', async () => {
  const x = setup({ workspaces: [ws('w1', 'a')], issuesAfter: { when: 'alt+3', line: 'alt+3: kept keys.command[0].key, disabled keys.command[5].key' } });
  await x.d._test.cycle('t');
  const before = x.cfg.text;
  await assert.rejects(x.d.handle('hotkey.set', { key: 'alt+3', wsId: 'w1' }), /herdr не принял клавишу/);
  assert.equal(x.cfg.text, before);
  assert.deepEqual(x.d._test.state().hotkeys, []);
  x.cleanup();
});

test('clearing a key removes the binding and the token; without an install nothing is written', async () => {
  const x = setup({ workspaces: [ws('w1', 'a')] });
  await x.d._test.cycle('t');
  await x.d.handle('hotkey.set', { key: 'alt+1', wsId: 'w1' });
  await x.d.handle('hotkey.clear', { key: 'alt+1' });
  assert.ok(!x.cfg.text.includes('jump-'));
  assert.deepEqual(x.d._test.state().hotkeys, []);
  assert.equal(keyTok(x, 'w1'), undefined);
  await assert.rejects(x.d.handle('hotkey.clear', { key: 'alt+1' }), /не назначена/);
  x.cfg.installed = false;
  await assert.rejects(x.d.handle('hotkey.set', { key: 'alt+1', wsId: 'w1' }), /не установлен/);
  x.cleanup();
});

test('a renamed project keeps its key; uninstall clears the key token', async () => {
  const x = setup({ workspaces: [ws('w1', 'Ads')] });
  await x.d._test.cycle('t');
  await x.d.handle('hotkey.set', { key: 'alt+1', wsId: 'w1' });
  x.workspaces[0].label = 'Ads 24/7';
  await x.d._test.cycle('t2');
  assert.equal(x.d._test.state().hotkeys[0].target.label, 'Ads 24/7');
  assert.equal(keyTok(x, 'w1'), 'Alt+1');
  await x.d.handle('uninstall', {});
  assert.equal(keyTok(x, 'w1'), undefined);
  x.cleanup();
});
