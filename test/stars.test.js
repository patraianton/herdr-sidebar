'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stars = require('../src/stars');

const W = (id, label, focused = false) => ({ workspace_id: id, label, focused });
const star = (wsId, label, path) => ({ target: { wsId, label, path } });
const paths = { w1: 'C:/p/1', w2: 'C:/p/2', w3: 'C:/p/3', w4: 'C:/p/4', w5: 'C:/p/5' };

test('next goes down the sidebar to the next starred project and round at the end', () => {
  const list = [star('w4', 'd'), star('w2', 'b')];
  const ws = [W('w1', 'a'), W('w2', 'b'), W('w3', 'c', true), W('w4', 'd'), W('w5', 'e')];
  assert.equal(stars.nextStar(list, ws, paths).workspace_id, 'w4');
  ws[2].focused = false; ws[3].focused = true;
  assert.equal(stars.nextStar(list, ws, paths).workspace_id, 'w2', 'from the last one back to the first');
});

test('from a project without a star the next starred one below is taken', () => {
  const ws = [W('w1', 'a', true), W('w2', 'b'), W('w3', 'c')];
  assert.equal(stars.nextStar([star('w3', 'c')], ws, paths).workspace_id, 'w3');
  assert.equal(stars.nextStar([star('w1', 'a')], [W('w1', 'a'), W('w2', 'b', true)], paths).workspace_id, 'w1');
});

test('nothing focused: the first starred project', () => {
  const ws = [W('w1', 'a'), W('w2', 'b'), W('w3', 'c')];
  assert.equal(stars.nextStar([star('w3', 'c'), star('w2', 'b')], ws, paths).workspace_id, 'w2');
});

test('a single star that is already open stays where it is', () => {
  const ws = [W('w1', 'a'), W('w2', 'b', true)];
  assert.equal(stars.nextStar([star('w2', 'b')], ws, paths).workspace_id, 'w2');
});

test('closed starred projects are skipped; none open gives null', () => {
  const ws = [W('w1', 'a', true), W('w2', 'b')];
  assert.equal(stars.nextStar([star('w9', 'gone'), star('w2', 'b')], ws, paths).workspace_id, 'w2');
  assert.equal(stars.nextStar([star('w9', 'gone')], ws, paths), null);
  assert.equal(stars.nextStar([], ws, paths), null);
});

test('after a herdr restart a star finds its project by name, and namesakes by folder', () => {
  const ws = [W('w1', 'other', true), W('w7', 'Ads'), W('w8', 'api'), W('w9', 'api')];
  const p = { w1: 'C:/q', w7: 'C:/ads', w8: 'C:/api-a', w9: 'C:/api-b' };
  assert.equal(stars.nextStar([star('w1', 'Ads', 'c:/ads')], ws, p).workspace_id, 'w7');
  assert.equal(stars.nextStar([star('w2', 'api', 'c:/api-b')], ws, p).workspace_id, 'w9');
});

test('starredIds: the open workspaces that carry a star', () => {
  const ws = [W('w1', 'a'), W('w2', 'b'), W('w3', 'c')];
  assert.deepEqual([...stars.starredIds([star('w3', 'c'), star('w9', 'gone')], ws, paths)], ['w3']);
});

test('review 2: closing a starred china-cars does not star the other china-cars', () => {
  const ws = [W('w1', 'x', true), W('w2', 'china-cars')];
  const p = { w1: 'C:/x', w2: 'C:/cars-b' };
  assert.equal(stars.nextStar([star('w5', 'china-cars', 'c:/cars-a')], ws, p), null);
});
