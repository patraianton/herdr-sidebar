#!/usr/bin/env node
'use strict';
// Command line: `herdr-duty ...` for agents, install/uninstall/status/open for people,
// `jump N` for the hotkeys (herdr runs it through the action jump-N) and
// `star N` for Alt+N, the stars of kind N (the action star-N), and
// `star-toggle N` for FN, the star of kind N on the focused workspace.
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
const TELEGRAM_DEFAULT = { envFile: 'C:\\Users\\me\\projects\\bot\\.env', envKey: 'TELEGRAM_SESSION_BOT_TOKEN', chatId: 0 };

const USAGE = [
  'Дежурный агент (запускать из окна агента в herdr):',
  '  herdr-duty start --every 30m [--note "что охраняю"]   начать дежурство',
  '  herdr-duty ok                                       «я жив» (по желанию, после каждого круга)',
  '  herdr-duty fail "причина"                           сообщить о беде',
  '  herdr-duty stop                                     снять дежурство',
  '  herdr-duty status                                   показать все дежурства',
].join('\n');

const say = s => process.stdout.write(`${s}\n`);
function fail(s, code = 1) { process.stderr.write(`${s}\n`); process.exit(code); }
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
  if (!sock) fail('Эту команду надо запускать внутри herdr (нет HERDR_SOCKET_PATH).');
  const pipe = paths.daemonPipe(sock);
  try { return await ipc.request(pipe, cmd, args); } catch (e) { if (!ipc.isConnError(e)) throw e; }
  herdrRun(['plugin', 'action', 'invoke', `${PLUGIN_ID}.ensure`]);
  const waitMs = Number(process.env.SIDEBAR_HELPER_WAIT_MS) || 10000;
  for (let waited = 0; waited < waitMs; waited += 250) {
    await sleep(250);
    try { return await ipc.request(pipe, cmd, args); } catch (e) { if (!ipc.isConnError(e)) throw e; }
  }
  throw new Error('помощник плагина не запустился (проверьте: herdr plugin list, anton.sidebar должен быть включён)');
}

async function duty(argv) {
  const a = parseArgs(argv);
  const sub = a._[0];
  if (!sub) { say(USAGE); return; }
  if (!process.env.HERDR_SOCKET_PATH) fail('Эту команду надо запускать внутри herdr (нет HERDR_SOCKET_PATH).');
  const who = { paneId: process.env.HERDR_PANE_ID || null, wsId: process.env.HERDR_WORKSPACE_ID || null };
  if (sub === 'start') {
    if (!a.every) fail('Укажите интервал: herdr-duty start --every 30m');
    const r = await helper('duty.start', { ...who, every: a.every, note: a.note, source: 'agent' });
    say(`Дежурство включено: «${r.label || r.wsId}», просыпаться не реже раза в ${r.every}.`);
    say('Признак жизни: herdr-duty ok. Беда: herdr-duty fail "причина". Снять: herdr-duty stop.');
  } else if (sub === 'ok') {
    await helper('duty.ok', who);
    say('Отметка «жив» принята.');
  } else if (sub === 'fail') {
    await helper('duty.fail', { ...who, reason: a._.slice(1).join(' ') });
    say('Беда записана: в панели красная пометка, Антону ушло уведомление.');
  } else if (sub === 'stop') {
    await helper('duty.stop', who);
    say('Дежурство снято.');
  } else if (sub === 'status') {
    const list = await helper('duty.status', {});
    if (!list.length) say('Дежурств нет.');
    for (const d of list) say(`${d.label || d.wsId}: ${d.token}  (раз в ${d.every})`);
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
  if (r.status !== 0 || !dir) fail(`Плагин не подключён к herdr. Сначала: herdr plugin link "${ROOT}"`);
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

function removeShims() {
  for (const f of ['herdr-duty.cmd', 'herdr-duty']) { try { fs.unlinkSync(path.join(BIN_DIR, f)); } catch {} }
}

// A helper still running the old code would write its old key bindings back
// on the next hotkey change, so after a refresh it is started again.
async function restartHelper() {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) { say('Помощник плагина остался на старом коде: перезапустите herdr или выполните install из окна herdr.'); return; }
  const pipe = paths.daemonPipe(sock);
  const alive = async () => { try { return await ipc.request(pipe, 'ping', {}, 2000); } catch { return null; } };
  if (await alive()) {
    try { await ipc.request(pipe, 'shutdown', {}, 3000); } catch {}
    for (let i = 0; i < 40 && await alive(); i++) await sleep(250);
  }
  try {
    const p = await helper('ping', {});
    say(`Помощник плагина перезапущен на новом коде (pid ${p.pid}).`);
  } catch (e) {
    say(`Помощник плагина не запустился: ${e.message}`);
  }
}

// Already installed: bring the sidebar rows and the fixed key bindings up to this version.
async function refreshInstall(cfg) {
  const text = fs.readFileSync(cfg, 'utf8');
  let next;
  try { next = configpatch.refreshConfig(text); } catch (e) { fail(`Не нашёл в ${cfg} строк плагина: ${e.message}`); }
  if (next === text) { say('Уже установлено, настройки herdr свежие.'); return; }
  const backup = `${cfg}.bak-${today()}-sidebar-refresh`;
  if (!fs.existsSync(backup)) fs.copyFileSync(cfg, backup);
  fs.writeFileSync(cfg, next);
  const check = herdrRun(['config', 'check']);
  if (check.status !== 0) {
    fs.writeFileSync(cfg, text);
    fail(`herdr не принял новые настройки, файл возвращён как был:\n${check.stdout || ''}${check.stderr || ''}`);
  }
  writeShims();
  const rl = herdrRun(['server', 'reload-config']);
  say(`Настройки плагина в herdr обновлены (копия: ${backup}).`);
  say(rl.status === 0 ? 'herdr перечитал настройки.' : `herdr не перечитал настройки: ${(rl.stderr || rl.stdout || '').trim()}`);
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
    fail(`herdr не принял новые настройки, файл возвращён как был:\n${check.stdout || ''}${check.stderr || ''}`);
  }
  store.saveJson(instFile, {
    configFile: cfg, backup: exists ? backup : null, originalRows: patched.originalRows, hadTable: patched.hadTable,
    at: new Date().toISOString(),
  });
  const tg = path.join(cfgDir, 'telegram.json');
  if (!fs.existsSync(tg)) store.saveJson(tg, TELEGRAM_DEFAULT);
  writeShims();
  const rl = herdrRun(['server', 'reload-config']);
  say(`Настройки herdr обновлены (копия: ${exists ? backup : 'файла не было'}).`);
  say(`Команда herdr-duty положена в ${BIN_DIR}.`);
  say(rl.status === 0 ? 'herdr перечитал настройки.' : `herdr не перечитал настройки: ${(rl.stderr || rl.stdout || '').trim()}`);
}

async function uninstall() {
  if (!process.env.HERDR_SOCKET_PATH) fail('Откат запускается внутри herdr (нет HERDR_SOCKET_PATH).');
  // The helper restores the order first; if it cannot, stop here and change nothing else.
  let r;
  try {
    r = await helper('uninstall', {});
  } catch (e) {
    fail(`Порядок вернуть не удалось: ${e.message}
Настройки herdr и плагин не тронуты. Повторите позже.`);
  }
  say('Порядок рабочих мест возвращён, названия категорий и пометки сняты.');
  if (r && r.detachedLeft) say(`Вынесенных копий осталось: ${r.detachedLeft} — они остаются отдельными рабочими местами.`);
  const cfgDir = pluginConfigDir();
  const instFile = path.join(cfgDir, 'install.json');
  const inst = store.loadJson(instFile, null);
  if (inst && fs.existsSync(inst.configFile)) {
    const text = fs.readFileSync(inst.configFile, 'utf8');
    fs.writeFileSync(inst.configFile, configpatch.unpatchConfig(text, inst));
    fs.renameSync(instFile, path.join(cfgDir, `install.removed-${today()}.json`));
    herdrRun(['server', 'reload-config']);
    say('Настройки herdr возвращены.');
  }
  removeShims();
  const un = herdrRun(['plugin', 'unlink', PLUGIN_ID]);
  say(un.status === 0 ? 'Плагин отключён от herdr.' : `Отключить плагин не вышло: ${(un.stderr || un.stdout || '').trim()}`);
}

async function status() {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) fail('Запускайте внутри herdr.');
  try {
    const p = await ipc.request(paths.daemonPipe(sock), 'ping', {}, 3000);
    say(`Помощник работает: pid ${p.pid}, сессия ${p.session}, связь с herdr: ${p.connected ? 'есть' : 'нет'}.`);
    const v = await ipc.request(paths.daemonPipe(sock), 'view', {}, 10000);
    for (const c of v.categories) say(`  ${c.name}: ${c.units.length}`);
    const d = await ipc.request(paths.daemonPipe(sock), 'duty.status', {}, 10000);
    for (const x of d) say(`  дежурство ${x.label || x.wsId}: ${x.token}`);
  } catch (e) {
    say(`Помощник не отвечает: ${e.message}`);
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
    await h.notify('Горячая клавиша', 'Эта клавиша ни к чему не привязана. Назначить: Ctrl+B, потом Shift+S, встать на проект, K.');
    return 'unbound';
  }
  const { workspaces, firstCwd } = await workspacesNow(h);
  const w = hotkeys.findWorkspace(hk.target, workspaces, firstCwd);
  if (!w) {
    await h.notify(`${hotkeys.displayKey(hk.key)}: «${hk.target.label}» не найдено`, 'Проект закрыт или переименован. Назначьте клавишу заново: Ctrl+B, потом Shift+S, K.');
    return 'missing';
  }
  await h.focusWorkspace(w.workspace_id);
  if (!hk.target.tabId) return w.workspace_id;
  const t = hotkeys.findTab(hk.target, await h.listTabs(w.workspace_id), w.workspace_id);
  if (!t) {
    await h.notify(`${hotkeys.displayKey(hk.key)}: вкладки «${hk.target.tabLabel}» нет`, `Открыт проект «${w.label}». Назначьте клавишу заново: Ctrl+B, потом Shift+S, K.`);
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
    await h.notify(title, `Нет проектов с этой звёздочкой. Поставить: Ctrl+B, потом Shift+S, встать на проект, S, ${k.kind}.`);
    return 'none';
  }
  const { workspaces, firstCwd } = await workspacesNow(h);
  const w = stars.nextStar(state.stars, workspaces, firstCwd, k.kind, lastId);
  if (!w) {
    await h.notify(title, 'Проекты с этой звёздочкой сейчас закрыты.');
    return 'missing';
  }
  await h.focusWorkspace(w.workspace_id);
  return w.workspace_id;
}

function savedState() {
  const sock = process.env.HERDR_SOCKET_PATH;
  const root = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!sock || !root) fail('Прыжок запускается из herdr по горячей клавише.');
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
  if (!sock) fail('Звёздочка ставится из herdr клавишами F1…F4.');
  try {
    await helper('star.toggle', { kind: Number(kind) });
  } catch (e) {
    await makeHerdr(sock).notify('Звёздочка', e.message).catch(() => {});
  }
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
  if (cmd === 'install') return install();
  if (cmd === 'uninstall') return uninstall();
  if (cmd === 'status') return status();
  if (cmd === 'open') return open();
  if (cmd === 'jump') return jump(rest[0]);
  if (cmd === 'star') return star(rest[0]);
  if (cmd === 'star-toggle') return starToggle(rest[0]);
  say('Команды: duty …, install, uninstall, status, open');
  say(USAGE);
  return undefined;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => fail(e.message));
}

module.exports = { parseArgs, USAGE, jumpTo, starJump };
