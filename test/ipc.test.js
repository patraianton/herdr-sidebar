'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const ipc = require('../src/ipc');

const pipeName = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\herdr-sidebar-test-${process.pid}-${Math.random().toString(16).slice(2)}`
  : path.join(os.tmpdir(), `sb-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`));

test('request/response, remote errors and a busy pipe', async () => {
  const pipe = pipeName();
  const server = await ipc.serve(pipe, async (cmd, args) => {
    if (cmd === 'echo') return { got: args.x };
    throw new Error('bad command');
  });
  try {
    assert.deepEqual(await ipc.request(pipe, 'echo', { x: 'привет 👋' }), { got: 'привет 👋' });
    await assert.rejects(ipc.request(pipe, 'nope', {}), e => e.remote === true && /bad command/.test(e.message));
    await assert.rejects(ipc.serve(pipe, async () => 1), e => e.code === 'EADDRINUSE');
  } finally {
    server.close();
  }
});

test('connection errors are recognised', async () => {
  const err = await ipc.request(pipeName(), 'ping', {}, 1000).catch(e => e);
  assert.ok(ipc.isConnError(err), String(err && err.code));
});
