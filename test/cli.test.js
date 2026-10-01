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

test('uninstall stops before touching the config when the helper cannot restore the order', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cli-'));
  const cfg = path.join(dir, 'config.toml');
  const patched = 'x = 1\n# >>> anton.sidebar keys\n[[keys.command]]\n# <<< anton.sidebar keys\n';
  fs.writeFileSync(cfg, patched);
  fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify({ configFile: cfg, originalRows: null, hadTable: true }));
  const env = {
    ...process.env,
    HERDR_SOCKET_PATH: path.join(dir, 'no-such-herdr.sock'),
    HERDR_BIN_PATH: path.join(dir, 'no-such-herdr.exe'),
    HERDR_PLUGIN_CONFIG_DIR: dir,
    SIDEBAR_HELPER_WAIT_MS: '300',
  };
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'uninstall'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /не тронуты/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), patched, 'config untouched');
  assert.ok(fs.existsSync(path.join(dir, 'install.json')), 'install record kept');
  fs.rmSync(dir, { recursive: true, force: true });
});
