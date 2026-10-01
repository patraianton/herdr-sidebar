'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('../src/configpatch');

const ANTON = [
  'onboarding = false',
  '[ui]',
  'status_indicators = "symbols"',
  '',
  '# comment kept',
  '[ui.sidebar.spaces]',
  'rows = [',
  '  ["state_icon", "workspace"],',
  '  ["branch", "git_status"],',
  '  ["$kran"],',
  ']',
  '',
  '[update]',
  'channel = "stable"',
  '',
  '[[keys.command]]',
  'key = "prefix+a"',
  'type = "plugin_action"',
  'command = "annotate.capture"',
  '',
].join('\r\n');

test('patch replaces rows, keeps $kran and other content, adds the key binding', () => {
  const r = cp.patchConfig(ANTON);
  assert.equal(r.hadTable, true);
  assert.match(r.originalRows, /^rows = \[/);
  assert.ok(r.text.includes('\r\n'), 'keeps CRLF');
  const t = r.text;
  assert.ok(t.includes(cp.BEGIN) && t.includes(cp.END));
  assert.ok(t.includes('starts_with = "━━", fg = "#fabd2f", bold = true'));
  assert.ok(t.includes('[{ token = "$project", dim = true }],'));
  assert.ok(t.includes('token = "$duty"'));
  assert.ok(t.includes('  ["$kran"],'));
  assert.equal(t.match(/\["branch", "git_status"\]/g).length, 1);
  assert.ok(t.includes('key = "prefix+shift+s"'));
  assert.ok(t.includes('command = "anton.sidebar.open"'));
  assert.ok(t.includes('# comment kept') && t.includes('[update]') && t.includes('annotate.capture'));
  const rowsAt = t.indexOf('rows = [');
  assert.ok(rowsAt > t.indexOf('[ui.sidebar.spaces]') && rowsAt < t.indexOf('[update]'), 'rows stay in their table');
});

test('unpatch returns exactly the original text', () => {
  const r = cp.patchConfig(ANTON);
  assert.equal(cp.unpatchConfig(r.text, r), ANTON);
});

test('second patch is refused', () => {
  const r = cp.patchConfig(ANTON);
  assert.throws(() => cp.patchConfig(r.text), /already installed/);
});

test('rows written on one line are understood', () => {
  const src = '[ui.sidebar.spaces]\nrows = [["state_icon", "workspace"], ["branch", "git_status"], ["$kran", "$x"]]\n';
  const r = cp.patchConfig(src);
  assert.ok(r.text.includes('  ["$kran", "$x"],'));
  assert.equal(cp.unpatchConfig(r.text, r), src);
});

test('a bracket inside a string does not confuse the parser', () => {
  const src = '[ui.sidebar.spaces]\nrows = [\n  ["state_icon", "workspace"],\n  [{ token = "$a", rules = [{ equals = "]", fg = "#fff" }] }],\n]\n[next]\nx = 1\n';
  const r = cp.patchConfig(src);
  assert.ok(r.text.includes('[{ token = "$a", rules = [{ equals = "]", fg = "#fff" }] }],'));
  assert.ok(r.text.includes('[next]\nx = 1'));
  assert.equal(cp.unpatchConfig(r.text, r), src);
});

test('no sidebar table: one is added and removed again', () => {
  const src = 'onboarding = false\n';
  const r = cp.patchConfig(src);
  assert.equal(r.hadTable, false);
  assert.equal(r.originalRows, null);
  assert.ok(r.text.includes('[ui.sidebar.spaces]'));
  assert.equal(cp.unpatchConfig(r.text, r), src);
});

test('table without rows: rows are added under it and removed again', () => {
  const src = '[ui.sidebar.spaces]\n\n[update]\nchannel = "stable"\n';
  const r = cp.patchConfig(src);
  assert.ok(r.text.indexOf(cp.BEGIN) < r.text.indexOf('[update]'));
  assert.equal(cp.unpatchConfig(r.text, r), src);
});
