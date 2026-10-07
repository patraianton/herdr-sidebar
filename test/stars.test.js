'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stars = require('../src/stars');

const W = (id, label, focused = false) => ({ workspace_id: id, label, focused });
const star = (wsId, label, kind, path) => ({ kind, target: { wsId, label, path } });
const paths = { w1: 'C:/p/1', w2: 'C:/p/2', w3: 'C:/p/3', w4: 'C:/p/4', w5: 'C:/p/5' };

test('four kinds, Alt+1…Alt+4, each its own colour and a default name', () => {
  assert.deepEqual(stars.KINDS.map(k => k.kind), [1, 2, 3, 4]);
  assert.deepEqual(stars.KINDS.map(k => k.name), ['Main', 'Second', 'Third', 'Fourth']);
  assert.equal(new Set(stars.KINDS.map(k => k.color)).size, 4);
  assert.equal(stars.token(2), '★2');
});

test('inside a kind the key goes down the sidebar and round at the end', () => {
  const list = [star('w4', 'd', 2), star('w2', 'b', 2), star('w3', 'c', 1)];
  const ws = [W('w1', 'a'), W('w2', 'b', true), W('w3', 'c'), W('w4', 'd'), W('w5', 'e')];
  assert.equal(stars.nextStar(list, ws, paths, 2).workspace_id, 'w4', 'skips the other kind');
  ws[1].focused = false; ws[3].focused = true;
  assert.equal(stars.nextStar(list, ws, paths, 2).workspace_id, 'w2');
});

test('coming from another kind: back to the one visited last, else the first of the kind', () => {
  const list = [star('w2', 'b', 2), star('w4', 'd', 2), star('w1', 'a', 1)];
  const ws = [W('w1', 'a', true), W('w2', 'b'), W('w3', 'c'), W('w4', 'd')];
  assert.equal(stars.nextStar(list, ws, paths, 2, 'w4').workspace_id, 'w4');
  assert.equal(stars.nextStar(list, ws, paths, 2).workspace_id, 'w2');
  assert.equal(stars.nextStar(list, ws, paths, 2, 'w9').workspace_id, 'w2', 'the last one is closed');
  assert.equal(stars.nextStar(list, ws, paths, 2, 'w1').workspace_id, 'w2', 'the last one has another kind now');
});

test('a kind with nothing open gives null', () => {
  const ws = [W('w1', 'a', true), W('w2', 'b')];
  assert.equal(stars.nextStar([star('w9', 'gone', 3), star('w2', 'b', 2)], ws, paths, 3), null);
  assert.equal(stars.nextStar([], ws, paths, 1), null);
});

test('stars saved before kinds existed are «my project»', () => {
  const ws = [W('w1', 'a', true), W('w2', 'b')];
  assert.equal(stars.nextStar([{ target: { wsId: 'w2', label: 'b' } }], ws, paths, 1).workspace_id, 'w2');
  assert.equal(stars.starKinds([{ target: { wsId: 'w2', label: 'b' } }], ws, paths).get('w2'), 1);
});

test('after a herdr restart a star finds its project by name, and namesakes by folder', () => {
  const ws = [W('w1', 'other', true), W('w7', 'Ads'), W('w8', 'api'), W('w9', 'api')];
  const p = { w1: 'C:/q', w7: 'C:/ads', w8: 'C:/api-a', w9: 'C:/api-b' };
  assert.equal(stars.nextStar([star('w1', 'Ads', 1, 'c:/ads')], ws, p, 1).workspace_id, 'w7');
  assert.equal(stars.nextStar([star('w2', 'api', 1, 'c:/api-b')], ws, p, 1).workspace_id, 'w9');
});

test('starKinds: the open workspaces that carry a star, with its kind', () => {
  const ws = [W('w1', 'a'), W('w2', 'b'), W('w3', 'c')];
  const k = stars.starKinds([star('w3', 'c', 4), star('w9', 'gone', 2), star('w1', 'a', 2)], ws, paths);
  assert.deepEqual([...k], [['w3', 4], ['w1', 2]]);
});

test('review 2: closing a starred china-cars does not star the other china-cars', () => {
  const ws = [W('w1', 'x', true), W('w2', 'china-cars')];
  const p = { w1: 'C:/x', w2: 'C:/cars-b' };
  assert.equal(stars.nextStar([star('w5', 'china-cars', 1, 'c:/cars-a')], ws, p, 1), null);
});

test('the notice after Alt+0 says what happened and how to undo it', () => {
  assert.equal(stars.resetNote({ cleared: 8 }), 'All stars taken off (8). Bring them back: Alt+0 again.');
  assert.equal(stars.resetNote({ restored: 3 }), 'Stars are back (3).');
  assert.equal(stars.resetNote({}), 'No stars.');
});
