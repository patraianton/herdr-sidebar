#!/usr/bin/env node
'use strict';
// Command line: `herdr-duty ...` for agents, setup/install/uninstall/status/open for people,
// `jump N` for the hotkeys (herdr runs it through the action jump-N) and
// `star N` for Alt+N, the stars of kind N (the action star-N), and
// `star-toggle N` for FN, the star of kind N on the focused workspace,
// and `star-reset` for Alt+0, every star off or back again.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ipc = require('./ipc');
const paths = require('./paths');
const store = require('./store');
const configpatch = require('./configpatch');
const hotkeys = require('./hotkeys');
const stars = require('./stars');
const { makeHerdr, PLUGIN_ID } = require('./herdr');

const ROOT = path.resolve(__dirname, '..');
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';
const BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const INSIDE = 'Run this command inside herdr (HERDR_SOCKET_PATH is not set).';

const USAGE = [
  'Duty agent (run it from the agent\'s pane in herdr):',
  '  herdr-duty start --every 30m [--note "what I watch"]   start the duty',
  '  herdr-duty ok                                       "I am alive" (optional, after each round)',
  '  herdr-duty fail "reason"                            report a problem',
  '  herdr-duty stop                                     end the duty',
  '  herdr-duty status                                   list all duties',
].join('\n');

const say = s => process.stdout.write(`${s}\n`);
// Stops the command; main() prints the message and exits with the code.
function fail(s, code = 1) { throw Object.assign(new Error(s), { exitCode: code }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const herdrRun = args => spawnSync(HERDR, args, { encoding: 'utf8', windowsHide: true });

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--(every|note)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    else out._.push(a);
  }
  return out;
}

async function helper(cmd, args) {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) fail(INSIDE);
  const pipe = paths.daemonPipe(sock);
  try { return await ipc.request(pipe, cmd, args); } catch (e) { if (!ipc.isConnError(e)) throw e; }
  herdrRun(['plugin', 'action', 'invoke', `${PLUGIN_ID}.ensure`]);
  const waitMs = Number(process.env.SIDEBAR_HELPER_WAIT_MS) || 10000;
  for (let waited = 0; waited < waitMs; waited += 250) {
    await sleep(250);
    try { return await ipc.request(pipe, cmd, args); } catch (e) { if (!ipc.isConnError(e)) throw e; }
  }
  throw new Error(`the plugin helper did not start (check herdr plugin list: ${PLUGIN_ID} must be enabled)`);
}

async function duty(argv) {
  const a = parseArgs(argv);
  const sub = a._[0];
  if (!sub) { say(USAGE); return; }
  if (!process.env.HERDR_SOCKET_PATH) fail(INSIDE);
  const who = { paneId: process.env.HERDR_PANE_ID || null, wsId: process.env.HERDR_WORKSPACE_ID || null };
  if (sub === 'start') {
    if (!a.every) fail('Give an interval: herdr-duty start --every 30m');
    const r = await helper('duty.start', { ...who, every: a.every, note: a.note, source: 'agent' });
    say(`Duty is on: "${r.label || r.wsId}", wake up at least every ${r.every}.`);
    say('Alive: herdr-duty ok. Problem: herdr-duty fail "reason". End: herdr-duty stop.');
  } else if (sub === 'ok') {
    await helper('duty.ok', who);
    say('Alive mark recorded.');
  } else if (sub === 'fail') {
    await helper('duty.fail', { ...who, reason: a._.slice(1).join(' ') });
    say('Problem recorded: the sidebar shows a red mark and a notification went out.');
  } else if (sub === 'stop') {
    await helper('duty.stop', who);
    say('Duty ended.');
  } else if (sub === 'status') {
    const list = await helper('duty.status', {});
    if (!list.length) say('No duties.');
    for (const d of list) say(`${d.label || d.wsId}: ${d.token}`);
  } else {
    say(USAGE);
    process.exit(1);
  }
}

function configFile() {
  if (process.env.HERDR_CONFIG_PATH) return process.env.HERDR_CONFIG_PATH;
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'config.toml');
}

function pluginConfigDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  const r = herdrRun(['plugin', 'config-dir', PLUGIN_ID]);
  const dir = (r.stdout || '').trim().split(/\r?\n/).pop();
  if (r.status !== 0 || !dir) fail(`The plugin is not registered in herdr. First: herdr plugin install patraianton/herdr-sidebar (or herdr plugin link "${ROOT}")`);
  return dir;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeShims() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const cli = path.join(ROOT, 'src', 'cli.js');
  fs.writeFileSync(path.join(BIN_DIR, 'herdr-duty.cmd'), `@echo off\r\nnode "${cli}" duty %*\r\n`);
  fs.writeFileSync(path.join(BIN_DIR, 'herdr-duty'), `#!/bin/sh\nexec node "${cli.replace(/\\/g, '/')}" duty "$@"\n`);
}

function onPath(dir) {
  const norm = p => path.resolve(p).toLowerCase();
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).some(p => norm(p) === norm(dir));
}

function removeShims() {
  for (const f of ['herdr-duty.cmd', 'herdr-duty']) { try { fs.unlinkSync(path.join(BIN_DIR, f)); } catch {} }
}

// A helper still running the old code would write its old key bindings back
// on the next hotkey change, so after a refresh it is started again.
async function restartHelper() {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) { say('The plugin helper still runs the old code: restart herdr or run the setup again from inside herdr.'); return; }
  const pipe = paths.daemonPipe(sock);
  const alive = async () => { try { return await ipc.request(pipe, 'ping', {}, 2000); } catch { return null; } };
  if (await alive()) {
    try { await ipc.request(pipe, 'shutdown', {}, 3000); } catch {}
    for (let i = 0; i < 40 && await alive(); i++) await sleep(250);
  }
  try {
    const p = await helper('ping', {});
    say(`The plugin helper restarted on the new code (pid ${p.pid}).`);
  } catch (e) {
    say(`The plugin helper did not start: ${e.message}`);
  }
}

// Already installed: bring the sidebar rows and the fixed key bindings up to this version.
async function refreshInstall(cfg) {
  const text = fs.readFileSync(cfg, 'utf8');
  let next;
  try { next = configpatch.refreshConfig(text); } catch (e) { fail(`The plugin's lines are not in ${cfg}: ${e.message}`); }
  if (next === text) { writeShims(); say('Already set up, herdr settings are up to date.'); await restartHelper(); return; }
  const backup = `${cfg}.bak-${today()}-sidebar-refresh`;
  if (!fs.existsSync(backup)) fs.copyFileSync(cfg, backup);
  fs.writeFileSync(cfg, next);
  const check = herdrRun(['config', 'check']);
  if (check.status !== 0) {
    fs.writeFileSync(cfg, text);
    fail(`herdr did not accept the new settings, the file is back as it was:\n${check.stdout || ''}${check.stderr || ''}`);
  }
  writeShims();
  const rl = herdrRun(['server', 'reload-config']);
  say(`Plugin settings in herdr updated (backup: ${backup}).`);
  say(rl.status === 0 ? 'herdr reloaded its settings.' : `herdr did not reload its settings: ${(rl.stderr || rl.stdout || '').trim()}`);
  await restartHelper();
}

function install() {
  const cfg = configFile();
  const cfgDir = pluginConfigDir();
  const instFile = path.join(cfgDir, 'install.json');
  if (store.loadJson(instFile, null)) return refreshInstall(cfg);
  const exists = fs.existsSync(cfg);
  const text = exists ? fs.readFileSync(cfg, 'utf8') : '';
  const backup = `${cfg}.bak-${today()}-sidebar`;
  if (exists && !fs.existsSync(backup)) fs.copyFileSync(cfg, backup);
  const patched = configpatch.patchConfig(text);
  fs.writeFileSync(cfg, patched.text);
  const check = herdrRun(['config', 'check']);
  if (check.status !== 0) {
    if (exists) fs.writeFileSync(cfg, text); else fs.unlinkSync(cfg);
    fail(`herdr did not accept the new settings, the file is back as it was:\n${check.stdout || ''}${check.stderr || ''}`);
  }
  store.saveJson(instFile, {
    configFile: cfg, backup: exists ? backup : null, originalRows: patched.originalRows, hadTable: patched.hadTable,
    at: new Date().toISOString(),
  });
  writeShims();
  const rl = herdrRun(['server', 'reload-config']);
  say(`herdr settings updated (backup: ${exists ? backup : 'there was no file'}).`);
  say(`The herdr-duty command is in ${BIN_DIR}.${onPath(BIN_DIR) ? '' : ` Add that folder to PATH to call herdr-duty from any pane.`}`);
  say(rl.status === 0 ? 'herdr reloaded its settings.' : `herdr did not reload its settings: ${(rl.stderr || rl.stdout || '').trim()}`);
}

// The setup action: install from inside herdr and say how it went in a notice,
// because herdr keeps an action's output in its log only.
async function setup() {
  const sock = process.env.HERDR_SOCKET_PATH;
  const toast = body => (sock ? makeHerdr(sock).notify('Sidebar Organizer', body).catch(() => {}) : Promise.resolve());
  try {
    await install();
  } catch (e) {
    await toast(e.message);
    throw e;
  }
  await toast('Set up. Open the window: prefix (Ctrl+B), then Shift+S.');
}

async function uninstall() {
  if (!process.env.HERDR_SOCKET_PATH) fail(INSIDE);
  // The helper restores the order first; if it cannot, stop here and change nothing else.
  let r;
  try {
    r = await helper('uninstall', {});
  } catch (e) {
    fail(`Could not restore the order: ${e.message}
herdr settings and the plugin are untouched. Try again later.`);
  }
  say('Workspace order restored, category titles and marks removed.');
  if (r && r.detachedLeft) say(`Detached copies left: ${r.detachedLeft} — they stay separate workspaces.`);
  const cfgDir = pluginConfigDir();
  const instFile = path.join(cfgDir, 'install.json');
  const inst = store.loadJson(instFile, null);
  if (inst && fs.existsSync(inst.configFile)) {
    const text = fs.readFileSync(inst.configFile, 'utf8');
    fs.writeFileSync(inst.configFile, configpatch.unpatchConfig(text, inst));
    fs.renameSync(instFile, path.join(cfgDir, `install.removed-${today()}.json`));
    herdrRun(['server', 'reload-config']);
    say('herdr settings restored.');
  }
  removeShims();
  // A linked copy is unlinked here; one installed from GitHub is removed with herdr plugin uninstall.
  const un = herdrRun(['plugin', 'unlink', PLUGIN_ID]);
  say(un.status === 0 ? 'The plugin is unlinked from herdr.' : `To remove the plugin itself: herdr plugin uninstall ${PLUGIN_ID}`);
}

async function status() {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) fail(INSIDE);
  try {
    const p = await ipc.request(paths.daemonPipe(sock), 'ping', {}, 3000);
    say(`Helper is running: pid ${p.pid}, session ${p.session}, connected to herdr: ${p.connected ? 'yes' : 'no'}.`);
    const v = await ipc.request(paths.daemonPipe(sock), 'view', {}, 10000);
    for (const c of v.categories) say(`  ${c.name}: ${c.units.length}`);
    const d = await ipc.request(paths.daemonPipe(sock), 'duty.status', {}, 10000);
    for (const x of d) say(`  duty ${x.label || x.wsId}: ${x.token}`);
  } catch (e) {
    say(`The helper does not answer: ${e.message}`);
  }
}

async function open() {
  let ctx = {};
  try { ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}'); } catch {}
  const wsId = ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || '';
  await require('./ensure').ensureDaemon();
  await makeHerdr(process.env.HERDR_SOCKET_PATH).openPluginPane('panel', wsId ? { SIDEBAR_FOCUS_WS: wsId } : {});
}

async function workspacesNow(h) {
  const [workspaces, panes] = await Promise.all([h.listWorkspaces(), h.listPanes()]);
  const firstCwd = {};
  for (const p of panes) if (!(p.workspace_id in firstCwd)) firstCwd[p.workspace_id] = p.cwd || '';
  return { workspaces, firstCwd };
}

// Focus what hotkey slot N points at. Reads the helper's saved state and talks
// to herdr directly, so it works even while the helper is restarting.
async function jumpTo(h, state, slot) {
  const hk = (state.hotkeys || []).find(x => x.slot === Number(slot));
  if (!hk) {
    await h.notify('Hotkey', 'This key is not bound to anything. To bind it: prefix (Ctrl+B), then Shift+S, select a project, K.');
    return 'unbound';
  }
  const { workspaces, firstCwd } = await workspacesNow(h);
  const w = hotkeys.findWorkspace(hk.target, workspaces, firstCwd);
  if (!w) {
    await h.notify(`${hotkeys.displayKey(hk.key)}: "${hk.target.label}" not found`, 'The project is closed or renamed. Bind the key again: prefix (Ctrl+B), then Shift+S, K.');
    return 'missing';
  }
  await h.focusWorkspace(w.workspace_id);
  if (!hk.target.tabId) return w.workspace_id;
  const t = hotkeys.findTab(hk.target, await h.listTabs(w.workspace_id), w.workspace_id);
  if (!t) {
    await h.notify(`${hotkeys.displayKey(hk.key)}: no tab "${hk.target.tabLabel}"`, `Opened "${w.label}". Bind the key again: prefix (Ctrl+B), then Shift+S, K.`);
    return w.workspace_id;
  }
  await h.focusTab(t.tab_id);
  return t.tab_id;
}

// Alt+N: the next workspace with a star of kind N (see stars.nextStar).
// lastId is the workspace of this kind the key went to last time.
async function starJump(h, state, kind, lastId) {
  const k = stars.KINDS.find(x => x.kind === Number(kind)) || { kind, name: '' };
  const title = `★${k.kind} ${k.name}`;
  if (!(state.stars || []).some(s => stars.kindOf(s) === k.kind)) {
    await h.notify(title, `Nothing has this star. Put it on the open project with F${k.kind}, or in the window: prefix (Ctrl+B), then Shift+S, S.`);
    return 'none';
  }
  const { workspaces, firstCwd } = await workspacesNow(h);
  const w = stars.nextStar(state.stars, workspaces, firstCwd, k.kind, lastId);
  if (!w) {
    await h.notify(title, 'The projects with this star are closed right now.');
    return 'missing';
  }
  await h.focusWorkspace(w.workspace_id);
  return w.workspace_id;
}

function savedState() {
  const sock = process.env.HERDR_SOCKET_PATH;
  const root = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!sock || !root) fail('Jumps run from herdr on a hotkey.');
  const dir = paths.sessionDir(root, sock);
  return { h: makeHerdr(sock), dir, state: store.loadState(path.join(dir, 'state.json')) };
}

async function jump(slot) {
  const { h, state } = savedState();
  await jumpTo(h, state, slot);
}

// F1…F4: the helper owns the stars, so it puts or takes off the star; the
// sidebar shows the result. Only a failure becomes a notice.
async function starToggle(kind) {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) fail('Stars are put on from herdr with F1…F4.');
  try {
    await helper('star.toggle', { kind: Number(kind) });
  } catch (e) {
    await makeHerdr(sock).notify('Star', e.message).catch(() => {});
  }
}

// Alt+0: every star off, or back again; a notice says which.
async function starReset() {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) fail('Stars are taken off from herdr with Alt+0.');
  let note;
  try {
    note = stars.resetNote(await helper('star.reset', {}));
  } catch (e) {
    note = e.message;
  }
  await makeHerdr(sock).notify('Stars', note).catch(() => {});
}

// The helper owns state.json, so where each star key went last is kept apart.
async function star(kind) {
  const { h, dir, state } = savedState();
  const file = path.join(dir, 'star-last.json');
  const last = store.loadJson(file, {});
  const id = await starJump(h, state, kind, last[kind]);
  if (id !== 'none' && id !== 'missing') store.saveJson(file, { ...last, [kind]: id });
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'duty') return duty(rest);
  if (cmd === 'setup') return setup();
  if (cmd === 'install') return install();
  if (cmd === 'uninstall') return uninstall();
  if (cmd === 'status') return status();
  if (cmd === 'open') return open();
  if (cmd === 'jump') return jump(rest[0]);
  if (cmd === 'star') return star(rest[0]);
  if (cmd === 'star-toggle') return starToggle(rest[0]);
  if (cmd === 'star-reset') return starReset();
  say('Commands: duty …, setup, install, uninstall, status, open');
  say(USAGE);
  return undefined;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => {
    process.stderr.write(`${e.message}\n`);
    process.exit(e.exitCode || 1);
  });
}

module.exports = { parseArgs, USAGE, jumpTo, starJump };
