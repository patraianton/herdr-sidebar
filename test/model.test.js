'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/model');
const { emptyState } = require('../src/store');

const ws = (id, label, worktree) => ({ workspace_id: id, label, worktree });
const wt = (repo, linked, checkout) => ({
  repo_key: `C:\\p\\${repo}\\.git`, repo_root: `C:\\p\\${repo}`, is_linked_worktree: linked, checkout_path: checkout,
});
const AP = 'repo:c:/p/autopase/.git';

function world() {
  return [
    ws('w1', 'fix-pc'),
    ws('w2', 'autopase', wt('autopase', false, 'C:\\p\\autopase')),
    ws('w3', 'blog'),
    ws('w4', 'cookie', wt('autopase', true, 'C:\\wt\\cookie')),
    ws('w5', 'lonely', wt('lonely', true, 'C:\\wt\\lonely')),
  ];
}
const PATHS = { w1: 'C:\\p\\fix-pc', w3: 'C:\\p\\blog' };

function withHeaders(list, headers) {
  // headers: [[wsId, label]] appended at the start
  return [...headers.map(([id, label]) => ws(id, label)), ...list];
}

test('header labels', () => {
  assert.equal(model.headerLabel(' Реклама 24/7 '), '━━ РЕКЛАМА 24/7 ━━');
  assert.ok(model.isHeaderLabel('━━ РЕКЛАМА ━━'));
  assert.ok(model.isHeaderLabel(model.NONE_LABEL));
  assert.ok(!model.isHeaderLabel('━━ broken'));
  assert.ok(!model.isHeaderLabel('autopase'));
});

test('buildUnits groups a repo with a parent and draws it at the first member', () => {
  const u = model.buildUnits(world(), PATHS, new Set());
  assert.deepEqual(u.units.map(x => x.key), ['ws:w1', AP, 'ws:w3', 'ws:w5']);
  assert.deepEqual(u.byKey[AP].wsIds, ['w2', 'w4']);
  assert.equal(u.byKey[AP].label, 'autopase');
  assert.equal(u.byKey[AP].path, 'c:/p/autopase');
  assert.deepEqual(u.byKey[AP].children.map(c => c.wsId), ['w4']);
  assert.equal(u.unitOf.w4, AP);
  assert.equal(u.byKey['ws:w5'].linked, true);
  assert.equal(u.byKey['ws:w1'].path, 'c:/p/fix-pc');
  assert.equal(u.byKey['ws:w5'].path, 'c:/wt/lonely');
});

test('buildUnits: child listed before its parent still forms one group led by the parent', () => {
  const list = [ws('w4', 'cookie', wt('autopase', true, 'C:\\wt\\cookie')), ws('w2', 'autopase', wt('autopase', false, 'C:\\p\\autopase'))];
  const u = model.buildUnits(list, {}, new Set());
  assert.deepEqual(u.units.map(x => x.key), [AP]);
  assert.deepEqual(u.byKey[AP].wsIds, ['w2', 'w4']);
});

test('buildUnits excludes header workspaces', () => {
  const list = withHeaders(world(), [['h1', '━━ A ━━']]);
  const u = model.buildUnits(list, PATHS, new Set(['h1']));
  assert.ok(!u.unitOf.h1);
  assert.equal(u.units.length, 4);
});

test('desiredOrder is null without categories', () => {
  const u = model.buildUnits(world(), PATHS, new Set());
  assert.equal(model.desiredOrder(emptyState(), u, ['w1', 'w2', 'w3', 'w4', 'w5']), null);
});

test('desiredOrder: category members in order, then the rest in live order', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w3', AP] }, { id: 'c2', name: 'B', units: [] }];
  const u = model.buildUnits(world(), PATHS, new Set());
  assert.deepEqual(model.desiredOrder(s, u, ['w1', 'w2', 'w3', 'w4', 'w5']), ['w3', 'w2', 'w4', 'w1', 'w5']);
});

// ---- category titles drawn as a row of the first project ----

test('sectionTokens: the first project of each category and of the rest carries the title', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'Реклама', units: ['ws:w3', 'ws:w1'] }, { id: 'c2', name: 'Пусто', units: [] }, { id: 'c3', name: 'Код', units: [AP] }];
  const u = model.buildUnits(world(), PATHS, new Set());
  assert.deepEqual(model.sectionTokens(s, u, ['w3', 'w1', 'w2', 'w4', 'w5']), {
    w3: '━━ РЕКЛАМА ━━', w2: '━━ КОД ━━', w5: model.NONE_LABEL,
  });
});

test('sectionTokens: a group carries the title on its parent even when a child comes first', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'Код', units: [AP] }];
  const u = model.buildUnits(world(), PATHS, new Set());
  assert.equal(model.sectionTokens(s, u, ['w4', 'w2', 'w1', 'w3', 'w5']).w2, '━━ КОД ━━');
});

test('sectionTokens: no categories, no titles; nothing left over, no "none" title', () => {
  const u = model.buildUnits(world(), PATHS, new Set());
  assert.deepEqual(model.sectionTokens(emptyState(), u, ['w1', 'w2', 'w3', 'w4', 'w5']), {});
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'Все', units: ['ws:w1', AP, 'ws:w3', 'ws:w5'] }];
  assert.deepEqual(model.sectionTokens(s, u, ['w1', 'w2', 'w4', 'w3', 'w5']), { w1: '━━ ВСЕ ━━' });
});

test('reconcile re-binds a closed and reopened workspace by folder', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w9'] }];
  s.units['ws:w9'] = { path: 'c:/p/blog', label: 'blog', seen: 1 };
  const u = model.buildUnits(world(), PATHS, new Set());
  const r = model.reconcile(s, u, 100);
  assert.deepEqual(r.categories[0].units, ['ws:w3']);
  assert.equal(r.units['ws:w3'].seen, 100);
  assert.ok(!r.units['ws:w9']);
  assert.deepEqual(s.categories[0].units, ['ws:w9'], 'input state is not mutated');
});

test('reconcile drops a reused workspace id (other label and other folder)', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w1'] }];
  s.units['ws:w1'] = { path: 'c:/p/something-else', label: 'other', seen: 1 };
  const u = model.buildUnits(world(), PATHS, new Set());
  const r = model.reconcile(s, u, 5);
  assert.deepEqual(r.categories[0].units, []);
});

test('reconcile keeps a renamed workspace (same folder)', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w1'] }];
  s.units['ws:w1'] = { path: 'c:/p/fix-pc', label: 'old name', seen: 1 };
  const r = model.reconcile(s, model.buildUnits(world(), PATHS, new Set()), 5);
  assert.deepEqual(r.categories[0].units, ['ws:w1']);
  assert.equal(r.units['ws:w1'].label, 'fix-pc');
});

test('reconcile: a group takes the slot of its member that was placed alone', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w3', 'ws:w2'] }];
  const r = model.reconcile(s, model.buildUnits(world(), PATHS, new Set()), 5);
  assert.deepEqual(r.categories[0].units, ['ws:w3', AP]);
});

test('reconcile: a dissolved group is replaced by its remaining members', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: [AP] }];
  const list = [ws('w4', 'cookie', wt('autopase', true, 'C:\\wt\\cookie')), ws('w1', 'fix-pc')];
  const r = model.reconcile(s, model.buildUnits(list, PATHS, new Set()), 5);
  assert.deepEqual(r.categories[0].units, ['ws:w4']);
});

test('reconcile keeps a dead key for a while and prunes it after 30 days', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w77'] }];
  s.units['ws:w77'] = { path: 'c:/gone', label: 'gone', seen: 0 };
  const u = model.buildUnits(world(), PATHS, new Set());
  assert.deepEqual(model.reconcile(s, u, 1000).categories[0].units, ['ws:w77']);
  assert.deepEqual(model.reconcile(s, u, 31 * 24 * 3600 * 1000).categories[0].units, []);
});

// ---- learning from native drags ----
// X: [w1, w6]   Y: [w3]   the rest: autopase group (w2 + w4), w5.
// The sidebar shows "━━ X ━━" on w1, "━━ Y ━━" on w3 and the "none" title on w2.

const LPATHS = { ...PATHS, w6: 'C:\p\notes' };
function setup() {
  const s = emptyState();
  s.categories = [{ id: 'cX', name: 'X', units: ['ws:w1', 'ws:w6'] }, { id: 'cY', name: 'Y', units: ['ws:w3'] }];
  const list = [
    ws('w1', 'fix-pc'), ws('w6', 'notes'), ws('w3', 'blog'),
    ws('w2', 'autopase', wt('autopase', false, 'C:\p\autopase')), ws('w4', 'cookie', wt('autopase', true, 'C:\wt\cookie')),
    ws('w5', 'lonely', wt('lonely', true, 'C:\wt\lonely')),
  ];
  s.lastApplied = list.map(w => w.workspace_id);
  const byId = Object.fromEntries(list.map(w => [w.workspace_id, w]));
  return { s, byId };
}
const learn = ({ s, byId }, order, hints) => {
  const units = model.buildUnits(order.map(id => byId[id]), LPATHS, new Set());
  return model.learnFromOrder(s, units, order, hints);
};
const cats = r => r.state.categories.map(c => c.units);

test('learn: nothing moved', () => {
  const x = setup();
  const r = learn(x, x.s.lastApplied);
  assert.deepEqual(r.moved, []);
  assert.equal(r.state, x.s);
});

test('learn: new and closed workspaces are not a user move', () => {
  const x = setup();
  x.byId.w9 = ws('w9', 'new');
  const r = learn(x, ['w1', 'w3', 'w2', 'w4', 'w5', 'w9']);
  assert.deepEqual(r.moved, []);
});

test('learn: a project dropped after a project of another category joins that category', () => {
  const x = setup();
  const r = learn(x, ['w6', 'w3', 'w1', 'w2', 'w4', 'w5']);
  assert.deepEqual(r.moved, ['ws:w1']);
  assert.deepEqual(cats(r), [['ws:w6'], ['ws:w3', 'ws:w1']]);
});

test('learn: dropped right above the first project of a category, it lands above that title: the category above', () => {
  const x = setup();
  const r = learn(x, ['w1', 'w6', 'w5', 'w3', 'w2', 'w4']);
  assert.deepEqual(r.moved, ['ws:w5']);
  assert.deepEqual(cats(r), [['ws:w1', 'ws:w6', 'ws:w5'], ['ws:w3']]);
});

test('learn: dropped at the very top joins the first category at its top', () => {
  const x = setup();
  const r = learn(x, ['w3', 'w1', 'w6', 'w2', 'w4', 'w5']);
  assert.deepEqual(cats(r), [['ws:w3', 'ws:w1', 'ws:w6'], []]);
});

test('learn: a group dragged from the rest into a category', () => {
  const x = setup();
  const r = learn(x, ['w1', 'w2', 'w4', 'w6', 'w3', 'w5']);
  assert.deepEqual(r.moved, [AP]);
  assert.deepEqual(cats(r), [['ws:w1', AP, 'ws:w6'], ['ws:w3']]);
});

test('learn: dropped among the rest becomes uncategorized', () => {
  const x = setup();
  const r = learn(x, ['w1', 'w3', 'w2', 'w4', 'w5', 'w6']);
  assert.deepEqual(cats(r), [['ws:w1'], ['ws:w3']]);
});

test('learn: the moved workspace reported by herdr decides a swap across a category border', () => {
  const order = ['w1', 'w3', 'w6', 'w2', 'w4', 'w5'];
  assert.deepEqual(cats(learn(setup(), order, ['w3'])), [['ws:w1', 'ws:w3', 'ws:w6'], []]);
  assert.deepEqual(cats(learn(setup(), order, ['w6'])), [['ws:w1'], ['ws:w3', 'ws:w6']]);
});

test('learn: a reported move of a group member counts for the whole group', () => {
  const x = setup();
  const r = learn(x, ['w1', 'w6', 'w2', 'w4', 'w3', 'w5'], ['w2', 'w4']);
  assert.deepEqual(r.moved, [AP]);
  assert.deepEqual(cats(r), [['ws:w1', 'ws:w6', AP], ['ws:w3']]);
});

test('learn: reorder inside a category', () => {
  const x = setup();
  const r = learn(x, ['w6', 'w1', 'w3', 'w2', 'w4', 'w5']);
  assert.deepEqual(cats(r)[0], ['ws:w6', 'ws:w1']);
});

test('learn: does nothing without categories or without a previous order', () => {
  const x = setup();
  x.s.lastApplied = null;
  assert.deepEqual(learn(x, ['w1']).moved, []);
  const y = setup();
  y.s.categories = [];
  assert.deepEqual(learn(y, ['w6', 'w1', 'w3', 'w2', 'w4', 'w5']).moved, []);
});

test('reconcile keeps a workspace that stayed open while cd changed its folder and name', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w1'] }];
  s.units['ws:w1'] = { path: 'c:/p/foo', label: 'foo', seen: 50 };
  s.lastCycleAt = 50;
  const r = model.reconcile(s, model.buildUnits(world(), PATHS, new Set()), 60, { continuous: true });
  assert.deepEqual(r.categories[0].units, ['ws:w1']);
  assert.equal(r.units['ws:w1'].label, 'fix-pc');
  assert.equal(r.lastCycleAt, 60);
});

test('reconcile treats a changed id as reused after a gap', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w1'] }];
  s.units['ws:w1'] = { path: 'c:/p/foo', label: 'foo', seen: 40 };
  s.lastCycleAt = 50; // absent in the last cycle
  const u = model.buildUnits(world(), PATHS, new Set());
  assert.deepEqual(model.reconcile(s, u, 60, { continuous: true }).categories[0].units, []);
  s.units['ws:w1'].seen = 50; // present, but the helper just started
  assert.deepEqual(model.reconcile(s, u, 60, { continuous: false }).categories[0].units, []);
});

test('reconcile: a group does not inherit the slot of a stale key whose id was reused', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w4'] }];
  s.units['ws:w4'] = { path: 'c:/old/thing', label: 'old', seen: 1 };
  const r = model.reconcile(s, model.buildUnits(world(), PATHS, new Set()), 5);
  assert.ok(!r.categories[0].units.includes(AP));
});

test('reconcile: a group inherits the slot of its own member placed alone before', () => {
  const s = emptyState();
  s.categories = [{ id: 'c1', name: 'A', units: ['ws:w4'] }];
  s.units['ws:w4'] = { path: 'c:/wt/cookie', label: 'cookie', seen: 1 };
  const r = model.reconcile(s, model.buildUnits(world(), PATHS, new Set()), 5);
  assert.deepEqual(r.categories[0].units, [AP]);
});

test('staleDetached: after a gap, a detached record on a workspace with another name and folder is stale', () => {
  const detached = { w1: { name: 'cookie', checkout: 'C:/wt/cookie' }, w3: { name: 'blog', checkout: 'C:/x' }, w5: { name: 'zzz', checkout: 'C:/wt/lonely' } };
  assert.deepEqual(model.staleDetached(detached, world(), PATHS), ['w1']);
});
