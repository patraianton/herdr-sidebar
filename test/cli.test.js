'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cli = require('../src/cli');

test('parseArgs', () => {
  assert.deepEqual(cli.parseArgs(['start', '--every', '30m', '--note', 'реклама autopase']), { _: ['start'], every: '30m', note: 'реклама autopase' });
  assert.deepEqual(cli.parseArgs(['fail', 'кабинет', 'не', 'открывается']), { _: ['fail', 'кабинет', 'не', 'открывается'] });
  assert.deepEqual(cli.parseArgs(['start', '--every=1h']), { _: ['start'], every: '1h' });
});

test('duty without herdr explains itself', () => {
  const env = { ...process.env };
  delete env.HERDR_SOCKET_PATH;
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'duty', 'ok'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /внутри herdr/);
});

test('usage', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'duty'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /herdr-duty start --every 30m/);
});
