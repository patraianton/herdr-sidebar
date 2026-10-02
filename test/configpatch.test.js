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
  assert.ok(t.includes('  [{ token = "$section", fg = "#fabd2f", bold = true }],\r\n  ["state_icon", "workspace"],'), 'title row first, then the plain name row');
  assert.ok(!t.includes('starts_with = "━━"'), 'no title-workspace styling');
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

// The live config of an older install: title workspaces were styled by name.
const OLD_BLOCK = [
  '[ui.sidebar.spaces]',
  cp.BEGIN,
  'rows = [',
  '  ["state_icon", { token = "workspace", rules = [{ starts_with = "━━", fg = "#fabd2f", bold = true }] }],',
  '  ["branch", "git_status"],',
  '  [{ token = "$project", dim = true }],',
  '  [{ token = "$duty", rules = [{ starts_with = "▲", fg = "#fb4934", bold = true }, { starts_with = "◆", fg = "#b8bb26" }] }],',
  '  ["$kran"],',
  ']',
  cp.END,
  '',
  '[update]',
  'channel = "stable"',
  '',
].join('\r\n');

test('refresh rewrites an older installed block to the current rows and keeps extra rows', () => {
  const t = cp.refreshConfig(OLD_BLOCK);
  assert.ok(t.includes('[{ token = "$section", fg = "#fabd2f", bold = true }]'));
  assert.ok(!t.includes('starts_with = "━━"'));
  assert.equal(t.split('["$kran"]').length - 1, 1);
  assert.equal(t.split('token = "$duty"').length - 1, 1);
  assert.equal(t.split('["branch", "git_status"]').length - 1, 1);
  assert.ok(t.includes('[update]\r\nchannel = "stable"'), 'keeps CRLF and the rest');
  assert.equal(cp.refreshConfig(t), t, 'a second refresh changes nothing');
});

test('refresh of a fresh install changes nothing, and uninstall after a refresh restores the original', () => {
  const r = cp.patchConfig(ANTON);
  assert.equal(cp.refreshConfig(r.text), r.text);
  const old = r.text.replace(/\[\{ token = "\$section"[^\r\n]*\r\n/, '');
  assert.notEqual(old, r.text);
  assert.equal(cp.unpatchConfig(cp.refreshConfig(old), r), ANTON);
});

test('refresh refuses a config without the plugin block', () => {
  assert.throws(() => cp.refreshConfig(ANTON), /not installed/);
});

