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
    refuse: new Set(), // panes herdr will not move (e.g. reason zoomed_tab)
  };
  const h = {
    listWorkspaces: async () => w.workspaces,
    listTabs: async id => w.tabs.filter(t => t.workspace_id === id),
    listPanes: async id => w.panes.filter(p => p.workspace_id === id),
    zoomPane: async (paneId, mode) => { w.calls.push(['zoom', paneId, mode]); },
    movePane: async (paneId, dest) => {
      w.calls.push(['move', paneId, dest]);
      const p = w.panes.find(x => x.pane_id === paneId);
      if (w.refuse.has(paneId)) return { changed: false, reason: 'zoomed_tab', pane: { ...p } };
      if (dest.type === 'new_workspace') {
        const id = `w${w.next++}`;
        w.workspaces.push({ workspace_id: id, label: dest.label });
        w.tabs.push({ tab_id: `${id}:t1`, workspace_id: id, number: 1, label: dest.tab_label });
        p.workspace_id = id;
        p.tab_id = `${id}:t1`;
        return { created_workspace: { workspace_id: id }, pane: { ...p } };
      }
      const n = w.tabs.filter(t => t.workspace_id === dest.workspace_id).length + 1;
      w.tabs.push({ tab_id: `${dest.workspace_id}:t${n}`, workspace_id: dest.workspace_id, number: n, label: dest.label });
      p.workspace_id = dest.workspace_id;
      p.tab_id = `${dest.workspace_id}:t${n}`;
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
  assert.deepEqual(w.calls.filter(c => c[0] === 'zoom'), [['zoom', 'w2:p1', 'off'], ['zoom', 'w2:p3', 'off']], 'tabs are unzoomed first');
  w.calls = w.calls.filter(c => c[0] === 'move');
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
  w.calls.length = 0;
  w.openResult = () => ({ already_open: false, workspace: { workspace_id: 'w20' }, root_pane: { pane_id: 'w20:p1' } });
  const r = await ops.reattach(h, s, { wsId: 'w10' });
  assert.equal(r.wsId, 'w20');
  const moves = w.calls.filter(c => c[0] === 'move');
  assert.deepEqual(moves.map(c => [c[1], c[2].workspace_id]), [['w2:p1', 'w20'], ['w2:p2', 'w20'], ['w2:p3', 'w20']]);
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

test('reattach into another workspace that was already open: panes move, nothing is closed', async () => {
  const { w, h } = fakeHerdr();
  const s = emptyState();
  await ops.detach(h, s, { wsId: 'w2' });
  w.calls.length = 0;
  w.openResult = () => ({ already_open: true, workspace: { workspace_id: 'w30' }, root_pane: { pane_id: 'w30:p1' } });
  const r = await ops.reattach(h, s, { wsId: 'w10' });
  assert.equal(r.wsId, 'w30');
  assert.ok(!w.calls.some(c => c[0] === 'close'), 'must not close a pane of an existing workspace');
  assert.deepEqual(w.calls.filter(c => c[0] === 'move').map(c => c[2].workspace_id), ['w30', 'w30', 'w30']);
});

test('detach: herdr refuses the first move -> error, nothing recorded', async () => {
  const { w, h } = fakeHerdr();
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['repo:c:/p/ap/.git'] }];
  w.refuse.add('w2:p1');
  await assert.rejects(ops.detach(h, s, { wsId: 'w2' }), /не перенёс/);
  assert.deepEqual(s.detached, {});
  assert.deepEqual(s.categories[0].units, ['repo:c:/p/ap/.git']);
  assert.equal(w.calls.filter(c => c[0] === 'move').length, 1, 'stops after the refused move');
});

test('detach: a later move refused -> the copy is recorded and the error names the stuck pane', async () => {
  const { w, h } = fakeHerdr();
  const s = emptyState();
  w.refuse.add('w2:p3');
  await assert.rejects(ops.detach(h, s, { wsId: 'w2' }), /w2:p3/);
  assert.ok(s.detached.w10, 'the new workspace exists, so it is recorded');
});

test('reattach: a refused move keeps the record and closes nothing', async () => {
  const { w, h } = fakeHerdr();
  const s = emptyState();
  await ops.detach(h, s, { wsId: 'w2' });
  w.calls.length = 0;
  w.refuse.add('w2:p3');
  w.openResult = () => ({ already_open: false, workspace: { workspace_id: 'w20' }, root_pane: { pane_id: 'w20:p1' } });
  await assert.rejects(ops.reattach(h, s, { wsId: 'w10' }), /w2:p3/);
  assert.ok(s.detached.w10, 'record kept');
  assert.ok(!w.calls.some(c => c[0] === 'close'));
});
