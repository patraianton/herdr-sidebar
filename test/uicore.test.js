'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../src/uicore');

const unit = (key, extra = {}) => ({ key, kind: 'ws', label: key, anchorId: key.slice(3), wsIds: [key.slice(3)], children: [], duty: [], agents: [], ...extra });
const VIEW = {
  ready: true,
  categories: [
    { id: 'c1', name: 'A', units: [unit('ws:w1'), unit('repo:r', { kind: 'group', anchorId: 'w2', wsIds: ['w2', 'w4'], children: [{ wsId: 'w4', label: 'cookie', duty: [], agents: [] }] })] },
    { id: 'c2', name: 'B', units: [] },
    { id: '__none', name: 'NO CATEGORY', units: [unit('ws:w3')] },
  ],
};

test('flattenRows with and without an expanded group', () => {
  let rows = ui.flattenRows(VIEW, new Set());
  assert.deepEqual(rows.map(ui.rowId), ['cat:c1', 'unit:ws:w1', 'unit:repo:r', 'cat:c2', 'cat:__none', 'unit:ws:w3']);
  rows = ui.flattenRows(VIEW, new Set(['repo:r']));
  assert.deepEqual(rows.map(ui.rowId), ['cat:c1', 'unit:ws:w1', 'unit:repo:r', 'child:w4', 'cat:c2', 'cat:__none', 'unit:ws:w3']);
  assert.equal(rows[0].count, 2);
});

test('stepTarget moves inside a category and across its edges', () => {
  assert.deepEqual(ui.stepTarget(VIEW, 'c1', 0, 1), { catId: 'c1', index: 1 });
  assert.deepEqual(ui.stepTarget(VIEW, 'c1', 1, 1), { catId: 'c2', index: 0 });
  assert.deepEqual(ui.stepTarget(VIEW, 'c1', 0, -1), null);
  assert.deepEqual(ui.stepTarget(VIEW, '__none', 0, -1), { catId: 'c2', index: 0 });
  assert.deepEqual(ui.stepTarget(VIEW, 'c2', 0, 1), { catId: '__none', index: 0 });
});

test('dropTarget: onto a header, onto a unit, onto a child', () => {
  const rows = ui.flattenRows(VIEW, new Set(['repo:r']));
  const from = rows[1]; // ws:w1
  assert.deepEqual(ui.dropTarget(VIEW, from, rows[3]), { catId: 'c1', index: 1 });
  assert.deepEqual(ui.dropTarget(VIEW, from, rows[4]), { catId: 'c2', index: 0 });
  assert.deepEqual(ui.dropTarget(VIEW, from, rows[6]), { catId: '__none', index: 0 });
  assert.deepEqual(ui.dropTarget(VIEW, from, rows[2]), { catId: 'c1', index: 1 });
});

test('locateWs finds units and children', () => {
  assert.deepEqual(ui.locateWs(VIEW, 'w4'), { unitKey: 'repo:r', child: true });
  assert.deepEqual(ui.locateWs(VIEW, 'w2'), { unitKey: 'repo:r', child: false });
  assert.deepEqual(ui.locateWs(VIEW, 'w3'), { unitKey: 'ws:w3', child: false });
  assert.equal(ui.locateWs(VIEW, 'w99'), null);
});

test('parseInput: arrows, modified arrows, keys, utf-8, mouse', () => {
  assert.deepEqual(ui.parseInput('\x1b[A\x1b[B'), [{ key: 'up' }, { key: 'down' }]);
  assert.deepEqual(ui.parseInput('\x1b[1;2A'), [{ key: 'up', shift: true, alt: false, ctrl: false }]);
  assert.deepEqual(ui.parseInput('\x1b[1;3B'), [{ key: 'down', shift: false, alt: true, ctrl: false }]);
  assert.deepEqual(ui.parseInput('\r\x7f\x1b'), [{ key: 'enter' }, { key: 'backspace' }, { key: 'escape' }]);
  assert.deepEqual(ui.parseInput('nЖ'), [{ char: 'n' }, { char: 'Ж' }]);
  assert.deepEqual(ui.parseInput('\x1b[5~\x1b[6~'), [{ key: 'pageup' }, { key: 'pagedown' }]);
  assert.deepEqual(ui.parseInput('\x1b[<0;10;5M\x1b[<0;10;7m'), [
    { mouse: { button: 0, wheel: null, motion: false, release: false, x: 10, y: 5 } },
    { mouse: { button: 0, wheel: null, motion: false, release: true, x: 10, y: 7 } },
  ]);
  assert.equal(ui.parseInput('\x1b[<64;3;3M')[0].mouse.wheel, 'up');
  assert.equal(ui.parseInput('\x1b[<65;3;3M')[0].mouse.wheel, 'down');
  assert.equal(ui.parseInput('\x1b[<32;3;3M')[0].mouse.motion, true);
  assert.deepEqual(ui.parseInput('\x1b[?25h'), [], 'unknown control sequences are skipped');
  assert.deepEqual(ui.parseInput('\x03'), [{ key: 'ctrl-c' }]);
});

test('latin maps the russian layout to command letters', () => {
  assert.equal(ui.latin('т'), 'n');
  assert.equal(ui.latin('О'), 'J');
  assert.equal(ui.latin('q'), 'q');
});

test('fit truncates with an ellipsis and pads', () => {
  assert.equal(ui.fit('abc', 5), 'abc  ');
  assert.equal(ui.fit('abcdef', 4), 'abc…');
  assert.equal(ui.fit('abc', 0), '');
});
