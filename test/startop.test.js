'use strict';
// Stars on top: the projects with a star of a chosen kind stand in a block of
// their own above every category; a worktree copy that stands apart from its
// project (its own star, or the project's star without it) is detached once and
// stays apart, so its agents' ids change no more than once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const model = require('../src/model');
const { emptyState } = require('../src/store');
const store = require('../src/store');
const cp = require('../src/configpatch');
const { createDaemon } = require('../src/daemon');

const ws = (id, label, worktree) => ({ workspace_id: id, label, worktree });
const wt = (repo, linked, checkout) => ({
  repo_key: `C:\\p\\${repo}\\.git`, repo_root: `C:\\p\\${repo}`, is_linked_worktree: linked, checkout_path: checkout,
});
const AP = 'repo:c:/p/acme-api/.git';

// ---- the order ----

function world() {
  return [
    ws('w1', 'fix-pc'),
    ws('w2', 'acme-api', wt('acme-api', false, 'C:\\p\\acme-api')),
    ws('w3', 'blog'),
    ws('w4', 'cookie', wt('acme-api', true, 'C:\\wt\\cookie')),
    ws('w5', 'lonely', wt('lonely', true, 'C:\\wt\\lonely')),
    ws('w6', 'notes'),
  ];
}
const PATHS = { w1: 'C:\\p\\fix-pc', w3: 'C:\\p\\blog', w6: 'C:\\p\\notes' };
const NAMES = k => ['Main', 'Second', 'Third', 'Fourth'][k - 1];

function blocksWorld(onTop) {
  const s = emptyState();
  s.categories = [{ id: 'cA', name: 'A', units: ['ws:w1', AP] }, { id: 'cB', name: 'B', units: ['ws:w3', 'ws:w6'] }];
  const u = model.buildUnits(world(), PATHS, new Set());
  // a group counts by its main project: the star of the copy w4 does not matter here
  const kinds = { w2: 1, w3: 1, w5: 1, w6: 2, w4: 2 };
  return { s, u, b: model.starBlocks(s, u, id => kinds[id] || 0, onTop, NAMES) };
}

test('starBlocks: one block per kind on top, in the order of the categories, then the rest', () => {
  const { b } = blocksWorld([2, 1]);
  assert.deepEqual(b.cats, [
    { id: 'star1', name: '★ Main', units: [AP, 'ws:w3', 'ws:w5'] },
    { id: 'star2', name: '★ Second', units: ['ws:w6'], untitled: true },
  ]);
  assert.deepEqual([...b.pinned].sort(), [AP, 'ws:w3', 'ws:w5', 'ws:w6'].sort());
});

test('starBlocks: kinds not on top stay in their categories; nothing on top changes nothing', () => {
  const { s, b } = blocksWorld([2]);
  assert.deepEqual(b.cats.map(c => c.units), [['ws:w6']]);
  const none = blocksWorld([]);
  assert.deepEqual(none.b.cats, []);
  assert.equal(model.withBlocks(none.s, none.b), none.s);
  assert.deepEqual(s.categories[1].units, ['ws:w3', 'ws:w6'], 'the categories themselves are not changed');
});

test('the blocks stand above the categories; only the first has a title; a category left empty has none', () => {
  const { s, u, b } = blocksWorld([1, 2]);
  const shown = model.withBlocks(s, b);
  const order = model.desiredOrder(shown, u, ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
  assert.deepEqual(order, ['w2', 'w4', 'w3', 'w5', 'w6', 'w1']);
  assert.deepEqual(model.sectionTokens(shown, u, order), { w2: '━━ ★ MAIN ━━', w1: '━━ A ━━' });
  const second = blocksWorld([2]);
  const alone = model.withBlocks(second.s, second.b);
  assert.equal(model.sectionTokens(alone, second.u, model.desiredOrder(alone, second.u, ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'])).w6,
    '━━ ★ SECOND ━━', 'the first block shown has the title, whatever its kind');
});

test('learn: a project in a star block is not moved to another category by a drag', () => {
  const s = emptyState();
  s.categories = [{ id: 'cX', name: 'X', units: ['ws:w1', 'ws:w6'] }, { id: 'cY', name: 'Y', units: ['ws:w3'] }];
  const list = [ws('w3', 'blog'), ws('w1', 'fix-pc'), ws('w6', 'notes')];
  s.lastApplied = ['w3', 'w1', 'w6']; // w3 has a star on top
  const u = model.buildUnits(list, PATHS, new Set());
  const r = model.learnFromOrder(s, u, ['w1', 'w6', 'w3'], [], new Set(['ws:w3']));
  assert.deepEqual(r.moved, []);
  assert.equal(r.state, s);
});

// ---- the helper ----

// herdr in memory: panes move between workspaces, an emptied workspace closes,
// worktreeOpen opens a fresh copy, moveBlock reorders.
function setup(list, state, settings, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-startop-'));
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  if (settings) store.saveJson(path.join(configDir, 'settings.json'), settings);
  if (state) store.saveJson(path.join(dir, 'state.json'), { ...emptyState(), ...state });
  const cwdOf = w => (w.worktree ? w.worktree.checkout_path : `C:\\p\\${w.label}`);
  const panes = list.map(w => ({ pane_id: `${w.workspace_id}:p1`, tab_id: `${w.workspace_id}:t1`, workspace_id: w.workspace_id, cwd: cwdOf(w) }));
  const tabs = list.map(w => ({ tab_id: `${w.workspace_id}:t1`, workspace_id: w.workspace_id, number: 1, label: 'main' }));
  const calls = [];
  let next = 10;
  const copy = x => JSON.parse(JSON.stringify(x));
  const closeIfEmpty = id => {
    if (panes.some(p => p.workspace_id === id)) return;
    const i = list.findIndex(w => w.workspace_id === id);
    if (i >= 0) list.splice(i, 1);
  };
  const herdr = {
    ping: async () => ({}),
    listWorkspaces: async () => copy(list),
    listPanes: async id => copy(id ? panes.filter(p => p.workspace_id === id) : panes),
    listTabs: async id => copy(id ? tabs.filter(t => t.workspace_id === id) : tabs),
    listAgents: async () => [],
    moveBlock: async ids => {
      list.sort((a, b) => ids.indexOf(a.workspace_id) - ids.indexOf(b.workspace_id));
      return ids;
    },
    setTokens: async (id, tokens) => {
      const w = list.find(x => x.workspace_id === id);
      w.tokens = { ...(w.tokens || {}) };
      for (const [k, v] of Object.entries(tokens)) { if (v == null) delete w.tokens[k]; else w.tokens[k] = v; }
    },
    reloadConfig: async () => {},
    notify: async () => {},
    zoomPane: async () => {},
    movePane: async (paneId, dest) => {
      calls.push(['move', paneId, dest.type]);
      const p = panes.find(x => x.pane_id === paneId);
      const from = p.workspace_id;
      let to = dest.workspace_id;
      const res = {};
      if (dest.type === 'new_workspace') {
        to = `w${next++}`;
        list.push({ workspace_id: to, label: dest.label });
        res.created_workspace = { workspace_id: to };
      }
      const n = tabs.filter(t => t.workspace_id === to).length + 1;
      tabs.push({ tab_id: `${to}:t${n}`, workspace_id: to, number: n, label: dest.tab_label || dest.label });
      p.workspace_id = to;
      p.tab_id = `${to}:t${n}`;
      closeIfEmpty(from);
      return { ...res, pane: copy(p) };
    },
    worktreeOpen: async ({ workspace_id: parentId, path: checkout, label }) => {
      calls.push(['open', parentId, checkout]);
      const parent = list.find(w => w.workspace_id === parentId);
      const id = `w${next++}`;
      list.push({ workspace_id: id, label, worktree: { ...parent.worktree, is_linked_worktree: true, checkout_path: checkout } });
      panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id, cwd: checkout });
      tabs.push({ tab_id: `${id}:t1`, workspace_id: id, number: 1, label: 'shell' });
      return { already_open: false, workspace: { workspace_id: id }, root_pane: { pane_id: `${id}:p1` } };
    },
    closePane: async id => {
      const i = panes.findIndex(p => p.pane_id === id);
      if (i < 0) return;
      const [p] = panes.splice(i, 1);
      closeIfEmpty(p.workspace_id);
    },
  };
  const text = cp.patchConfig('').text;
  const keysConfig = {
    file: () => 'C:/fake/config.toml', read: () => text, write: () => {}, backup: () => {}, issues: () => [], defaults: () => '[keys]\n',
    flat: () => !!opts.flat,
  };
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir, herdr, keysConfig,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
  });
  d._test.markConnected();
  return { d, list, calls, configDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ids = list => list.map(w => w.workspace_id);
const tok = (list, id, k) => ((list.find(w => w.workspace_id === id) || {}).tokens || {})[k];

test('a kind of star put on top: its projects go up under their own title and come back when the star is off', async () => {
  const list = [ws('w1', 'alpha'), ws('w2', 'beta'), ws('w3', 'gamma')];
  const x = setup(list, { categories: [{ id: 'c1', name: 'Work', units: ['ws:w1', 'ws:w2', 'ws:w3'] }], nextId: 2 });
  await x.d._test.cycle('t');
  await x.d.handle('star.set', { wsId: 'w3', kind: 1 });
  assert.deepEqual(ids(list), ['w1', 'w2', 'w3'], 'not on top yet');

  assert.deepEqual(await x.d.handle('star.top', { kind: 1 }), { kind: 1, on: true, name: 'Main' });
  assert.deepEqual(store.loadJson(path.join(x.configDir, 'settings.json'), {}).starsOnTop, [1]);
  assert.deepEqual(ids(list), ['w3', 'w1', 'w2']);
  assert.equal(tok(list, 'w3', 'section'), '━━ ★ MAIN ━━');
  assert.equal(tok(list, 'w1', 'section'), '━━ WORK ━━');
  const v = await x.d.handle('view');
  assert.deepEqual(v.starsOnTop, [1]);
  assert.deepEqual(v.categories[0].units.map(u => u.anchorId), ['w1', 'w2', 'w3'], 'in the window it stays in its category');

  await x.d.handle('star.set', { wsId: 'w3', kind: 0 });
  assert.deepEqual(ids(list), ['w1', 'w2', 'w3']);
  assert.equal(tok(list, 'w3', 'section'), undefined);
  assert.equal(tok(list, 'w1', 'section'), '━━ WORK ━━');

  assert.deepEqual(await x.d.handle('star.top', { kind: 1 }), { kind: 1, on: false, name: 'Main' });
  assert.deepEqual(store.loadJson(path.join(x.configDir, 'settings.json'), {}).starsOnTop, []);
  x.cleanup();
});

test('a starred worktree copy is detached to stand on top and stays apart under its project when the star is off', async () => {
  const list = [
    ws('w1', 'api', wt('api', false, 'C:\\p\\api')),
    ws('w2', 'cookie', wt('api', true, 'C:\\wt\\cookie')),
    ws('w3', 'blog'),
  ];
  const x = setup(list, {
    categories: [{ id: 'c1', name: 'Code', units: ['repo:c:/p/api/.git', 'ws:w3'] }], nextId: 2,
    stars: [{ kind: 1, target: { wsId: 'w2', label: 'cookie', path: 'c:/wt/cookie' } }],
  }, { starsOnTop: [1] });
  await x.d._test.cycle('t');
  const st = x.d._test.state();
  assert.deepEqual(x.calls, [['move', 'w2:p1', 'new_workspace']]);
  assert.deepEqual(Object.keys(st.detached), ['w10']);
  assert.equal(st.detached.w10.auto, true);
  assert.equal(st.stars[0].target.wsId, 'w10', 'the star went along');
  assert.deepEqual(ids(list), ['w10', 'w1', 'w3']);
  assert.equal(tok(list, 'w10', 'section'), '━━ ★ MAIN ━━');
  assert.equal(tok(list, 'w10', 'project'), '⎇ api');
  assert.equal(tok(list, 'w1', 'section'), '━━ CODE ━━');

  await assert.rejects(x.d.handle('unit.reattach', { wsId: 'w10' }), /Take the star off/);

  await x.d.handle('star.set', { wsId: 'w10', kind: 0 });
  assert.deepEqual(x.calls.slice(1), [], 'no second move');
  assert.deepEqual(Object.keys(x.d._test.state().detached), ['w10']);
  assert.deepEqual(ids(list), ['w1', 'w10', 'w3'], 'right under its project');
  assert.equal(tok(list, 'w1', 'section'), '━━ CODE ━━');
  assert.equal(tok(list, 'w10', 'project'), '⎇ api');

  assert.deepEqual(await x.d.handle('unit.reattach', { wsId: 'w10' }), { wsId: 'w11' }, 'w puts it back by hand');
  assert.deepEqual(x.calls.slice(1), [['open', 'w1', 'C:\\wt\\cookie'], ['move', 'w2:p1', 'new_tab']]);
  assert.deepEqual(x.d._test.state().detached, {});
  assert.deepEqual(ids(list), ['w1', 'w11', 'w3'], 'back in its project');
  x.cleanup();
});

test('a copy with the same star as its project goes up with the project; a copy detached by hand is left alone', async () => {
  const list = [
    ws('w3', 'blog'),
    ws('w1', 'api', wt('api', false, 'C:\\p\\api')),
    ws('w2', 'cookie', wt('api', true, 'C:\\wt\\cookie')),
    ws('w5', 'jam'),
  ];
  const x = setup(list, {
    categories: [{ id: 'c1', name: 'Code', units: ['ws:w3', 'repo:c:/p/api/.git', 'ws:w5'] }], nextId: 2,
    stars: [
      { kind: 1, target: { wsId: 'w1', label: 'api', path: 'c:/p/api' } },
      { kind: 1, target: { wsId: 'w2', label: 'cookie', path: 'c:/wt/cookie' } },
    ],
    detached: { w5: { checkout: 'C:\\wt\\jam', repoKey: 'c:/p/api/.git', repoRoot: 'C:\\p\\api', parentLabel: 'api', name: 'jam', at: 1 } },
  }, { starsOnTop: [1] });
  await x.d._test.cycle('t');
  assert.deepEqual(x.calls, [], 'nothing detached, nothing put back');
  assert.deepEqual(ids(list), ['w1', 'w2', 'w3', 'w5']);
  assert.equal(tok(list, 'w1', 'section'), '━━ ★ MAIN ━━');
  assert.ok(x.d._test.state().detached.w5, 'the copy detached by hand stays apart');
  x.cleanup();
});

test('a project with the star goes up alone: its copies without that star stay in the category under its place, in their order', async () => {
  const list = [
    ws('w1', 'api', wt('api', false, 'C:\p\api')),
    ws('w2', 'cookie', wt('api', true, 'C:\wt\cookie')),
    ws('w3', 'jam', wt('api', true, 'C:\wt\jam')),
    ws('w4', 'blog'),
    ws('w5', 'notes'),
  ];
  const x = setup(list, {
    categories: [{ id: 'c1', name: 'Code', units: ['ws:w5', 'repo:c:/p/api/.git', 'ws:w4'] }], nextId: 2,
    stars: [{ kind: 1, target: { wsId: 'w1', label: 'api', path: 'c:/p/api' } }],
  }, { starsOnTop: [1] });
  await x.d._test.cycle('t');
  const st = x.d._test.state();
  assert.deepEqual(x.calls, [['move', 'w2:p1', 'new_workspace'], ['move', 'w3:p1', 'new_workspace']]);
  assert.deepEqual(Object.keys(st.detached).sort(), ['w10', 'w11']);
  assert.ok(st.detached.w10.auto && st.detached.w11.auto);
  assert.deepEqual(st.categories[0].units, ['ws:w5', 'ws:w1', 'ws:w10', 'ws:w11', 'ws:w4'], 'the copies keep the project\'s place, cookie before jam');
  assert.deepEqual(ids(list), ['w1', 'w5', 'w10', 'w11', 'w4']);
  assert.equal(tok(list, 'w1', 'section'), '━━ ★ MAIN ━━');
  assert.equal(tok(list, 'w5', 'section'), '━━ CODE ━━');
  assert.equal(tok(list, 'w10', 'project'), '⎇ api');
  assert.equal(tok(list, 'w1', 'project'), undefined);
  await assert.rejects(x.d.handle('unit.reattach', { wsId: 'w10' }), /"api" stands at the top because of its star ★1/);

  await x.d.handle('star.set', { wsId: 'w1', kind: 0 });
  assert.deepEqual(x.calls.slice(2), [], 'no second move');
  assert.deepEqual(Object.keys(x.d._test.state().detached).sort(), ['w10', 'w11']);
  assert.deepEqual(ids(list), ['w5', 'w1', 'w10', 'w11', 'w4'], 'the project is back in its place, its copies under it');
  assert.equal(tok(list, 'w5', 'section'), '━━ CODE ━━');
  x.cleanup();
});

test('a copy the helper detached stays apart while its project is closed', async () => {
  const list = [ws('w5', 'jam'), ws('w6', 'blog')];
  const x = setup(list, {
    categories: [{ id: 'c1', name: 'Code', units: ['ws:w5', 'ws:w6'] }], nextId: 2,
    detached: { w5: { checkout: 'C:\wt\jam', repoKey: 'c:/p/api/.git', repoRoot: 'C:\p\api', parentLabel: 'api', name: 'jam', at: 1, auto: true } },
  }, { starsOnTop: [1] });
  await x.d._test.cycle('t');
  assert.deepEqual(x.calls, [], 'nothing to put it back into');
  assert.ok(x.d._test.state().detached.w5);
  assert.equal(tok(list, 'w5', 'project'), '⎇ api');
  x.cleanup();
});

test('a second workspace on the project\'s own folder, without the star, leaves the starred group and cannot be put back', async () => {
  const list = [
    ws('w1', 'team-ops', wt('ops', false, 'C:\p\ops')),
    ws('w2', 'AI-SDR', wt('ops', false, 'C:\p\ops')),
    ws('w3', 'pricing', wt('ops', true, 'C:\wt\pricing')),
    ws('w4', 'blog'),
  ];
  const x = setup(list, {
    categories: [{ id: 'c1', name: 'Code', units: ['repo:c:/p/ops/.git', 'ws:w4'] }], nextId: 2,
    stars: [
      { kind: 2, target: { wsId: 'w1', label: 'team-ops', path: 'c:/p/ops' } },
      { kind: 2, target: { wsId: 'w3', label: 'pricing', path: 'c:/wt/pricing' } },
    ],
  }, { starsOnTop: [2] });
  await x.d._test.cycle('t');
  const st = x.d._test.state();
  assert.deepEqual(x.calls, [['move', 'w2:p1', 'new_workspace']], 'only AI-SDR moves; pricing has the star and stays in the group');
  assert.deepEqual(st.detached.w10.twin, true);
  assert.equal(st.detached.w10.parentLabel, 'team-ops');
  assert.deepEqual(ids(list), ['w1', 'w3', 'w10', 'w4']);
  assert.equal(tok(list, 'w1', 'section'), '━━ ★ SECOND ━━');
  assert.equal(tok(list, 'w10', 'section'), '━━ CODE ━━');
  assert.equal(tok(list, 'w10', 'project'), '⎇ team-ops');

  await x.d.handle('star.set', { wsId: 'w1', kind: 0 });
  await assert.rejects(x.d.handle('unit.reattach', { wsId: 'w10' }), /cannot put it back/);
  assert.deepEqual(x.calls.slice(1), [['move', 'w3:p1', 'new_workspace']], 'now pricing goes up alone; AI-SDR stays where it is');
  x.cleanup();
});

// ---- herdr lists worktree copies on lines of their own ----

test('flat sidebar: nothing is detached; copies stand on their own lines under the project, and a new copy joins them', async () => {
  const list = [
    ws('w1', 'api', wt('api', false, 'C:\p\api')),
    ws('w2', 'cookie', wt('api', true, 'C:\wt\cookie')),
    ws('w3', 'jam', wt('api', true, 'C:\wt\jam')),
    ws('w4', 'blog'),
  ];
  const x = setup(list, {
    categories: [{ id: 'c1', name: 'Code', units: ['repo:c:/p/api/.git', 'ws:w4'] }], nextId: 2,
    stars: [{ kind: 1, target: { wsId: 'w1', label: 'api', path: 'c:/p/api' } }],
  }, { starsOnTop: [1] }, { flat: true });
  await x.d._test.cycle('t');
  assert.deepEqual(x.calls, [], 'no pane moves');
  assert.deepEqual(x.d._test.state().categories[0].units, ['ws:w1', 'ws:w2', 'ws:w3', 'ws:w4']);
  assert.deepEqual(ids(list), ['w1', 'w2', 'w3', 'w4']);
  assert.equal(tok(list, 'w1', 'section'), '━━ ★ MAIN ━━');
  assert.equal(tok(list, 'w2', 'section'), '━━ CODE ━━');
  assert.equal(tok(list, 'w2', 'project'), '⎇ api');
  assert.equal(tok(list, 'w1', 'project'), undefined);

  list.push(ws('w5', 'tea', wt('api', true, 'C:\wt\tea')));
  await x.d._test.cycle('t');
  assert.deepEqual(x.d._test.state().categories[0].units, ['ws:w1', 'ws:w2', 'ws:w3', 'ws:w5', 'ws:w4'], 'right after the copies already there');
  assert.deepEqual(ids(list), ['w1', 'w2', 'w3', 'w5', 'w4']);
  assert.equal(tok(list, 'w5', 'project'), '⎇ api');
  assert.deepEqual(x.calls, []);
  x.cleanup();
});

test('projectLabels: copies and a second workspace on the project folder show the project; with it closed, the repo name', () => {
  const lone = wt('lone', true, 'C:\wt\tea');
  lone.repo_name = 'lone';
  assert.deepEqual(model.projectLabels([
    ws('w1', 'team-ops', wt('ops', false, 'C:\p\ops')),
    ws('w2', 'AI-SDR', wt('ops', false, 'C:\p\ops')),
    ws('w3', 'pricing', wt('ops', true, 'C:\wt\pricing')),
    ws('w4', 'tea', lone),
    ws('w5', 'blog'),
  ]), { w2: 'team-ops', w3: 'team-ops', w4: 'lone' });
});

test('flat: the block asks herdr for lines of their own, and a refresh without it takes the line out', () => {
  const t1 = cp.patchConfig('', { flat: true }).text;
  assert.ok(t1.includes(`]\ngroup_worktrees = false\n${cp.END}`));
  const t2 = cp.refreshConfig(t1);
  assert.ok(!t2.includes('group_worktrees'));
  assert.equal(cp.refreshConfig(t1, { flat: true }), t1, 'the line is not taken for a row of the person');
});

test("a drag inside a star block stays: the block keeps the person's order; a newly starred one comes last", async () => {
  const list = [ws('w1', 'alpha'), ws('w2', 'beta'), ws('w3', 'gamma'), ws('w4', 'delta')];
  const star = (id, label) => ({ kind: 1, target: { wsId: id, label, path: `c:/p/${label}` } });
  const x = setup(list, {
    categories: [{ id: 'c1', name: 'Work', units: ['ws:w1', 'ws:w2', 'ws:w3', 'ws:w4'] }], nextId: 2,
    stars: [star('w1', 'alpha'), star('w2', 'beta'), star('w3', 'gamma')],
  }, { starsOnTop: [1] });
  await x.d._test.cycle('t');
  assert.deepEqual(ids(list), ['w1', 'w2', 'w3', 'w4']);
  list.unshift(list.splice(2, 1)[0]); // the person drags gamma to the top of the block
  await x.d._test.cycle('t');
  assert.deepEqual(ids(list), ['w3', 'w1', 'w2', 'w4'], 'not put back');
  assert.deepEqual(x.d._test.state().starOrder, { 1: ['ws:w3', 'ws:w1', 'ws:w2'] });
  assert.equal(tok(list, 'w3', 'section'), '━━ ★ MAIN ━━');
  assert.deepEqual(x.d._test.state().categories[0].units, ['ws:w1', 'ws:w2', 'ws:w3', 'ws:w4'], 'the category order is not touched');

  await x.d.handle('star.set', { wsId: 'w4', kind: 1 });
  assert.deepEqual(ids(list), ['w3', 'w1', 'w2', 'w4']);
  list.splice(1, 0, list.splice(3, 1)[0]); // delta between gamma and alpha
  await x.d._test.cycle('t');
  assert.deepEqual(ids(list), ['w3', 'w4', 'w1', 'w2']);
  x.cleanup();
});
