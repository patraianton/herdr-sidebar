#!/usr/bin/env node
'use strict';
// End-to-end run against an isolated herdr session. Never touches the default
// session: every herdr call names the session or its socket explicitly.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const rpc = require('../../src/rpc');
const ipc = require('../../src/ipc');
const paths = require('../../src/paths');
const configpatch = require('../../src/configpatch');

const SESSION = 'sbplug';
const KEEP = process.argv.includes('--keep');
const ROOT = path.resolve(__dirname, '..', '..');
const LAB = path.join(os.homedir(), 'projects', '_conveyor', 'herdr-plugin-dev', 'lab-plug');
const APPDATA = process.env.APPDATA;
const SOCK = path.join(APPDATA, 'herdr', 'sessions', SESSION, 'herdr.sock');
const DEFAULT_SOCK = path.join(APPDATA, 'herdr', 'herdr.sock');
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';
const PIPE = paths.daemonPipe(SOCK);
const STATE_DIR = path.join(LAB, 'state');
const CONFIG_DIR = path.join(LAB, 'config');
const SESSION_DIR = paths.sessionDir(STATE_DIR, SOCK);
// The plugin is linked for every session: keep the real helper out of this one.
const REAL_SESSION_DIR = paths.sessionDir(path.join(process.env.LOCALAPPDATA, 'herdr', 'plugins', 'anton.sidebar'), SOCK);
// A second session whose pane runs a client of the lab session: real key presses, a readable sidebar.
const VIEW = 'sbview';
const VIEW_SOCK = path.join(APPDATA, 'herdr', 'sessions', VIEW, 'herdr.sock');
const VIEW_REAL_DIR = paths.sessionDir(path.join(process.env.LOCALAPPDATA, 'herdr', 'plugins', 'anton.sidebar'), VIEW_SOCK);

const env = { ...process.env, HERDR_CONFIG_PATH: path.join(LAB, 'herdr-config.toml') };
for (const k of Object.keys(env)) if (k.startsWith('HERDR_') && !['HERDR_BIN_PATH', 'HERDR_CONFIG_PATH'].includes(k)) delete env[k];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const results = [];
function ok(name) { results.push(`ok   ${name}`); console.log(`ok   ${name}`); }
function bad(name, why) { failures++; results.push(`FAIL ${name}: ${why}`); console.log(`FAIL ${name}: ${why}`); }
async function step(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e && e.message ? e.message : String(e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function h(...args) {
  const r = spawnSync(HERDR, ['--session', SESSION, ...args], { env, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`herdr ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  const t = (r.stdout || '').trim();
  try { return JSON.parse(t); } catch { return t; }
}
const api = (method, params) => rpc.call(SOCK, method, params || {});
const helper = (cmd, args) => ipc.request(PIPE, cmd, args || {}, 60000);
const list = async () => (await api('workspace.list')).workspaces;
const byLabel = (ws, label) => ws.find(w => w.label === label);
async function waitFor(name, fn, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(500);
  }
  throw new Error(`timeout: ${name}${lastErr ? ` (${lastErr.message})` : ''}`);
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
async function defaultCount() { return (await rpc.call(DEFAULT_SOCK, 'workspace.list', {})).workspaces.length; }
// Other linked plugins may open workspaces of their own (yourmove opens «Board»).
const LAB_LABELS = /^(repoA|wt1|wt2|plain1|plain2|━━ .+ ━━)$/;
async function labelsInOrder() { return (await list()).map(w => w.label).filter(l => LAB_LABELS.test(l)); }

let server = null;
let daemon = null;

async function startServer() {
  server = spawn(HERDR, ['--session', SESSION, 'server'], { env, detached: true, stdio: 'ignore', windowsHide: true });
  server.unref();
  await waitFor('server ping', async () => { await api('ping'); return true; }, 30000);
}
async function stopServer() {
  spawnSync(HERDR, ['--session', SESSION, 'session', 'stop', SESSION], { env, encoding: 'utf8', windowsHide: true });
  await waitFor('server stop', async () => { try { await api('ping'); return false; } catch { return true; } }, 20000);
}
function startDaemon() {
  daemon = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon.js')], {
    env: { ...env, HERDR_SOCKET_PATH: SOCK, HERDR_PLUGIN_STATE_DIR: STATE_DIR, HERDR_PLUGIN_CONFIG_DIR: CONFIG_DIR, SIDEBAR_TELEGRAM_DISABLED: '1' },
    stdio: 'ignore', windowsHide: true,
  });
}

async function main() {
  const before = await defaultCount().catch(() => null);
  console.log(`default session workspaces before: ${before}`);
  const exists = spawnSync(HERDR, ['session', 'list'], { env, encoding: 'utf8' }).stdout || '';
  for (const s of [SESSION, VIEW]) {
    if (exists.split(/\r?\n/).some(l => l.trim().startsWith(s))) throw new Error(`session ${s} already exists; delete it first`);
  }

  fs.rmSync(LAB, { recursive: true, force: true });
  for (const d of ['repoA', 'plain1', 'plain2', 'elsewhere', 'wt', 'config']) fs.mkdirSync(path.join(LAB, d), { recursive: true });
  // installed as cli.js install would do it, so the helper can write hotkeys
  fs.writeFileSync(env.HERDR_CONFIG_PATH, configpatch.patchConfig('onboarding = false\n[ui.toast]\ndelivery = "herdr"\n[server]\nheadless_cols = 150\nheadless_rows = 40\n').text);
  fs.writeFileSync(path.join(CONFIG_DIR, 'install.json'), JSON.stringify({ configFile: env.HERDR_CONFIG_PATH, originalRows: null, hadTable: false }));
  fs.writeFileSync(path.join(CONFIG_DIR, 'settings.json'), JSON.stringify({ tickSec: 2, graceMin: 0, missingMin: 0.1, blockedMin: 0.1, silenceMarginMin: 0.1 }));
  const repo = path.join(LAB, 'repoA');
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'lab\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', 'commit', '-q', '-m', 'init');

  fs.mkdirSync(REAL_SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(REAL_SESSION_DIR, paths.OFF_MARKER), '');
  await startServer();
  ok('isolated session started');

  const wsA = h('workspace', 'create', '--cwd', repo, '--label', 'repoA', '--no-focus').result.workspace.workspace_id;
  h('worktree', 'create', '--workspace', wsA, '--branch', 'wt1', '--path', path.join(LAB, 'wt', 'wt1'), '--label', 'wt1', '--no-focus');
  h('worktree', 'create', '--workspace', wsA, '--branch', 'wt2', '--path', path.join(LAB, 'wt', 'wt2'), '--label', 'wt2', '--no-focus');
  h('workspace', 'create', '--cwd', path.join(LAB, 'plain1'), '--label', 'plain1', '--no-focus');
  h('workspace', 'create', '--cwd', path.join(LAB, 'plain2'), '--label', 'plain2', '--no-focus');
  const startOrder = await labelsInOrder();
  ok(`lab workspaces: ${startOrder.join(', ')}`);

  startDaemon();
  await waitFor('helper ping', async () => (await helper('ping')).connected, 20000);

  await step('no categories: order untouched, original order saved', async () => {
    await sleep(4000);
    const now = await labelsInOrder();
    assert(now.join('|') === startOrder.join('|'), `order changed: ${now.join(', ')}`);
    assert(fs.existsSync(path.join(SESSION_DIR, 'original.json')), 'original.json missing');
  });
  // The real helper would use the real settings and send real Telegram messages.
  if (fs.existsSync(path.join(REAL_SESSION_DIR, 'daemon.log'))) throw new Error('the real helper started in the test session; stopping');

  let catR;
  let catL;
  const sectionOf = async label => ((byLabel(await list(), label) || {}).tokens || {}).section || '';
  // the first uncategorised row may be a foreign workspace such as «Board»
  const firstAfter = async label => { const l = (await list()).map(w => w.label); return l[l.indexOf(label) + 1]; };
  await step('two categories add no workspaces of their own', async () => {
    await helper('category.create', { name: 'Реклама' });
    await helper('category.create', { name: 'Личное' });
    const v = await helper('view');
    catR = v.categories[0].id;
    catL = v.categories[1].id;
    await sleep(3000);
    const l = await labelsInOrder();
    assert(l.length === startOrder.length, `unexpected count ${l.length}`);
    assert(!l.some(x => x.startsWith('━━')), `title workspace made: ${l.join(', ')}`);
  });

  const repoKey = async () => {
    const w = byLabel(await list(), 'repoA');
    return `repo:${paths.normPath(w.worktree.repo_key)}`;
  };
  await step('moving projects into categories gives the exact order and titles on the first projects', async () => {
    const p1 = byLabel(await list(), 'plain1').workspace_id;
    await helper('unit.move', { key: `ws:${p1}`, catId: catR, index: 0 });
    await helper('unit.move', { key: await repoKey(), catId: catL, index: 0 });
    const want = ['plain1', 'repoA', 'wt1', 'wt2', 'plain2'];
    await waitFor(`order ${want.join(', ')}`, async () => (await labelsInOrder()).join('|') === want.join('|'));
    await waitFor('titles', async () => await sectionOf('plain1') === '━━ РЕКЛАМА ━━'
      && await sectionOf('repoA') === '━━ ЛИЧНОЕ ━━' && await sectionOf(await firstAfter('wt2')) === '━━ БЕЗ КАТЕГОРИИ ━━'
      && await sectionOf('wt1') === '' && await sectionOf('wt2') === '');
  });

  await step('a native drag to the top is learned and the title moves with it', async () => {
    const ws = await list();
    await api('workspace.move_block', { workspace_ids: [byLabel(ws, 'plain2').workspace_id], before_workspace_id: byLabel(ws, 'plain1').workspace_id });
    await waitFor('learned', async () => {
      const v = await helper('view');
      return v.categories[0].units.map(u => u.label).join('|') === 'plain2|plain1';
    });
    const l = await labelsInOrder();
    assert(l.slice(0, 2).join('|') === 'plain2|plain1', `order ${l.join(', ')}`);
    await waitFor('title moved', async () => await sectionOf('plain2') === '━━ РЕКЛАМА ━━' && await sectionOf('plain1') === '');
  });

  await step('a title workspace left by the previous version is closed', async () => {
    const dir = path.join(SESSION_DIR, 'header');
    fs.mkdirSync(dir, { recursive: true });
    h('workspace', 'create', '--cwd', dir, '--label', '━━ СТАРОЕ ━━', '--no-focus');
    await waitFor('closed', async () => !(await labelsInOrder()).includes('━━ СТАРОЕ ━━'));
  });

  await step('renaming a category renames its title', async () => {
    await helper('category.rename', { id: catL, name: 'Своё' });
    await waitFor('renamed', async () => await sectionOf('repoA') === '━━ СВОЁ ━━');
  });

  let wt1New;
  let tickerTerminal;
  await step('detach keeps the running process and marks the project', async () => {
    const w = byLabel(await list(), 'wt1');
    const pane = (await api('pane.list', { workspace_id: w.workspace_id })).panes[0];
    tickerTerminal = pane.terminal_id;
    h('pane', 'run', pane.pane_id, 'node -e "let i=0;setInterval(()=>console.log(\'tick\',++i),300)"');
    await waitFor('ticker', async () => /tick \d+/.test(h('pane', 'read', pane.pane_id, '--source', 'recent', '--lines', '5')));
    const r = await helper('unit.detach', { wsId: w.workspace_id, catId: catR });
    wt1New = r.wsId;
    const nw = (await list()).find(x => x.workspace_id === wt1New);
    assert(nw && nw.label === 'wt1', 'new workspace missing');
    assert(!nw.worktree, 'still marked as a worktree');
    await waitFor('project token', async () => ((await list()).find(x => x.workspace_id === wt1New).tokens || {}).project === '⎇ repoA');
    const np = (await api('pane.list', { workspace_id: wt1New })).panes[0];
    assert(np.terminal_id === tickerTerminal, 'terminal changed');
    const read = () => Number((h('pane', 'read', np.pane_id, '--source', 'recent', '--lines', '3').match(/tick (\d+)/g) || ['tick 0']).pop().slice(5));
    const a = read();
    await sleep(1500);
    assert(read() > a, 'ticker stopped');
    const v = await helper('view');
    assert(v.categories[0].units.some(u => u.anchorId === wt1New), 'not placed in Реклама');
  });

  await step('reattach puts it back into its project with the same process', async () => {
    const r = await helper('unit.reattach', { wsId: wt1New });
    assert(r.wsId === wt1New, `reattached into ${r.wsId}`);
    await waitFor('worktree back', async () => {
      const w = (await list()).find(x => x.workspace_id === wt1New);
      return w && w.worktree && w.worktree.is_linked_worktree && !(w.tokens || {}).project;
    });
    const np = (await api('pane.list', { workspace_id: wt1New })).panes[0];
    assert(np.terminal_id === tickerTerminal, 'terminal changed');
    h('pane', 'send-keys', np.pane_id, 'ctrl+c');
  });

  // A headless herdr may still recognise the workspace after its pane left the
  // checkout (it refreshes folders only with a client attached); either way the
  // end state must be the same. The repair path itself is covered by ops.test.js.
  await step('reattach after the pane left the checkout ends in the project with the same pane', async () => {
    const w = byLabel(await list(), 'wt2');
    const r = await helper('unit.detach', { wsId: w.workspace_id });
    const pane = (await api('pane.list', { workspace_id: r.wsId })).panes[0];
    h('pane', 'run', pane.pane_id, `cd "${path.join(LAB, 'elsewhere')}"`);
    await waitFor('cwd moved', async () => /elsewhere/i.test((await api('pane.list', { workspace_id: r.wsId })).panes[0].cwd || ''));
    const back = await helper('unit.reattach', { wsId: r.wsId });
    const ws = await list();
    if (back.wsId !== r.wsId) assert(!ws.some(x => x.workspace_id === r.wsId), 'old detached workspace still open');
    const nw = ws.find(x => x.workspace_id === back.wsId);
    assert(nw && nw.worktree && nw.worktree.is_linked_worktree, 'not a worktree');
    const panes = (await api('pane.list', { workspace_id: back.wsId })).panes;
    assert(panes.length === 1 && panes[0].terminal_id === pane.terminal_id, `panes: ${panes.map(p => p.terminal_id).join(',')}`);
    ok(`  (herdr ${back.wsId === r.wsId ? 'recognised the workspace' : 'opened a fresh workspace; repaired'})`);
  });

  await step('duty: ok, fail, blocked, recovery, silence, gone', async () => {
    const w = byLabel(await list(), 'plain2');
    const pane = (await api('pane.list', { workspace_id: w.workspace_id })).panes[0];
    const report = state => h('pane', 'report-agent', pane.pane_id, '--source', 'lab', '--agent', 'claude', '--state', state);
    const token = async () => ((await list()).find(x => x.workspace_id === w.workspace_id).tokens || {}).duty || '';
    const until = (re, t = 30000) => waitFor(`duty ${re}`, async () => re.test(await token()), t);
    report('working');
    await waitFor('agent visible', async () => (await api('agent.list')).agents.some(a => a.pane_id === pane.pane_id));
    await helper('duty.start', { paneId: pane.pane_id, every: '0.1m', source: 'agent' });
    await until(/^◆ дежурит/);
    await helper('duty.fail', { paneId: pane.pane_id, reason: 'тест беды' });
    await until(/^▲ тест беды$/);
    await helper('duty.ok', { paneId: pane.pane_id });
    await until(/^◆/);
    report('blocked');
    await until(/^▲ ждёт ответа/);
    report('working');
    await until(/^◆/);
    report('idle');
    await until(/^▲ не просыпался/, 40000);
    report('working');
    await until(/^◆/);
    h('pane', 'release-agent', pane.pane_id, '--source', 'lab', '--agent', 'claude');
    await until(/^▲ окно агента пропало$/, 40000);
    await helper('duty.stop', { paneId: pane.pane_id }).catch(async () => helper('duty.stop', { wsId: w.workspace_id }));
    await until(/^$/);
  });

  // herdr runs the jump action with the real plugin state folder of this
  // session, so the lab helper's state is copied there before each jump.
  const focusedId = async () => ((await list()).find(w => w.focused) || {}).workspace_id;
  const jump = slot => {
    fs.mkdirSync(REAL_SESSION_DIR, { recursive: true });
    fs.copyFileSync(path.join(SESSION_DIR, 'state.json'), path.join(REAL_SESSION_DIR, 'state.json'));
    h('plugin', 'action', 'invoke', `anton.sidebar.jump-${slot}`);
  };
  await step('hotkeys: written to config.toml, shown on the row, the jump action focuses the project and the tab', async () => {
    const ws = await list();
    const p1 = byLabel(ws, 'plain1').workspace_id;
    const p2 = byLabel(ws, 'plain2').workspace_id;
    const menu = await helper('hotkey.menu', { wsId: p1 });
    assert(menu.choices.length === 21, `choices: ${menu.choices.length}`);
    await helper('hotkey.set', { key: 'alt+1', wsId: p1 });
    const tab = h('tab', 'create', '--workspace', p2, '--label', 'logs', '--no-focus').result.tab.tab_id;
    await helper('hotkey.set', { key: 'f5', wsId: p2, tabId: tab });
    const cfg = fs.readFileSync(env.HERDR_CONFIG_PATH, 'utf8');
    assert(/key = "alt\+1"\s+type = "plugin_action"\s+command = "anton\.sidebar\.jump-1"/.test(cfg), 'alt+1 binding missing');
    assert(/key = "f5"\s+type = "plugin_action"\s+command = "anton\.sidebar\.jump-2"/.test(cfg), 'f5 binding missing');
    const check = spawnSync(HERDR, ['config', 'check'], { env, encoding: 'utf8' });
    assert(check.status === 0, `config check: ${check.stdout}${check.stderr}`);
    await waitFor('key token', async () => (byLabel(await list(), 'plain1').tokens || {}).key === 'Alt+1');
    await api('workspace.focus', { workspace_id: byLabel(ws, 'repoA').workspace_id });
    await waitFor('repoA focused', async () => await focusedId() === byLabel(ws, 'repoA').workspace_id);
    jump(1);
    await waitFor('plain1 focused', async () => await focusedId() === p1);
    jump(2);
    await waitFor('plain2 › logs focused', async () => await focusedId() === p2
      && ((await api('tab.list', { workspace_id: p2 })).tabs.find(t => t.focused) || {}).tab_id === tab);
    let refused = false;
    try { await helper('hotkey.set', { key: 'prefix+c', wsId: p1 }); } catch (e) { refused = /new_tab/.test(e.message); }
    assert(refused, 'a key of herdr itself was accepted');
  });

  await step('restart: helper reconnects, order kept, tokens back', async () => {
    const w = byLabel(await list(), 'wt1');
    const r = await helper('unit.detach', { wsId: w.workspace_id, catId: catR });
    await waitFor('token', async () => ((await list()).find(x => x.workspace_id === r.wsId).tokens || {}).project === '⎇ repoA');
    const orderBefore = await labelsInOrder();
    await stopServer();
    await startServer();
    await waitFor('helper reconnected', async () => (await helper('ping')).connected, 30000);
    await waitFor('token republished', async () => ((await list()).find(x => x.workspace_id === r.wsId).tokens || {}).project === '⎇ repoA', 30000);
    const after = await labelsInOrder();
    assert(after.join('|') === orderBefore.join('|'), `order changed: ${after.join(', ')}`);
  });

  await step('after the restart the hotkey still finds its project and its key shows again', async () => {
    const p1 = byLabel(await list(), 'plain1').workspace_id;
    await waitFor('key token back', async () => (byLabel(await list(), 'plain1').tokens || {}).key === 'Alt+1', 30000);
    await api('workspace.focus', { workspace_id: byLabel(await list(), 'repoA').workspace_id });
    await waitFor('repoA focused', async () => await focusedId() === byLabel(await list(), 'repoA').workspace_id);
    jump(1);
    await waitFor('plain1 focused', async () => await focusedId() === p1);
  });

  await step('stars: shown in the sidebar, Alt+` walks through them from a real key press', async () => {
    const ws = await list();
    const id = l => byLabel(ws, l).workspace_id;
    await helper('star.toggle', { wsId: id('plain2') });
    await helper('star.toggle', { wsId: id('repoA') });
    await waitFor('star tokens', async () => {
      const l = await list();
      return (byLabel(l, 'plain2').tokens || {}).star === '★' && (byLabel(l, 'repoA').tokens || {}).star === '★'
        && !(byLabel(l, 'plain1').tokens || {}).star;
    });
    const cfg = fs.readFileSync(env.HERDR_CONFIG_PATH, 'utf8');
    assert(/key = "alt\+backtick"\s+type = "plugin_action"\s+command = "anton\.sidebar\.star-next"/.test(cfg), 'Alt+` binding missing');
    const order = (await labelsInOrder()).filter(l => ['plain1', 'plain2', 'repoA'].includes(l)).join('|');
    assert(order === 'plain2|plain1|repoA', `order ${order}`);
    fs.copyFileSync(path.join(SESSION_DIR, 'state.json'), path.join(REAL_SESSION_DIR, 'state.json'));
    await api('workspace.focus', { workspace_id: id('plain1') });
    await waitFor('plain1 focused', async () => await focusedId() === id('plain1'));
    h('plugin', 'action', 'invoke', 'anton.sidebar.star-next');
    await waitFor('repoA focused', async () => await focusedId() === id('repoA'));
    h('plugin', 'action', 'invoke', 'anton.sidebar.star-next');
    await waitFor('round to plain2', async () => await focusedId() === id('plain2'));

    fs.mkdirSync(VIEW_REAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(VIEW_REAL_DIR, paths.OFF_MARKER), '');
    spawn(HERDR, ['--session', VIEW, 'server'], { env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await waitFor('viewer ping', async () => { await rpc.call(VIEW_SOCK, 'ping', {}); return true; }, 30000);
    const v = (...args) => spawnSync(HERDR, ['--session', VIEW, ...args], { env, encoding: 'utf8', windowsHide: true }).stdout || '';
    const vws = JSON.parse(v('workspace', 'create', '--cwd', LAB, '--label', 'viewer')).result.workspace.workspace_id;
    const vpane = (await rpc.call(VIEW_SOCK, 'pane.list', { workspace_id: vws })).panes[0].pane_id;
    v('pane', 'zoom', vpane, '--mode', 'on');
    v('pane', 'run', vpane, `node "${path.join(__dirname, 'attach.js')}" ${SESSION}`);
    const screen = () => v('pane', 'read', vpane, '--source', 'visible', '--lines', '45');
    await waitFor('star drawn before the name', async () => /★ · plain2/.test(screen()) && /★ · repoA/.test(screen()), 20000)
      .catch(e => { throw new Error(`${e.message}\n${screen()}`); });
    assert(!/★ · plain1/.test(screen()), 'plain1 has a star');
    const before = await focusedId();
    const want = before === id('repoA') ? id('plain2') : id('repoA');
    v('pane', 'send-keys', vpane, 'alt+backtick');
    await waitFor('Alt+` moved to the next star', async () => await focusedId() === want, 15000);
    const next = want === id('repoA') ? id('plain2') : id('repoA');
    v('pane', 'send-keys', vpane, 'alt+ё');
    await waitFor('Alt+Ё moved to the next star', async () => await focusedId() === next, 15000);
  });

  await step('window opens, shows categories, help and quits', async () => {
    const w = byLabel(await list(), 'plain1');
    const pane = (await api('pane.list', { workspace_id: w.workspace_id })).panes[0];
    h('pane', 'run', pane.pane_id, `node "${path.join(ROOT, 'src', 'ui.js')}"`);
    const screen = () => h('pane', 'read', pane.pane_id, '--source', 'visible', '--lines', '60');
    await waitFor('window drawn', async () => /Категории и дежурства/.test(screen()) && /РЕКЛАМА/.test(screen()), 20000);
    await waitFor('key on its row', async () => /plain1.*Alt\+1/.test(screen()), 10000)
      .catch(e => { throw new Error(`${e.message}\n${screen()}`); });
    assert(/★\s+plain2/.test(screen()) && !/★\s+plain1/.test(screen()), `star in the window:\n${screen()}`);
    h('pane', 'send-keys', pane.pane_id, '?');
    await waitFor('help', async () => /Помощь/.test(screen()), 10000);
    h('pane', 'send-keys', pane.pane_id, 'esc');
    h('pane', 'send-keys', pane.pane_id, 'down');
    h('pane', 'send-keys', pane.pane_id, 'k');
    await waitFor('hotkey menu', async () => /Клавиша для|куда прыгать/.test(screen()), 10000);
    h('pane', 'send-keys', pane.pane_id, 'esc');
    h('pane', 'send-keys', pane.pane_id, 'q');
    await waitFor('closed', async () => !/Категории и дежурства/.test(screen()), 10000);
  });

  await step('uninstall restores the original order and clears everything', async () => {
    const orig = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'original.json'), 'utf8')).order;
    await helper('uninstall');
    await waitFor('helper gone', async () => { try { await helper('ping'); return false; } catch { return true; } }, 15000);
    const ws = await list();
    assert(!ws.some(w => /^━━ /.test(w.label)), 'headers left');
    assert(!ws.some(w => w.tokens && (w.tokens.section || w.tokens.project || w.tokens.duty || w.tokens.key || w.tokens.star)), 'tokens left');
    const ids = ws.map(w => w.workspace_id);
    const known = ids.filter(id => orig.includes(id));
    assert(known.join('|') === orig.filter(id => ids.includes(id)).join('|'), `order ${known.join(',')} vs ${orig.join(',')}`);
  });
}

async function cleanup() {
  if (daemon && daemon.exitCode === null) { try { await helper('shutdown'); } catch {} }
  if (KEEP) { console.log(`--keep: sessions ${SESSION}, ${VIEW} and ${LAB} left for inspection`); return; }
  for (const s of [VIEW, SESSION]) {
    spawnSync(HERDR, ['--session', s, 'session', 'stop', s], { env, encoding: 'utf8', windowsHide: true });
    spawnSync(HERDR, ['session', 'delete', s], { env, encoding: 'utf8', windowsHide: true });
  }
  fs.rmSync(VIEW_REAL_DIR, { recursive: true, force: true });
  const repo = path.join(LAB, 'repoA');
  if (fs.existsSync(repo)) {
    for (const wt of ['wt1', 'wt2']) spawnSync('git', ['worktree', 'remove', '--force', path.join(LAB, 'wt', wt)], { cwd: repo });
    spawnSync('git', ['worktree', 'prune'], { cwd: repo });
  }
  fs.rmSync(REAL_SESSION_DIR, { recursive: true, force: true });
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(LAB, { recursive: true, force: true }); break; } catch { await sleep(1000); }
  }
  console.log(fs.existsSync(LAB) ? `could not remove ${LAB}` : `removed ${LAB}`);
}

main()
  .catch(e => bad('run', e.stack || e.message))
  .then(cleanup)
  .then(async () => {
    const after = await defaultCount().catch(() => null);
    console.log(`default session workspaces after: ${after}`);
    console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
    process.exit(failures ? 1 : 0);
  });
