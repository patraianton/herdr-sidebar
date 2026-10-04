'use strict';
// Runs inside a pane of the viewer session: a herdr client attached to the lab
// session, so the lab sees real key presses and its sidebar can be read.
const { spawn } = require('node:child_process');

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('HERDR_') && !['HERDR_BIN_PATH', 'HERDR_CONFIG_PATH'].includes(k)) delete env[k];
spawn(process.env.HERDR_BIN_PATH || 'herdr', ['--session', process.argv[2]], { stdio: 'inherit', env })
  .on('exit', code => process.exit(code || 0));
