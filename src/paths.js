'use strict';
// Paths, session names and pipe names. Everything here is pure.
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// One comparable form for folder paths: no \\?\ prefix, forward slashes,
// no trailing slash, lower case (Windows paths are case-insensitive).
function normPath(p) {
  if (!p) return '';
  let s = String(p).replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');
  return s.toLowerCase();
}

// herdr keeps the default session socket at ...\herdr\herdr.sock and named
// sessions at ...\herdr\sessions\<name>\herdr.sock.
function sessionName(socketPath) {
  const s = String(socketPath || '').replace(/\\/g, '/');
  const m = s.match(/\/sessions\/([^/]+)\/[^/]+$/);
  return m ? m[1] : 'default';
}

// On Windows the herdr socket is the named pipe \\.\pipe\<HERDR_SOCKET_PATH>.
function pipePath(socketPath) {
  if (process.platform !== 'win32') return socketPath;
  if (String(socketPath).startsWith('\\\\.\\pipe\\')) return socketPath;
  return '\\\\.\\pipe\\' + socketPath;
}

// The helper's own pipe: one per herdr session.
function daemonPipe(socketPath) {
  const h = crypto.createHash('sha1').update(String(socketPath).toLowerCase()).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\herdr-sidebar-${h}`;
  return path.join(os.tmpdir(), `herdr-sidebar-${h}.sock`);
}

function sessionDir(stateRoot, socketPath) {
  return path.join(stateRoot, 'sessions', sessionName(socketPath));
}

// The plugin is linked for every herdr session of the user. A test session puts
// this file into its session folder so the real helper never runs there.
const OFF_MARKER = 'helper-off';
function helperOff(stateRoot, socketPath) {
  return require('node:fs').existsSync(path.join(sessionDir(stateRoot, socketPath), OFF_MARKER));
}

module.exports = { normPath, sessionName, pipePath, daemonPipe, sessionDir, OFF_MARKER, helperOff };
