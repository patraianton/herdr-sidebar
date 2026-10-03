'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { jumpTo } = require('../src/cli');

function fake(workspaces, tabs = []) {
  const calls = [];
  return {
    calls,
    listWorkspaces: async () => workspaces,
    listPanes: async () => workspaces.map(w => ({ workspace_id: w.workspace_id, cwd: `C:\\p\\${w.workspace_id}` })),
    listTabs: async wsId => tabs.filter(t => t.workspace_id === wsId),
    focusWorkspace: async id => { calls.push(['ws', id]); },
    focusTab: async id => { calls.push(['tab', id]); },
    notify: async (title, body) => { calls.push(['notify', title, body]); },
  };
}
const state = hotkeys => ({ hotkeys });

test('jump focuses the workspace of the slot', async () => {
  const h = fake([{ workspace_id: 'w1', label: 'a' }, { workspace_id: 'w2', label: '[WS] Ads' }]);
  const r = await jumpTo(h, state([{ slot: 3, key: 'alt+1', target: { wsId: 'w2', label: '[WS] Ads' } }]), '3');
  assert.equal(r, 'w2');
  assert.deepEqual(h.calls, [['ws', 'w2']]);
});

test('jump to a tab focuses the workspace, then the tab found by name', async () => {
  const h = fake([{ workspace_id: 'w4', label: 'cto' }], [
    { tab_id: 'w4:t1', workspace_id: 'w4', label: 'main' }, { tab_id: 'w4:t9', workspace_id: 'w4', label: 'bots' },
  ]);
  const r = await jumpTo(h, state([{ slot: 1, key: 'f5', target: { wsId: 'w4', label: 'cto', tabId: 'w4:t2', tabLabel: 'bots' } }]), 1);
  assert.equal(r, 'w4:t9');
  assert.deepEqual(h.calls, [['ws', 'w4'], ['tab', 'w4:t9']]);
});

test('after a restart the project is found by name under its new id', async () => {
  const h = fake([{ workspace_id: 'w2', label: 'other' }, { workspace_id: 'w8', label: 'Ads' }]);
  await jumpTo(h, state([{ slot: 1, key: 'alt+1', target: { wsId: 'w2', label: 'Ads' } }]), 1);
  assert.deepEqual(h.calls, [['ws', 'w8']]);
});

test('a closed project or an empty slot only shows a notice', async () => {
  const h = fake([{ workspace_id: 'w1', label: 'a' }]);
  assert.equal(await jumpTo(h, state([{ slot: 1, key: 'alt+1', target: { wsId: 'w5', label: 'gone' } }]), 1), 'missing');
  assert.equal(await jumpTo(h, state([]), 2), 'unbound');
  assert.deepEqual(h.calls.map(c => c[0]), ['notify', 'notify']);
  assert.match(h.calls[0][1], /Alt\+1: «gone» не найдено/);
});

test('a missing tab opens the project and says why', async () => {
  const h = fake([{ workspace_id: 'w4', label: 'cto' }], [{ tab_id: 'w4:t2', workspace_id: 'w4', label: 'main' }]);
  const r = await jumpTo(h, state([{ slot: 1, key: 'f5', target: { wsId: 'w4', label: 'cto', tabId: 'w4:t2', tabLabel: 'bots' } }]), 1);
  assert.equal(r, 'w4');
  assert.deepEqual(h.calls.map(c => c[0]), ['ws', 'notify']);
  assert.match(h.calls[1][1], /F5: вкладки «bots» нет/);
});
