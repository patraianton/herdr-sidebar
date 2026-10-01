#!/usr/bin/env node
'use strict';
// Start the helper for this herdr session unless it is already running.
// Used by the startup hook, the event hooks and the "open" action.
const path = require('node:path');
const { spawn } = require('node:child_process');
const ipc = require('./ipc');
const paths = require('./paths');

async function ensureDaemon() {
  const pipe = paths.daemonPipe(process.env.HERDR_SOCKET_PATH);
  try {
    await ipc.request(pipe, 'ping', {}, 2000);
    return 'running';
  } catch {}
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true, stdio: 'ignore', windowsHide: true, env: process.env, cwd: path.join(__dirname, '..'),
  });
  child.unref();
  return 'started';
}

if (require.main === module) {
  if (!process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PLUGIN_STATE_DIR) process.exit(0);
  ensureDaemon().then(() => process.exit(0), () => process.exit(0));
}

module.exports = { ensureDaemon };
