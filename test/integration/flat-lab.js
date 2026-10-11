#!/usr/bin/env node
'use strict';
// A herdr build with [ui.sidebar.spaces] group_worktrees, checked the way it
// would run live: the session server is SERVER_BIN (default: the installed
// herdr), the client drawing the sidebar is CLIENT_BIN (the new build), the
// plugin helper runs from this repo. The sidebar is read as text through a
// viewer session whose pane runs the client. Never touches the default session.
//   CLIENT_BIN=<herdr.exe> [SERVER_BIN=herdr] node test/integration/flat-lab.js [--keep]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const rpc = require('../../src/rpc');
const ipc = require('../../src/ipc');
const paths = require('../../src/paths');
const configpatch = require('../../src/configpatch');

const CLIENT = process.env.CLIENT_BIN;
const SERVER = process.env.SERVER_BIN || 'herdr';
if (!CLIENT) { console.error('CLIENT_BIN=<path to the new herdr.exe> is required'); process.exit(2); }
const KEEP = process.argv.includes('--keep');
const SESSION = 'sbflat';
const VIEW = 'sbflatview';
const ROOT = path.resolve(__dirname, '..', '..');
const LAB = process.env.SIDEBAR_LAB_DIR || path.join(os.tmpdir(), 'herdr-sidebar-flat-lab');
const APPDATA = process.env.APPDATA;
const SOCK = path.join(APPDATA, 'herdr', 'sessions', SESSION, 'herdr.sock');
const VIEW_SOCK = path.join(APPDATA, 'herdr', 'sessions', VIEW, 'herdr.sock');
const DEFAULT_SOCK = path.join(APPDATA, 'herdr', 'herdr.sock');
const PIPE = paths.daemonPipe(SOCK);
const STATE_DIR = path.join(LAB, 'state');
const CONFIG_DIR = path.join(LAB, 'config');
const REAL = sock => paths.sessionDir(path.join(process.env.LOCALAPPDATA, 'herdr', 'plugins', 'anton.sidebar'), sock);
const env = { ...process.env, HERDR_CONFIG_PATH: path.join(LAB, 'herdr-config.toml') };
for (const k of Object.keys(env)) if (k.startsWith('HERDR_') && k !== 'HERDR_CONFIG_PATH') delete env[k];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function ok(name) { console.log(`ok   ${name}`); }
function bad(name, why) { failures++; console.log(`FAIL ${name}: ${why}`); }
async function step(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e && e.message ? e.message : String(e)); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function run(bin, session, args) {
  const r = spawnSync(bin, ['--session', session, ...args], { env, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`herdr ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  const t = (r.stdout || '').trim();
  try { return JSON.parse(t); } catch { return t; }
}
const h = (...args) => run(SERVER, SESSION, args);
const v = (...args) => run(SERVER, VIEW, args);
const api = (method, params) => rpc.call(SOCK, method, params || {});
const helper = (cmd, args) => ipc.request(PIPE, cmd, args || {}, 60000);
const list = async () => (await api('workspace.list')).workspaces;
const byLabel = (ws, label) => ws.find(w => w.label === label);
async function waitFor(name, fn, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < until) {
    try { const x = await fn(); if (x) return x; } catch (e) { lastErr = e; }
    await sleep(500);
  }
  throw new Error(`timeout: ${name}${lastErr ? ` (${lastErr.message})` : ''}`);
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const defaultCount = async () => (await rpc.call(DEFAULT_SOCK, 'workspace.list', {})).workspaces.length;

let daemon = null;
let screenText = '';

async function main() {
  console.log(`client: ${CLIENT}\nserver: ${SERVER}`);
  console.log(`default session workspaces before: ${await defaultCount().catch(() => null)}`);
  const sessions = spawnSync(SERVER, ['session', 'list'], { env, encoding: 'utf8' }).stdout || '';
  for (const s of [SESSION, VIEW]) {
    if (sessions.split(/\r?\n/).some(l => l.trim().startsWith(s))) throw new Error(`session ${s} already exists; delete it first`);
  }
  const canFlat = spawnSync(CLIENT, ['--default-config'], { encoding: 'utf8' }).stdout || '';
  await step('the new build knows group_worktrees', async () => assert(/group_worktrees/.test(canFlat), 'not in --default-config'));

  fs.rmSync(LAB, { recursive: true, force: true });
  for (const d of ['acme-api', 'blog', 'wt', 'config']) fs.mkdirSync(path.join(LAB, d), { recursive: true });
  const base = 'onboarding = false\n[ui]\nsidebar_width = 34\nsidebar_min_width = 34\nsidebar_max_width = 34\n[ui.toast]\ndelivery = "herdr"\n[server]\nheadless_cols = 150\nheadless_rows = 40\n';
  fs.writeFileSync(env.HERDR_CONFIG_PATH, configpatch.patchConfig(base, { flat: true }).text);
  fs.writeFileSync(path.join(CONFIG_DIR, 'install.json'), JSON.stringify({ configFile: env.HERDR_CONFIG_PATH, originalRows: null, hadTable: false }));
  fs.writeFileSync(path.join(CONFIG_DIR, 'settings.json'), JSON.stringify({ starsOnTop: [1], starNames: ['My project', 'Job 1', 'Job 2', 'Job 3'] }));
  const repo = path.join(LAB, 'acme-api');
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'lab\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', 'commit', '-q', '-m', 'init');

  for (const sock of [SOCK, VIEW_SOCK]) {
    fs.mkdirSync(REAL(sock), { recursive: true });
    fs.writeFileSync(path.join(REAL(sock), paths.OFF_MARKER), '');
  }
  spawn(SERVER, ['--session', SESSION, 'server'], { env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  await waitFor('server ping', async () => { await api('ping'); return true; }, 30000);
  ok('isolated session started');

  const wsA = h('workspace', 'create', '--cwd', repo, '--label', 'acme-api', '--no-focus').result.workspace.workspace_id;
  for (const name of ['awsome-motive-landing', 'pricing']) {
    h('worktree', 'create', '--workspace', wsA, '--branch', name, '--path', path.join(LAB, 'wt', name), '--label', name, '--no-focus');
  }
  h('workspace', 'create', '--cwd', path.join(LAB, 'blog'), '--label', 'blog', '--no-focus');

  daemon = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon.js')], {
    env: { ...env, HERDR_SOCKET_PATH: SOCK, HERDR_PLUGIN_STATE_DIR: STATE_DIR, HERDR_PLUGIN_CONFIG_DIR: CONFIG_DIR, HERDR_BIN_PATH: CLIENT, SIDEBAR_TELEGRAM_DISABLED: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  await waitFor('helper ping', async () => (await helper('ping')).connected, 20000);
  if (fs.existsSync(path.join(REAL(SOCK), 'daemon.log'))) throw new Error('the real helper started in the lab session; stopping');

  const ws = await list();
  const id = label => byLabel(ws, label).workspace_id;
  await helper('category.create', { name: 'Code' });
  const cat = (await helper('view')).categories[0].id;
  await helper('unit.move', { key: `ws:${id('blog')}`, catId: cat, index: 0 });
  await helper('unit.move', { key: `ws:${id('acme-api')}`, catId: cat, index: 1 });
  await helper('star.set', { wsId: id('acme-api'), kind: 1 });

  await step('nothing is detached: every workspace keeps its id', async () => {
    await sleep(4000);
    const now = (await list()).map(w => w.workspace_id).sort();
    assert(now.join() === ws.map(w => w.workspace_id).sort().join(), `ids changed: ${now.join(', ')}`);
    const log = fs.readFileSync(path.join(paths.sessionDir(STATE_DIR, SOCK), 'daemon.log'), 'utf8');
    assert(/nothing is detached any more/.test(log), 'the helper did not see the flat sidebar');
    assert(!/copy detached/.test(log), 'the helper detached a copy');
  });
  await step('the copies carry ⎇ acme-api', async () => {
    await waitFor('project tokens', async () => {
      const l = await list();
      return ['awsome-motive-landing', 'pricing'].every(x => (byLabel(l, x).tokens || {}).project === '⎇ acme-api');
    });
  });

  spawn(SERVER, ['--session', VIEW, 'server'], { env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  await waitFor('viewer ping', async () => { await rpc.call(VIEW_SOCK, 'ping', {}); return true; }, 30000);
  const vws = v('workspace', 'create', '--cwd', LAB, '--label', 'viewer').result.workspace.workspace_id;
  const vpane = (await rpc.call(VIEW_SOCK, 'pane.list', { workspace_id: vws })).panes[0].pane_id;
  v('pane', 'run', vpane, `node "${path.join(__dirname, 'attach.js')}" ${SESSION} "${CLIENT}"`);
  const screen = () => (screenText = v('pane', 'read', vpane, '--source', 'visible', '--lines', '40'));

  await step('the sidebar draws the copies on lines of their own, under the project', async () => {
    await waitFor('copies drawn', async () => /awsome-motive/.test(screen()) && /pricing/.test(screen()), 30000)
      .catch(e => { throw new Error(`${e.message}\n${screenText}`); });
    const s = screen();
    assert(!/[├└]─/.test(s), `tree lines still drawn:\n${s}`);
    const lines = s.split(/\r?\n/);
    const at = x => lines.findIndex(l => l.includes(x));
    assert(at('acme-api') >= 0 && at('acme-api') < at('awsome-motive') && at('awsome-motive') < at('pricing'), `order:\n${s}`);
  });
  // the lab sidebar is 34 columns: the long name fits only if it goes first
  await step('the name is shown whole before ⎇ gets the rest', async () => {
    const s = screen();
    assert(/awsome-motive-landing/.test(s), `name cut:\n${s}`);
    assert(/pricing\s+·\s+⎇ acme-api/.test(s), `short name with its project:\n${s}`);
  });
  await step('a project under a title starts at the same column as the others', async () => {
    const lines = screen().split(/\r?\n/).map(l => l.split('│')[0]);
    const lead = re => { const l = lines.find(x => re.test(x)); return l ? l.length - l.trimStart().length : -1; };
    const titled = lead(/★1 · acme-api/);
    const plain = lead(/pricing · ⎇/);
    assert(titled >= 0 && titled === plain, `acme-api starts at ${titled}, pricing at ${plain}:\n${lines.join('\n')}`);
  });
  await step('no warning about the setting on screen', async () => {
    const s = screen();
    const warn = s.split(/\r?\n/).find(l => /unknown (config )?keys?|config check/i.test(l));
    assert(!warn, `warning: ${warn && warn.trim()}`);
  });
  const sidebar = screenText.split(/\r?\n/).map(l => l.split('│')[0]).filter(l => l.trim()).slice(0, 16);
  console.log(`\n--- sidebar as drawn ---\n${sidebar.join('\n')}\n------------------------`);
}

async function cleanup() {
  if (daemon && daemon.exitCode === null) { try { await helper('shutdown'); } catch {} }
  if (KEEP) { console.log(`--keep: sessions ${SESSION}, ${VIEW} and ${LAB} left for inspection`); return; }
  for (const s of [VIEW, SESSION]) {
    spawnSync(SERVER, ['--session', s, 'session', 'stop', s], { env, encoding: 'utf8', windowsHide: true });
    spawnSync(SERVER, ['session', 'delete', s], { env, encoding: 'utf8', windowsHide: true });
  }
  const repo = path.join(LAB, 'acme-api');
  if (fs.existsSync(repo)) {
    for (const wt of ['awsome-motive-landing', 'pricing']) spawnSync('git', ['worktree', 'remove', '--force', path.join(LAB, 'wt', wt)], { cwd: repo });
    spawnSync('git', ['worktree', 'prune'], { cwd: repo });
  }
  for (const sock of [SOCK, VIEW_SOCK]) fs.rmSync(REAL(sock), { recursive: true, force: true });
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(LAB, { recursive: true, force: true }); break; } catch { await sleep(1000); }
  }
  console.log(fs.existsSync(LAB) ? `could not remove ${LAB}` : `removed ${LAB}`);
}

main()
  .catch(e => bad('run', e.stack || e.message))
  .then(cleanup)
  .then(async () => {
    console.log(`default session workspaces after: ${await defaultCount().catch(() => null)}`);
    console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
    process.exit(failures ? 1 : 0);
  });
