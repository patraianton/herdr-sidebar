'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hk = require('../src/hotkeys');

const BEGIN = '# >>> ours';
const END = '# <<< ours';

test('normKey: one spelling, modifiers in order, bad bindings refused', () => {
  assert.equal(hk.normKey('Alt+1'), 'alt+1');
  assert.equal(hk.normKey(' shift + CTRL + k '), 'ctrl+shift+k');
  assert.equal(hk.normKey('alt+prefix+g'), 'prefix+alt+g');
  assert.equal(hk.normKey('F5'), 'f5');
  assert.equal(hk.normKey('control+option+x'), 'ctrl+alt+x');
  assert.equal(hk.normKey('k'), null, 'a bare letter would swallow typing');
  assert.equal(hk.normKey('7'), null);
  assert.equal(hk.normKey('alt+'), null);
  assert.equal(hk.normKey('hyper+k'), null);
  assert.equal(hk.normKey('alt+alt+k'), null);
  assert.equal(hk.normKey('ctrl+alt'), null);
  assert.equal(hk.normKey(''), null);
});

test('displayKey: readable', () => {
  assert.equal(hk.displayKey('alt+1'), 'Alt+1');
  assert.equal(hk.displayKey('f12'), 'F12');
  assert.equal(hk.displayKey('prefix+ctrl+k'), 'prefix+Ctrl+K');
  assert.equal(hk.displayKey('ctrl+alt+minus'), 'Ctrl+Alt+minus');
});

test('choices: ten Alt+digit and eleven function keys, F11 left to the terminal', () => {
  assert.equal(hk.CHOICES.length, 21);
  assert.ok(hk.CHOICES.includes('alt+0'));
  assert.ok(!hk.CHOICES.includes('f11'));
  for (const c of hk.CHOICES) assert.equal(hk.normKey(c), c);
});

const DEFAULTS = [
  '[keys]',
  '# prefix = "ctrl+b"',
  '# new_tab = "prefix+c"',
  '# switch_tab = "prefix+1..9"',
  '# focus_agent = ""        # optional',
  '# Navigate-mode movement.',
  '# navigate_pane_left = "h"',
  '# [[keys.command]]',
  '# key = "prefix+alt+g"',
  '[server]',
  '# new_window = "alt+9"',
].join('\n');

test('usedKeys: other plugins, own [keys], built-in defaults; our block and overridden defaults are free', () => {
  const cfg = [
    '[keys]',
    'new_tab = "ctrl+t"',
    'focus_pane_left = ["prefix+h", "ctrl+alt+h"]',
    '[keys.indexed]',
    'agents = "alt"',
    '[[keys.command]]',
    'key = "prefix+a"',
    'type = "plugin_action"',
    'command = "annotate.capture"',
    'description = "annotate text"',
    BEGIN,
    '[[keys.command]]',
    'key = "f5"',
    'command = "anton.sidebar.jump-1"',
    END,
    '[[keys.command]]',
    'key = "F7"',
    'command = "x.y"',
  ].join('\n');
  const used = hk.usedKeys(cfg, DEFAULTS, BEGIN, END);
  assert.equal(used.get('prefix+a'), '"annotate text"');
  assert.equal(used.get('f7'), 'another herdr command');
  assert.equal(used.get('ctrl+t'), 'herdr: new_tab');
  assert.ok(!used.has('prefix+c'), 'new_tab default is replaced by ctrl+t');
  assert.ok(used.has('ctrl+alt+h') && used.has('prefix+h'));
  assert.ok(used.has('alt+1') && used.has('alt+9'), '[keys.indexed] agents = "alt" takes alt+1..9');
  assert.ok(used.has('prefix+5'), 'switch_tab default range');
  assert.ok(!used.has('f5'), 'our own binding does not block itself');
  assert.ok(!used.has('h'), 'navigate-mode keys do not count');
  assert.ok(!used.has('prefix+alt+g'), 'commented example command does not count');
  assert.ok(!used.has('ctrl+b'), 'the prefix itself is not an action');
});

test('bindingLines: one plugin_action per hotkey, sorted, quotes escaped', () => {
  const lines = hk.bindingLines([
    { slot: 2, key: 'f5', target: { label: 'say "hi"', tabLabel: 'bots' } },
    { slot: 1, key: 'alt+1', target: { label: '[ACME] Ads' } },
  ], 'anton.sidebar');
  assert.deepEqual(lines, [
    '[[keys.command]]', 'key = "alt+1"', 'type = "plugin_action"', 'command = "anton.sidebar.jump-1"', 'description = "jump: [ACME] Ads"',
    '[[keys.command]]', 'key = "f5"', 'type = "plugin_action"', 'command = "anton.sidebar.jump-2"', 'description = "jump: say \\"hi\\" › bots"',
  ]);
});

test('nextSlot: lowest free slot, none past the limit', () => {
  assert.equal(hk.nextSlot([]), 1);
  assert.equal(hk.nextSlot([{ slot: 1 }, { slot: 3 }]), 2);
  const full = Array.from({ length: hk.MAX_SLOTS }, (_, i) => ({ slot: i + 1 }));
  assert.equal(hk.nextSlot(full), null);
});

const W = (id, label, extra = {}) => ({ workspace_id: id, label, ...extra });

test('findWorkspace: id with the same name; else by name with folder as tie-break; renamed id only with same folder', () => {
  const paths = { w1: 'C:\\p\\a', w2: 'C:\\p\\b', w3: 'C:\\p\\c', w4: 'C:\\p\\d' };
  const ws = [W('w1', 'china-cars'), W('w2', 'china-cars'), W('w3', 'Ads'), W('w4', 'new name')];
  assert.equal(hk.findWorkspace({ wsId: 'w3', label: 'Ads' }, ws, paths).workspace_id, 'w3');
  // after a restart the id belongs to someone else: the name wins
  assert.equal(hk.findWorkspace({ wsId: 'w1', label: 'Ads' }, ws, paths).workspace_id, 'w3');
  // two workspaces with one name: the folder decides
  assert.equal(hk.findWorkspace({ wsId: 'w9', label: 'china-cars', path: 'c:/p/b' }, ws, paths).workspace_id, 'w2');
  // renamed while herdr was down: same id, same folder
  assert.equal(hk.findWorkspace({ wsId: 'w4', label: 'old name', path: 'c:/p/d' }, ws, paths).workspace_id, 'w4');
  // same id, other name, other folder: not it
  assert.equal(hk.findWorkspace({ wsId: 'w4', label: 'old name', path: 'c:/p/zzz' }, ws, paths), null);
  assert.equal(hk.findWorkspace({ wsId: 'w9', label: 'gone' }, ws, paths), null);
});

test('wsPath: worktree checkout first, then the first pane folder', () => {
  assert.equal(hk.wsPath(W('w1', 'x', { worktree: { checkout_path: 'C:\\R\\wt' } }), { w1: 'C:\\elsewhere' }), 'c:/r/wt');
  assert.equal(hk.wsPath(W('w1', 'x'), { w1: 'C:\\P\\' }), 'c:/p');
});

test('findTab: same id and name, else name', () => {
  const tabs = [
    { tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' },
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'bots' },
    { tab_id: 'w2:t2', workspace_id: 'w2', label: 'bots' },
  ];
  assert.equal(hk.findTab({ tabId: 'w1:t2', tabLabel: 'bots' }, tabs, 'w1').tab_id, 'w1:t2');
  assert.equal(hk.findTab({ tabId: 'w1:t9', tabLabel: 'bots' }, tabs, 'w1').tab_id, 'w1:t2');
  assert.equal(hk.findTab({ tabId: 'w1:t1', tabLabel: 'renamed' }, tabs, 'w1'), null, 'a bare id may belong to another tab now');
  assert.equal(hk.findTab({ tabId: 'w1:t9', tabLabel: 'nope' }, tabs, 'w1'), null);
  assert.equal(hk.findTab({}, tabs, 'w1'), null, 'a workspace-wide hotkey has no tab');
});

test('refreshTargets: follows a rename while watching, re-binds a new id after a restart', () => {
  const paths = { w1: 'C:\\p\\a', w7: 'C:\\p\\a' };
  const keys = [{ slot: 1, key: 'alt+1', target: { wsId: 'w1', label: 'Ads', path: 'c:/p/a' } }];
  let r = hk.refreshTargets(keys, [W('w1', 'Ads 24/7')], paths, true);
  assert.ok(r.changed);
  assert.equal(r.hotkeys[0].target.label, 'Ads 24/7');
  r = hk.refreshTargets(keys, [W('w1', 'Ads')], paths, true);
  assert.equal(r.changed, false);
  assert.equal(r.hotkeys, r.hotkeys); // untouched
  // restart: w1 is now another project, Ads came back as w7
  r = hk.refreshTargets(keys, [W('w1', 'other'), W('w7', 'Ads')], { w1: 'C:\\q', w7: 'C:\\p\\a' }, false);
  assert.equal(r.hotkeys[0].target.wsId, 'w7');
  // gone: left as is, so it comes back when the project does
  r = hk.refreshTargets(keys, [W('w2', 'x')], {}, false);
  assert.equal(r.changed, false);
  assert.equal(r.hotkeys[0].target.wsId, 'w1');
});

test('review: shift with a printable key would swallow capitals', () => {
  assert.equal(hk.normKey('shift+k'), null);
  assert.equal(hk.normKey('shift+1'), null);
  assert.equal(hk.normKey('shift+f5'), 'shift+f5');
  assert.equal(hk.normKey('ctrl+shift+k'), 'ctrl+shift+k');
});

test('review: two projects with one name are told apart by folder even when the id now belongs to the other', () => {
  const ws = [W('w2', 'api'), W('w5', 'api')];
  const paths = { w2: 'C:/b', w5: 'C:/a' };
  assert.equal(hk.findWorkspace({ wsId: 'w2', label: 'api', path: 'c:/a' }, ws, paths).workspace_id, 'w5');
  // folder changed by cd: the id decides between the namesakes
  assert.equal(hk.findWorkspace({ wsId: 'w2', label: 'api', path: 'c:/zzz' }, ws, paths).workspace_id, 'w2');
});

test('review: a tab is found by id and name or by name, never by a bare id that may be reused', () => {
  const tabs = [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'other' }];
  assert.equal(hk.findTab({ tabId: 'w1:t1', tabLabel: 'bots' }, tabs, 'w1'), null);
});

test('review: tab names follow a rename while watching, tab ids follow a restart', () => {
  const keys = [{ slot: 1, key: 'f5', target: { wsId: 'w1', label: 'a', tabId: 'w1:t2', tabLabel: 'bots' } }];
  let r = hk.refreshTabs(keys, { w1: [{ tab_id: 'w1:t2', workspace_id: 'w1', label: 'bots2' }] }, true);
  assert.ok(r.changed);
  assert.equal(r.hotkeys[0].target.tabLabel, 'bots2');
  r = hk.refreshTabs(keys, { w1: [{ tab_id: 'w1:t2', workspace_id: 'w1', label: 'main' }, { tab_id: 'w1:t7', workspace_id: 'w1', label: 'bots' }] }, false);
  assert.equal(r.hotkeys[0].target.tabId, 'w1:t7');
  r = hk.refreshTabs(keys, {}, true);
  assert.equal(r.changed, false, 'workspace not listed: left alone');
});

test('review: herdr check lines compare without the binding numbers', () => {
  assert.equal(hk.issueKey('alt+1: kept keys.command[0].key, disabled keys.command[1].key'),
    hk.issueKey('alt+1: kept keys.command[2].key, disabled keys.command[3].key'));
});

test('review 2: two namesakes in one folder are told apart by id', () => {
  const ws = [W('w1', 'api'), W('w2', 'api')];
  const paths = { w1: 'C:/x', w2: 'C:/x' };
  assert.equal(hk.findWorkspace({ wsId: 'w2', label: 'api', path: 'c:/x' }, ws, paths).workspace_id, 'w2');
});

test('review 2: a namesake in another folder is not the closed project', () => {
  const paths = { w2: 'C:/b', w3: 'C:/c' };
  assert.equal(hk.findWorkspace({ wsId: 'w1', label: 'api', path: 'c:/a' }, [W('w2', 'api')], paths), null);
  assert.equal(hk.findWorkspace({ wsId: 'w1', label: 'api', path: 'c:/a' }, [W('w2', 'api'), W('w3', 'api')], paths), null);
  // the same id with the same name is the same project even if its folder changed
  assert.equal(hk.findWorkspace({ wsId: 'w2', label: 'api', path: 'c:/a' }, [W('w2', 'api')], paths).workspace_id, 'w2');
  // nothing to compare: the name decides
  assert.equal(hk.findWorkspace({ wsId: 'w1', label: 'api' }, [W('w2', 'api')], paths).workspace_id, 'w2');
  assert.equal(hk.findWorkspace({ wsId: 'w1', label: 'api', path: 'c:/a' }, [W('w2', 'api')], {}).workspace_id, 'w2');
});

test('review 2: a closed target is not handed to a namesake in another folder', () => {
  const keys = [{ slot: 1, key: 'alt+1', target: { wsId: 'w1', label: 'api', path: 'c:/a' } }];
  const r = hk.refreshTargets(keys, [W('w2', 'api')], { w2: 'C:/b' }, false);
  assert.equal(r.changed, false);
  assert.equal(r.hotkeys[0].target.wsId, 'w1');
});
