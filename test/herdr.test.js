'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { unwrapMove } = require('../src/herdr');

test('unwrapMove reads the pane.move result that herdr wraps in move_result', () => {
  const real = { type: 'pane_move', move_result: { changed: true, pane: { pane_id: 'wD:p1', workspace_id: 'wD' }, created_workspace: { workspace_id: 'wD' } } };
  assert.equal(unwrapMove(real).created_workspace.workspace_id, 'wD');
  assert.equal(unwrapMove(real).pane.pane_id, 'wD:p1');
  const flat = { changed: true, created_workspace: { workspace_id: 'wE' } };
  assert.equal(unwrapMove(flat).created_workspace.workspace_id, 'wE');
});
