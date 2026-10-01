'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../src/ops');
const { emptyState } = require('../src/store');

// In-memory stand-in for the few herdr calls ops.js makes.
function fakeHerdr() {
  const w = {
    workspaces: [
      { workspace_id: 'w1', label: 'autopase', worktree: { repo_key: 'C:\\p\\ap\\.git', repo_root: 'C:\\p\\ap', checkout_path: 'C:\\p\\ap', is_linked_worktree: false } },
      { workspace_id: 'w2', label: 'cookie', worktree: { repo_key: 'C:\\p\\ap\\.git', repo_root: 'C:\\p\\ap', checkout_path: '\\\\?\\C:\\wt\\cookie', is_linked_worktree: true } },
      { workspace_id: 'w3', label: 'plain' },
    ],
    tabs: [
      { tab_id: 'w2:t2', workspace_id: 'w2', number: 2, label: 'logs' },
      { tab_id: 'w2:t1', workspace_id: 'w2', number: 1, label: 'main' },
    ],
    panes: [
      { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' },
      { pane_id: 'w2:p3', tab_id: 'w2:t2', workspace_id: 'w2' },
      { pane_id: 'w2:p2', tab_id: 'w2:t1', workspace_id: 'w2' },
    ],
    calls: [],
    next: 10,
    openResult: null,
  };
  const h = {
    listWorkspaces: async () => w.workspaces,
    listTabs: async id => w.tabs.filter(t => t.workspace_id === id),
    listPanes: async id => w.panes.filter(p => p.workspace_id === id),
    movePane: async (paneId, dest) => {
      w.calls.push(['move', paneId, dest]);
      const p = w.panes.find(x => x.pane_id === paneId);
      if (dest.type === 'new_workspace') {
        const id = `w${w.next++}`;
        w.workspaces.push({ workspace_id: id, label: dest.label });
        p.workspace_id = id;
        return { created_workspace: { workspace_id: id }, pane: { ...p } };
      }
      p.workspace_id = dest.workspace_id;
      return { pane: { ...p } };
    },
    closePane: async id => { w.calls.push(['close', id]); },
    worktreeOpen: async params => { w.calls.push(['open', params]); return w.openResult(params); },
  };
  return { w, h };
}

test('detach moves panes in tab order with tab labels and records the copy', async () => {
  const { w, h } = fakeHerdr();
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['repo:c:/p/ap/.git', 'ws:w3'] }];
  s.duty.d1 = { id: 'd1', wsId: 'w2' };
  const r = await ops.detach(h, s, { wsId: 'w2' });
  assert.equal(r.wsId, 'w10');
  assert.deepEqual(w.calls.map(c => [c[1], c[2].type, c[2].label]), [
    ['w2:p1', 'new_workspace', 'cookie'], ['w2:p2', 'new_tab', 'main 2'], ['w2:p3', 'new_tab', 'logs'],
  ]);
  assert.equal(w.calls[0][2].tab_label, 'main');
  assert.deepEqual(s.detached.w10, {
    checkout: 'C:\\wt\\cookie', repoKey: 'c:/p/ap/.git', repoRoot: 'C:\\p\\ap', parentLabel: 'autopase', name: 'cookie', at: s.detached.w10.at,
  });
  assert.deepEqual(s.categories[0].units, ['repo:c:/p/ap/.git', 'ws:w10', 'ws:w3']);
  assert.equal(s.duty.d1.wsId, 'w10');
});

test('detach refuses a workspace that is not a worktree', async () => {
  const { h } = fakeHerdr();
  await assert.rejects(ops.detach(h, emptyState(), { wsId: 'w3' }), /не копия/);
});

test('reattach when herdr recognises the detached workspace', async () => {
  const { w, h } = fakeHerdr();
  const s = emptyState();
  await ops.detach(h, s, { wsId: 'w2' });
  w.calls.length = 0;
  w.openResult = () => ({ already_open: true, workspace: { workspace_id: 'w10' }, root_pane: { pane_id: 'w10:p1' } });
  const r = await ops.reattach(h, s, { wsId: 'w10' });
  assert.equal(r.wsId, 'w10');
  assert.deepEqual(w.calls, [['open', { workspace_id: 'w1', path: 'C:\\wt\\cookie', label: 'cookie' }]]);
  assert.deepEqual(s.detached, {});
});

test('reattach repairs: panes move into the fresh workspace and its empty shell is closed', async () => {
  const { w, h } = fakeHerdr();
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['repo:c:/p/ap/.git'] }];
  s.duty.d1 = { id: 'd1', wsId: 'w2' };
  await ops.detach(h, s, { wsId: 'w2' });
  w.tabs.push({ tab_id: 'w10:t1', workspace_id: 'w10', number: 1, label: 'main' });
  for (const p of w.panes) if (p.workspace_id === 'w10') p.tab_id = 'w10:t1';
  w.calls.length = 0;
  w.openResult = () => ({ already_open: false, workspace: { workspace_id: 'w20' }, root_pane: { pane_id: 'w20:p1' } });
  const r = await ops.reattach(h, s, { wsId: 'w10' });
  assert.equal(r.wsId, 'w20');
  const moves = w.calls.filter(c => c[0] === 'move');
  assert.deepEqual(moves.map(c => [c[1], c[2].workspace_id]), [['w2:p1', 'w20'], ['w2:p3', 'w20'], ['w2:p2', 'w20']]);
  assert.deepEqual(w.calls[w.calls.length - 1], ['close', 'w20:p1']);
  assert.equal(s.duty.d1.wsId, 'w20');
  assert.deepEqual(s.categories[0].units, ['repo:c:/p/ap/.git']);
  assert.deepEqual(s.detached, {});
});

test('reattach without the parent open uses the repo folder', async () => {
  const { w, h } = fakeHerdr();
  const s = emptyState();
  await ops.detach(h, s, { wsId: 'w2' });
  w.workspaces = w.workspaces.filter(x => x.workspace_id !== 'w1');
  w.openResult = () => ({ already_open: true, workspace: { workspace_id: 'w10' } });
  await ops.reattach(h, s, { wsId: 'w10' });
  assert.deepEqual(w.calls.find(c => c[0] === 'open')[1], { cwd: 'C:\\p\\ap', path: 'C:\\wt\\cookie', label: 'cookie' });
});
