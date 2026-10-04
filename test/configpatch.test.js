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

// The name row: a star coloured by its kind, the name, the hotkeys.
const NAME_ROW = '["state_icon", { token = "$star", rules = [{ starts_with = "★1", fg = "#fabd2f" }, { starts_with = "★2", fg = "#8ec07c" }, '
  + '{ starts_with = "★3", fg = "#d3869b" }, { starts_with = "★4", fg = "#fe8019" }] }, "workspace", { token = "$key", fg = "#83a598" }]';
const STAR_ROW_V1 = '["state_icon", { token = "$star", fg = "#fabd2f" }, "workspace", { token = "$key", fg = "#83a598" }]';

test('patch replaces rows, keeps $kran and other content, adds the key binding', () => {
  const r = cp.patchConfig(ANTON);
  assert.equal(r.hadTable, true);
  assert.match(r.originalRows, /^rows = \[/);
  assert.ok(r.text.includes('\r\n'), 'keeps CRLF');
  const t = r.text;
  assert.ok(t.includes(cp.BEGIN) && t.includes(cp.END));
  assert.ok(t.includes(`  [{ token = "$section", fg = "#fabd2f", bold = true }],\r\n  ${NAME_ROW},`), 'title row first, then the name row with its star and hotkey');
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


test('setKeysBlock puts hotkey bindings after the window binding and keeps the rest', () => {
  const r = cp.patchConfig(ANTON);
  const extra = ['[[keys.command]]', 'key = "alt+1"', 'type = "plugin_action"', 'command = "anton.sidebar.jump-1"'];
  const t = cp.setKeysBlock(r.text, extra);
  assert.ok(t.includes('\r\n'), 'keeps CRLF');
  const b = t.indexOf(cp.KEYS_BEGIN);
  const e = t.indexOf(cp.KEYS_END);
  assert.ok(t.indexOf('anton.sidebar.open') > b && t.indexOf('anton.sidebar.jump-1') > t.indexOf('anton.sidebar.open'));
  assert.ok(t.indexOf('anton.sidebar.jump-1') < e);
  assert.ok(t.includes('annotate.capture'));
  const t2 = cp.setKeysBlock(t, []);
  assert.ok(!t2.includes('jump-1'), 'replacing again drops the old hotkeys');
  assert.equal(t2, r.text);
  assert.equal(cp.unpatchConfig(t, r), ANTON, 'uninstall removes the hotkeys too');
  assert.throws(() => cp.setKeysBlock(ANTON, extra), /not installed/);
});

test('refresh turns the old plain name row into the row with the star and the hotkey', () => {
  const old = cp.patchConfig(ANTON).text.replace(NAME_ROW, '["state_icon", "workspace"]');
  assert.ok(!old.includes('$key') && !old.includes('$star'));
  const t = cp.refreshConfig(old);
  assert.equal(t.match(/"state_icon"/g).length, 1);
  assert.ok(t.includes('{ token = "$key"'));
  assert.ok(t.includes('  ["$kran"],'));
});

test('the keys block carries Alt+1…Alt+4, one key per kind of star', () => {
  const t = cp.patchConfig(ANTON).text;
  const block = t.slice(t.indexOf(cp.KEYS_BEGIN), t.indexOf(cp.KEYS_END));
  assert.deepEqual(cp.STAR_KEYS, ['alt+1', 'alt+2', 'alt+3', 'alt+4']);
  cp.STAR_KEYS.forEach((k, i) => {
    assert.ok(block.includes(`key = "${k}"\r\ntype = "plugin_action"\r\ncommand = "anton.sidebar.star-${i + 1}"`), k);
  });
  assert.ok(!block.includes('backtick') && !block.includes('alt+ё'));
});

test('refresh turns the name row with the hotkey into the row with the star', () => {
  const old = cp.patchConfig(ANTON).text.replace(NAME_ROW, '["state_icon", "workspace", { token = "$key", fg = "#83a598" }]');
  assert.ok(!old.includes('$star'));
  const t = cp.refreshConfig(old);
  assert.equal(t.match(/"state_icon"/g).length, 1);
  assert.ok(t.includes(NAME_ROW));
});

test('refresh turns the one-colour star row into the row with a colour per kind and drops Alt+`', () => {
  const r = cp.patchConfig(ANTON);
  const b = r.text.indexOf(cp.KEYS_BEGIN);
  const e = r.text.indexOf(cp.KEYS_END);
  const v1Keys = ['alt+backtick', 'alt+ё'].flatMap(k => ['[[keys.command]]', `key = "${k}"`, 'type = "plugin_action"',
    'command = "anton.sidebar.star-next"', 'description = "следующий проект со звёздочкой"']);
  const old = (r.text.slice(0, b) + [cp.KEYS_BEGIN, '[[keys.command]]', 'key = "prefix+shift+s"', 'type = "plugin_action"',
    'command = "anton.sidebar.open"', 'description = "категории и дежурства"', ...v1Keys].join('\r\n') + '\r\n' + r.text.slice(e))
    .replace(NAME_ROW, STAR_ROW_V1);
  assert.ok(old.includes('star-next') && old.includes(STAR_ROW_V1));
  const t = cp.refreshConfig(old);
  assert.equal(t, r.text);
});

test('refresh brings the keys block up to date and keeps the hotkeys in it', () => {
  const r = cp.patchConfig(ANTON);
  const jump = ['[[keys.command]]', 'key = "f5"', 'type = "plugin_action"', 'command = "anton.sidebar.jump-1"', 'description = "прыжок: a"'];
  const fresh = cp.setKeysBlock(r.text, jump);
  // a block written by the previous version: the window binding and the hotkeys only
  const b = fresh.indexOf(cp.KEYS_BEGIN);
  const e = fresh.indexOf(cp.KEYS_END);
  const old = fresh.slice(0, b) + [cp.KEYS_BEGIN, '[[keys.command]]', 'key = "prefix+shift+s"', 'type = "plugin_action"',
    'command = "anton.sidebar.open"', 'description = "категории и дежурства"', ...jump].join('\r\n') + '\r\n' + fresh.slice(e);
  assert.ok(!old.includes('star-1'));
  const t = cp.refreshConfig(old);
  assert.equal(t, fresh);
  assert.equal(cp.refreshConfig(t), t, 'a second refresh changes nothing');
  assert.equal(cp.unpatchConfig(t, r), ANTON);
});

test('refresh adds a keys block when an old install has none', () => {
  const r = cp.patchConfig(ANTON);
  const b = r.text.indexOf(cp.KEYS_BEGIN);
  const e = r.text.indexOf(cp.KEYS_END) + cp.KEYS_END.length;
  const old = r.text.slice(0, b) + r.text.slice(e + 2);
  assert.ok(!old.includes(cp.KEYS_BEGIN));
  const t = cp.refreshConfig(old);
  assert.ok(t.includes(cp.KEYS_BEGIN) && t.includes('anton.sidebar.star-4') && t.includes('anton.sidebar.open'));
  assert.equal(cp.refreshConfig(t), t);
});

test('the keys block carries F1…F4, each puts or takes off one kind of star', () => {
  const t = cp.patchConfig(ANTON).text;
  const block = t.slice(t.indexOf(cp.KEYS_BEGIN), t.indexOf(cp.KEYS_END));
  assert.deepEqual(cp.TOGGLE_KEYS, ['f1', 'f2', 'f3', 'f4']);
  cp.TOGGLE_KEYS.forEach((k, i) => {
    assert.ok(block.includes(`key = "${k}"\r\ntype = "plugin_action"\r\ncommand = "anton.sidebar.star-toggle-${i + 1}"`), k);
  });
});
