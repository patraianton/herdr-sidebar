'use strict';
// Cases found by the review of the hotkeys commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDaemon, _defaultKeysConfig } = require('../src/daemon');
const cp = require('../src/configpatch');

const BASE = cp.patchConfig('[[keys.command]]\nkey = "f7"\ntype = "plugin_action"\ncommand = "annotate.capture"\n').text;
const FOREIGN = '\n[[keys.command]]\nkey = "prefix+y"\ntype = "plugin_action"\ncommand = "yourmove.toggle"\n';

function setup({ workspaces, tabs = [], issues, reloadFails }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-keys2-'));
  const herdr = {
    ping: async () => ({}),
    listWorkspaces: async () => JSON.parse(JSON.stringify(workspaces)),
    listPanes: async () => workspaces.map(w => ({ pane_id: `${w.workspace_id}:p1`, workspace_id: w.workspace_id, cwd: `C:/p/${w.workspace_id}` })),
    listAgents: async () => [],
    listTabs: async wsId => tabs.filter(t => t.workspace_id === wsId),
    moveBlock: async ids => ids,
    setTokens: async () => {},
    reloadConfig: async () => { if (reloadFails) throw new Error('server.reload_config: boom'); },
    notify: async () => {},
  };
  const cfg = { text: BASE, checks: 0 };
  const keysConfig = {
    file: () => 'C:/fake/config.toml',
    read: () => cfg.text,
    write: (_f, t) => { cfg.text = t; },
    backup: () => {},
    issues: () => { cfg.checks++; return issues ? issues(cfg) : []; },
    defaults: () => '',
  };
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir: path.join(dir, 'config'), herdr, keysConfig,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
  });
  d._test.markConnected();
  return { d, cfg, tabs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ws = (id, label) => ({ workspace_id: id, label });

test('a binding another agent adds while ours is being checked survives', async () => {
  const x = setup({
    workspaces: [ws('w1', 'a')],
    issues: cfg => { if (cfg.checks === 1) cfg.text += FOREIGN; return []; },
  });
  await x.d._test.cycle('t');
  await x.d.handle('hotkey.set', { key: 'alt+5', wsId: 'w1' });
  assert.ok(x.cfg.text.includes('yourmove.toggle'), 'foreign block lost');
  assert.ok(x.cfg.text.includes('anton.sidebar.jump-1'));
  x.cleanup();
});

test('a rollback keeps what another agent added meanwhile', async () => {
  const x = setup({
    workspaces: [ws('w1', 'a')],
    issues: cfg => {
      if (cfg.checks === 2) { cfg.text += FOREIGN; return ['alt+5: something wrong']; }
      return [];
    },
  });
  await x.d._test.cycle('t');
  await assert.rejects(x.d.handle('hotkey.set', { key: 'alt+5', wsId: 'w1' }), /did not accept/);
  assert.ok(x.cfg.text.includes('yourmove.toggle'), 'foreign block lost by the rollback');
  assert.ok(!x.cfg.text.includes('jump-1'), 'our binding left behind');
  x.cleanup();
});

test('an old problem whose binding numbers shifted does not block a new key', async () => {
  const x = setup({
    workspaces: [ws('w1', 'a')],
    issues: cfg => [cfg.text.includes('jump-1')
      ? 'prefix+y: kept keys.command[3].key, disabled keys.command[4].key'
      : 'prefix+y: kept keys.command[1].key, disabled keys.command[2].key'],
  });
  await x.d._test.cycle('t');
  await x.d.handle('hotkey.set', { key: 'alt+5', wsId: 'w1' });
  assert.ok(x.cfg.text.includes('jump-1'));
  x.cleanup();
});

test('when herdr cannot check the config, nothing is written', async () => {
  const x = setup({ workspaces: [ws('w1', 'a')], issues: () => { throw new Error('Could not check herdr settings: spawn herdr ENOENT'); } });
  await x.d._test.cycle('t');
  const before = x.cfg.text;
  await assert.rejects(x.d.handle('hotkey.set', { key: 'alt+5', wsId: 'w1' }), /Could not check/);
  assert.equal(x.cfg.text, before);
  x.cleanup();
});

test('the real config check refuses to guess when the herdr program is missing', () => {
  const was = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = path.join(os.tmpdir(), 'no-such-herdr.exe');
  try {
    const kc = _defaultKeysConfig(os.tmpdir());
    assert.throws(() => kc.issues(path.join(os.tmpdir(), 'x.toml')), /Could not check/);
    assert.throws(() => kc.defaults(), /Could not read/);
  } finally {
    if (was === undefined) delete process.env.HERDR_BIN_PATH; else process.env.HERDR_BIN_PATH = was;
  }
});

test('the window binding of the plugin itself is not offered as a custom key', async () => {
  const x = setup({ workspaces: [ws('w1', 'a')] });
  await x.d._test.cycle('t');
  await assert.rejects(x.d.handle('hotkey.set', { key: 'prefix+shift+s', wsId: 'w1' }), /is taken: the Sidebar Organizer window/);
  x.cleanup();
});

test('if herdr does not re-read its settings, the answer says so', async () => {
  const x = setup({ workspaces: [ws('w1', 'a')], reloadFails: true });
  await x.d._test.cycle('t');
  const r = await x.d.handle('hotkey.set', { key: 'alt+5', wsId: 'w1' });
  assert.equal(r.reloaded, false);
  x.cleanup();
});

test('a renamed tab keeps its hotkey', async () => {
  const x = setup({ workspaces: [ws('w4', 'cto')], tabs: [{ tab_id: 'w4:t2', workspace_id: 'w4', label: 'bots' }] });
  await x.d._test.cycle('t');
  await x.d.handle('hotkey.set', { key: 'f5', wsId: 'w4', tabId: 'w4:t2' });
  x.tabs[0].label = 'bots-2';
  await x.d._test.cycle('t2');
  assert.equal(x.d._test.state().hotkeys[0].target.tabLabel, 'bots-2');
  x.cleanup();
});
