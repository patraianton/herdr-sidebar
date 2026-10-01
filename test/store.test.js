'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');

test('saveJson writes atomically and loadJson reads back, tolerating BOM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-'));
  const f = path.join(dir, 'a', 'b.json');
  store.saveJson(f, { x: 1 });
  assert.deepEqual(store.loadJson(f, null), { x: 1 });
  store.saveJson(f, { x: 2 });
  assert.deepEqual(store.loadJson(f, null), { x: 2 });
  fs.writeFileSync(f, '\uFEFF{"y":3}');
  assert.deepEqual(store.loadJson(f, null), { y: 3 });
  assert.equal(store.loadJson(path.join(dir, 'missing.json'), 'fb'), 'fb');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'a')), ['b.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadState fills missing fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ categories: [{ id: 'c1', name: 'A', units: [] }] }));
  const s = store.loadState(f);
  assert.equal(s.categories.length, 1);
  assert.deepEqual(s.headers, {});
  assert.deepEqual(s.duty, {});
  assert.equal(s.nextId, 1);
  assert.deepEqual(store.loadState(path.join(dir, 'nope.json')), store.emptyState());
  fs.rmSync(dir, { recursive: true, force: true });
});
