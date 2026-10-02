'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../src/paths');

test('normPath strips the long-path prefix, unifies slashes and case', () => {
  assert.equal(paths.normPath('\\\\?\\C:\\Users\\Me\\Proj\\'), 'c:/users/me/proj');
  assert.equal(paths.normPath('C:/Users/me/proj'), 'c:/users/me/proj');
  assert.equal(paths.normPath(''), '');
  assert.equal(paths.normPath(null), '');
});

test('sessionName reads named sessions from the socket path', () => {
  assert.equal(paths.sessionName('C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock'), 'default');
  assert.equal(paths.sessionName('C:\\Users\\me\\AppData\\Roaming\\herdr\\sessions\\sbplug\\herdr.sock'), 'sbplug');
});

test('pipePath and daemonPipe on windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(paths.pipePath('C:\\x\\herdr.sock'), '\\\\.\\pipe\\C:\\x\\herdr.sock');
  assert.equal(paths.pipePath('\\\\.\\pipe\\abc'), '\\\\.\\pipe\\abc');
  const a = paths.daemonPipe('C:\\x\\herdr.sock');
  assert.match(a, /^\\\\\.\\pipe\\herdr-sidebar-[0-9a-f]{12}$/);
  assert.equal(a, paths.daemonPipe('c:\\X\\HERDR.sock'));
  assert.notEqual(a, paths.daemonPipe('C:\\y\\herdr.sock'));
});

test('sessionDir nests by session', () => {
  const d = paths.sessionDir('C:\\state', 'C:\\h\\sessions\\sbplug\\herdr.sock');
  assert.match(d.replace(/\\/g, '/'), /C:\/state\/sessions\/sbplug$/);
});

test('helperOff: a marker file switches the helper off for one session only', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-off-'));
  const lab = 'C:/x/herdr/sessions/lab/herdr.sock';
  assert.equal(paths.helperOff(root, lab), false);
  fs.mkdirSync(paths.sessionDir(root, lab), { recursive: true });
  fs.writeFileSync(path.join(paths.sessionDir(root, lab), paths.OFF_MARKER), '');
  assert.equal(paths.helperOff(root, lab), true);
  assert.equal(paths.helperOff(root, 'C:/x/herdr/herdr.sock'), false);
  fs.rmSync(root, { recursive: true, force: true });
});
