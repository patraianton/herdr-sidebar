#!/usr/bin/env node
'use strict';
// The plugin window (a herdr popup): categories, moves, worktree detach, duty, hotkeys, stars.
const path = require('node:path');
const { spawn } = require('node:child_process');
const ipc = require('./ipc');
const paths = require('./paths');
const core = require('./uicore');
const stars = require('./stars');

const SOCK = process.env.HERDR_SOCKET_PATH;
if (!SOCK) { process.stderr.write('Окно плагина открывается из herdr.\n'); process.exit(2); }
const PIPE = paths.daemonPipe(SOCK);
const out = process.stdout;
const inp = process.stdin;
const NONE = core.NONE_ID;
const LIST_TOP = 3; // screen row (1-based) of the first list line
const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', rev: '\x1b[7m', ul: '\x1b[4m',
  yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m',
};
const HELP = [
  '↑/↓, PgUp/PgDn, Home/End — выбрать строку',
  'Shift+↑/↓ или J/K — двигать проект или категорию',
  'Мышь: щелчок — выбрать; перетащить строку — переставить',
  'm — в другую категорию;  Enter — меню действий',
  '→/← — показать или скрыть копии проекта',
  'w — вынести копию из проекта / вернуть обратно',
  't — дежурство: включить, сменить интервал, снять',
  'k — горячая клавиша: прыжок к проекту (или к его вкладке) одним нажатием',
  's — звёздочка: 1 мой проект, 2 первая работа, 3 вторая, 4 третья; или снять',
  'Alt+1…Alt+4 (окно закрыто) — по кругу между проектами со звёздочкой этого вида',
  'n — новая категория;  r — переименовать;  x — удалить',
  'U — выключить плагин и вернуть всё как было',
  'q или Esc — закрыть окно',
  'В «Без категории» порядок как в herdr: там двигайте мышью в панели herdr.',
];

function contextWs() {
  if (process.env.SIDEBAR_FOCUS_WS) return process.env.SIDEBAR_FOCUS_WS;
  try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}').workspace_id || null; } catch { return null; }
}

const S = {
  view: null, rows: [], cursor: 0, scroll: 0, expanded: new Set(), mode: null,
  msg: '', msgErr: false, msgAt: 0, busy: false, focusWs: contextWs(), drag: null, hover: -1, menuBox: null,
};
let quitting = false;

const call = (cmd, args) => ipc.request(PIPE, cmd, args || {}, 120000);
function setMsg(text, err = false) { S.msg = text; S.msgErr = err; S.msgAt = Date.now(); }
// The last column stays empty: erasing to the end of a full line would eat its last character.
function size() { return { W: Math.max(40, (out.columns || 80) - 1), H: Math.max(14, out.rows || 24) }; }
const listHeight = () => size().H - 6;
const realCats = () => (S.view ? S.view.categories.filter(c => c.id !== NONE) : []);

function rebuild(keepId) {
  if (S.focusWs && S.view && S.view.ready) {
    const loc = core.locateWs(S.view, S.focusWs);
    if (loc) {
      if (loc.child) S.expanded.add(loc.unitKey);
      keepId = loc.child ? `child:${S.focusWs}` : `unit:${loc.unitKey}`;
    }
    S.focusWs = null;
  }
  S.rows = core.flattenRows(S.view, S.expanded);
  if (keepId) {
    const i = S.rows.findIndex(r => core.rowId(r) === keepId);
    if (i >= 0) S.cursor = i;
  }
  S.cursor = Math.max(0, Math.min(S.cursor, S.rows.length - 1));
}

async function refresh() {
  const cur = S.rows[S.cursor];
  const keep = cur ? core.rowId(cur) : null;
  try { S.view = await call('view'); } catch (e) { setMsg(`Помощник плагина не отвечает: ${e.message}`, true); }
  rebuild(keep);
}

// ---- drawing ----

function formatRow(r, W, selected, dropHint) {
  const pre = selected ? A.rev : (dropHint ? A.ul + A.cyan : '');
  if (r.type === 'cat') {
    const name = r.catId === NONE ? 'БЕЗ КАТЕГОРИИ' : r.name.toUpperCase();
    return pre + A.bold + A.yellow + core.fit(` ━━ ${name} ━━  (${r.count})`, W) + A.reset;
  }
  const child = r.type === 'child';
  const item = child ? r.child : r.unit;
  let head = '     ';
  if (child) head = '       └ ';
  else if (r.unit.kind === 'group') head = S.expanded.has(r.unit.key) ? '   ▾ ' : '   ▸ ';
  let extra = '';
  if (!child && r.unit.kind === 'group') extra = `  [копий: ${r.unit.children.length}]`;
  else if (!child && r.unit.detached) extra = `  ⎇ ${r.unit.detached.parentLabel}`;
  else if (!child && r.unit.linked) extra = '  (копия)';
  const duties = item.duty || [];
  const d = duties.find(x => x.alert) || duties[0];
  const right = d ? d.text : '';
  const rw = right ? [...right].length + 2 : 0;
  const color = d ? (d.alert ? A.red + A.bold : A.green) : '';
  const keys = (item.keys || []).map(k => k.display).join(' ');
  const kw = keys ? [...keys].length + 2 : 0;
  // every head starts with two spaces; a star with its number takes them
  const star = item.star ? `${starColor(item.star)}★${item.star}${A.reset}${pre}` : '  ';
  return pre + star + core.fit(head.slice(2) + item.label + extra, W - 2 - rw - kw) + (keys ? `  ${A.cyan}${keys}` : '')
    + (right ? `  ${color}${right}` : '') + A.reset;
}

function overlay(lines, W, H) {
  const m = S.mode;
  let body = [];
  let off = 0;
  if (m.type === 'menu') {
    const room = Math.max(3, H - 6);
    off = Math.max(0, Math.min(m.sel, m.items.length - room, Math.max(m.off || 0, m.sel - room + 1)));
    m.off = off;
    body = m.items.slice(off, off + room).map((it, j) => {
      const i = off + j;
      return `${i === m.sel ? '▶' : ' '} ${i < 9 ? `${i + 1}.` : '  '} ${it.label}`;
    });
  }
  else if (m.type === 'input') body = [`${m.value}▏`, '', 'Enter — готово, Esc — отмена'];
  else if (m.type === 'confirm') body = ['y или д — да;  n, н или Esc — нет'];
  else if (m.type === 'help') body = [...HELP, '', 'Любая клавиша — закрыть'];
  const title = m.title || '';
  const inner = Math.min(W - 4, Math.max(36, [...title].length + 2, ...body.map(b => [...b].length + 2)));
  const left = Math.max(0, Math.floor((W - inner - 2) / 2));
  const top = Math.max(1, Math.floor((H - body.length - 4) / 2));
  const pad = ' '.repeat(left);
  const box = [
    `${pad}┌${'─'.repeat(inner)}┐`,
    `${pad}│${A.bold}${core.fit(` ${title}`, inner)}${A.reset}│`,
    `${pad}├${'─'.repeat(inner)}┤`,
    ...body.map((b, i) => `${pad}│${m.type === 'menu' && i + off === m.sel ? A.rev : ''}${core.fit(` ${b}`, inner)}${A.reset}│`),
    `${pad}└${'─'.repeat(inner)}┘`,
  ];
  S.menuBox = { firstItemY: top + 4, off, shown: m.type === 'menu' ? body.length : 0 };
  box.forEach((l, i) => { if (top + i < lines.length) lines[top + i] = l; });
}

function render() {
  if (quitting) return;
  const { W, H } = size();
  const LH = listHeight();
  if (S.cursor < S.scroll) S.scroll = S.cursor;
  if (S.cursor >= S.scroll + LH) S.scroll = S.cursor - LH + 1;
  S.scroll = Math.max(0, Math.min(S.scroll, Math.max(0, S.rows.length - LH)));
  const session = S.view && S.view.session && S.view.session !== 'default' ? `  [сессия ${S.view.session}]` : '';
  const lines = [
    A.bold + core.fit(` Категории и дежурства${session}`, W - 12) + A.reset + A.dim + core.fit('? — помощь', 12) + A.reset,
    A.dim + '─'.repeat(W) + A.reset,
  ];
  if (!S.view || !S.view.ready) {
    lines.push(core.fit(S.view ? ' Помощник ещё собирает данные…' : ' Загрузка…', W));
  } else {
    for (let i = 0; i < LH; i++) {
      const idx = S.scroll + i;
      const r = S.rows[idx];
      lines.push(r ? formatRow(r, W, idx === S.cursor, !!S.drag && idx === S.hover && idx !== S.drag.from) : '');
    }
  }
  while (lines.length < LH + 2) lines.push('');
  lines.length = LH + 2;
  lines.push(A.dim + '─'.repeat(W) + A.reset);
  const fresh = S.msg && Date.now() - S.msgAt < 8000;
  lines.push(S.busy ? A.cyan + core.fit(' …работаю', W) + A.reset
    : (fresh ? (S.msgErr ? A.red : A.cyan) + core.fit(` ${S.msg}`, W) + A.reset : ''));
  lines.push(A.dim + core.fit(' ↑↓ выбор · Shift+↑↓ двигать · m в категорию · s звёздочка · k клавиша · Enter меню', W) + A.reset);
  lines.push(A.dim + core.fit(' →/← копии · n новая · r переименовать · x удалить · w вынести · t дежурство · q выход', W) + A.reset);
  if (S.mode) overlay(lines, W, H);
  out.write(`\x1b[H${lines.map(l => `${l}\x1b[0m\x1b[K`).join('\r\n')}\x1b[J`);
}

// ---- actions ----

async function act(fn, okMsg) {
  if (S.busy) return;
  S.busy = true;
  render();
  try {
    const res = await fn();
    if (okMsg) setMsg(typeof okMsg === 'function' ? okMsg(res) : okMsg);
  } catch (e) {
    setMsg(e.message, true);
  }
  S.busy = false;
  await refresh();
  render();
}

const menu = (title, items, sel = 0) => { S.mode = { type: 'menu', title, items, sel: Math.max(0, Math.min(sel, items.length - 1)) }; };
const input = (title, value, onDone) => { S.mode = { type: 'input', title, value: value || '', onDone }; };
const confirm = (title, onYes) => { S.mode = { type: 'confirm', title, onYes }; };

function move(delta) { S.cursor = Math.max(0, Math.min(S.rows.length - 1, S.cursor + delta)); }

function expand(r, open) {
  if (!r) return;
  if (r.type === 'child' && !open) {
    S.expanded.delete(r.unit.key);
    rebuild(`unit:${r.unit.key}`);
    return;
  }
  if (r.type !== 'unit' || r.unit.kind !== 'group') return;
  if (open) S.expanded.add(r.unit.key); else S.expanded.delete(r.unit.key);
  rebuild(core.rowId(r));
}

function shift(r, delta) {
  if (!r || !S.view) return undefined;
  if (r.type === 'cat') {
    if (r.catId === NONE) return setMsg('«Без категории» всегда внизу.');
    const i = realCats().findIndex(c => c.id === r.catId);
    const to = i + delta;
    if (to < 0 || to >= realCats().length) return undefined;
    return act(() => call('category.move', { id: r.catId, toIndex: to }));
  }
  if (r.type === 'child') return setMsg('Копия ездит вместе со своим проектом. Чтобы поставить её отдельно, вынесите её: w');
  const t = core.stepTarget(S.view, r.catId, r.index, delta);
  if (!t) return undefined;
  if (t.catId === NONE && r.catId === NONE) return setMsg('В «Без категории» порядок как в herdr: двигайте мышью в панели herdr.');
  return act(() => call('unit.move', { key: r.unit.key, catId: t.catId, index: t.index }));
}

function drop(from, to) {
  if (!from || !to) return undefined;
  if (from.type === 'cat') {
    if (from.catId === NONE) return setMsg('«Без категории» всегда внизу.');
    let toIndex = realCats().findIndex(c => c.id === to.catId);
    if (toIndex < 0) toIndex = realCats().length - 1;
    return act(() => call('category.move', { id: from.catId, toIndex }));
  }
  if (from.type === 'child') return setMsg('Копия ездит вместе со своим проектом. Чтобы поставить её отдельно, вынесите её: w');
  const t = core.dropTarget(S.view, from, to);
  if (!t) return undefined;
  if (t.catId === NONE && from.catId === NONE) return setMsg('В «Без категории» порядок как в herdr.');
  return act(() => call('unit.move', { key: from.unit.key, catId: t.catId, index: t.index }));
}

function newCategory() {
  input('Название новой категории', '', name => act(() => call('category.create', { name }), `Категория «${name}» создана`));
}

function renameCategory(r) {
  if (!r || r.type !== 'cat' || r.catId === NONE) return setMsg('Выберите строку категории.', true);
  return input('Новое название', r.name, name => act(() => call('category.rename', { id: r.catId, name }), 'Переименовано'));
}

function deleteCategory(r) {
  if (!r || r.type !== 'cat' || r.catId === NONE) return setMsg('Выберите строку категории.', true);
  return confirm(`Удалить «${r.name}»? Её проекты уйдут в «Без категории».`,
    () => act(() => call('category.delete', { id: r.catId }), 'Категория удалена'));
}

function categoryChoices(run) {
  return [...realCats().map(c => ({ label: c.name, run: () => run(c.id, c.name) })),
    { label: 'Без категории', run: () => run(NONE, 'Без категории') }];
}

function pickCategory(r) {
  if (!r || r.type !== 'unit') return setMsg('Выберите проект.', true);
  if (!realCats().length) return setMsg('Сначала создайте категорию: n', true);
  return menu(`Куда перенести «${r.unit.label}»?`,
    categoryChoices((catId, name) => act(() => call('unit.move', { key: r.unit.key, catId, index: 1e9 }), `Перенесено в «${name}»`)),
    Math.max(0, realCats().findIndex(c => c.id === r.catId)));
}

function detachOrReturn(r) {
  if (!r) return undefined;
  if (r.type === 'child') {
    return menu(`Вынести «${r.child.label}» из «${r.unit.label}». В какую категорию?`,
      categoryChoices(catId => act(() => call('unit.detach', { wsId: r.child.wsId, catId }), 'Копия вынесена. Окна и агенты работают как прежде.')),
      Math.max(0, realCats().findIndex(c => c.id === r.catId)));
  }
  if (r.type === 'unit' && r.unit.detached) {
    return confirm(`Вернуть «${r.unit.label}» в проект «${r.unit.detached.parentLabel}»?`,
      () => act(() => call('unit.reattach', { wsId: r.unit.anchorId }), 'Копия вернулась в проект'));
  }
  if (r.type === 'unit' && r.unit.kind === 'group') {
    S.expanded.add(r.unit.key);
    rebuild(core.rowId(r));
    return setMsg('Выберите копию в раскрытом списке и нажмите w.');
  }
  if (r.type === 'unit' && r.unit.linked) return setMsg('Эта копия и так стоит отдельно: её основной проект сейчас закрыт.');
  return setMsg('Выносить можно только копию проекта (worktree).', true);
}

const INTERVALS = [['15 минут', '15m'], ['30 минут', '30m'], ['1 час', '1h'], ['2 часа', '2h']];

function dutyMenu(wsId, item) {
  const start = paneId => {
    const run = every => act(() => call('duty.start', { wsId, paneId, every, source: 'manual' }), r => `Дежурство включено: раз в ${r.every}`);
    menu('Как часто агент должен просыпаться?', [
      ...INTERVALS.map(([label, v]) => ({ label, run: () => run(v) })),
      { label: 'Своё значение…', run: () => input('Интервал, например 45m, 3h, 90', '', v => run(v)) },
    ], 1);
  };
  const duties = item.duty || [];
  const d = duties.find(x => x.alert) || duties[0];
  if (d) {
    return menu(`Дежурство: ${d.text}`, [
      { label: 'Изменить интервал…', run: () => start(d.paneId) },
      ...(d.alert ? [{ label: 'Сбросить тревогу', run: () => act(() => call('duty.reset', { id: d.id }), 'Тревога сброшена') }] : []),
      { label: 'Снять дежурство', run: () => act(() => call('duty.stop', { id: d.id }), 'Дежурство снято') },
    ]);
  }
  const agents = item.agents || [];
  if (!agents.length) return setMsg('В этом рабочем месте нет агента — дежурство не к кому привязать.', true);
  if (agents.length === 1) return start(agents[0].paneId);
  return menu('Какой агент дежурит?', agents.map(a => ({ label: `${a.agent} · ${a.title || a.paneId}`, run: () => start(a.paneId) })));
}

function dutyMenuFor(r) {
  if (!r || r.type === 'cat') return setMsg('Выберите проект.', true);
  return r.type === 'child' ? dutyMenu(r.child.wsId, r.child) : dutyMenu(r.unit.anchorId, r.unit);
}

function keyMenu(m, wsId, tabId, title) {
  const set = key => act(() => call('hotkey.set', { key, wsId, tabId }), res => {
    let t = `${res.display} → «${res.label}»`;
    if (res.takenFrom) t += `, у «${res.takenFrom}» она снята`;
    if (res.replaced) t += `, прежняя ${res.replaced} снята`;
    if (res.reloaded === false) t += '. herdr не перечитал настройки: нажмите Ctrl+B, потом Shift+R';
    return t;
  });
  const items = m.current.map(c => ({
    label: `Снять ${c.display}${c.tabLabel ? ` (вкладка «${c.tabLabel}»)` : ''}`,
    run: () => act(() => call('hotkey.clear', { key: c.key }), `${c.display} снята`),
  }));
  const first = items.length;
  for (const c of m.choices) items.push({ label: c.owner ? `${c.display}    сейчас: ${c.owner}` : c.display, run: () => set(c.key) });
  items.push({ label: 'Своя комбинация…', run: () => input('Сочетание, например ctrl+alt+k, prefix+alt+1, f9', '', v => set(v)) });
  const free = m.choices.findIndex(c => !c.owner);
  menu(`Клавиша для «${title}»`, items, free >= 0 ? first + free : first);
}

async function hotkeyFor(r) {
  if (S.busy) return undefined;
  if (!r || r.type === 'cat') return setMsg('Выберите проект.', true);
  const wsId = r.type === 'child' ? r.child.wsId : r.unit.anchorId;
  const label = r.type === 'child' ? r.child.label : r.unit.label;
  let m;
  S.busy = true;
  render();
  try { m = await call('hotkey.menu', { wsId }); } catch (e) { setMsg(e.message, true); } finally { S.busy = false; }
  if (m && m.tabs.length < 2) keyMenu(m, wsId, null, label);
  else if (m) {
    menu(`«${label}»: куда прыгать по клавише?`, [
      { label: 'В проект (на вкладку, открытую последней)', run: () => keyMenu(m, wsId, null, label) },
      ...m.tabs.map(t => ({ label: `На вкладку «${t.label || t.tabId}»`, run: () => keyMenu(m, wsId, t.tabId, `${label} › ${t.label}`) })),
    ]);
  }
  render(); // the answer came after the key press was drawn
  return undefined;
}

// The sidebar colour of a kind, as a terminal colour.
function starColor(kind) {
  const k = stars.KINDS.find(x => x.kind === kind);
  if (!k) return A.yellow;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(k.color.slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m`;
}

// s: pick the kind of star (the digit picks it straight away) or take it off.
function starMenu(r) {
  if (!r || r.type === 'cat') return setMsg('Выберите проект.', true);
  const item = r.type === 'child' ? r.child : r.unit;
  const wsId = r.type === 'child' ? r.child.wsId : r.unit.anchorId;
  const set = kind => act(() => call('star.set', { wsId, kind }), res => (res.kind
    ? `★${res.kind} «${res.label}»: ${stars.KINDS[res.kind - 1].name}. Переход между ними: Alt+${res.kind}`
    : `Звёздочка с «${res.label}» снята`));
  const items = stars.KINDS.map(k => ({
    label: `★${k.kind} ${k.name} — Alt+${k.kind}${item.star === k.kind ? '   (сейчас)' : ''}`, run: () => set(k.kind),
  }));
  if (item.star) items.push({ label: 'Снять звёздочку', run: () => set(0) });
  return menu(`Звёздочка для «${item.label}»`, items, item.star ? item.star - 1 : 0);
}

function openMenu(r) {
  if (!r) return undefined;
  const items = [];
  if (r.type === 'cat') {
    items.push({ label: 'Новая категория', run: () => newCategory() });
    if (r.catId !== NONE) {
      items.push({ label: 'Переименовать', run: () => renameCategory(r) });
      items.push({ label: 'Поднять выше', run: () => shift(r, -1) });
      items.push({ label: 'Опустить ниже', run: () => shift(r, 1) });
      items.push({ label: 'Удалить категорию', run: () => deleteCategory(r) });
    }
  } else if (r.type === 'unit') {
    items.push({ label: 'Перенести в категорию…', run: () => pickCategory(r) });
    if (r.unit.detached) items.push({ label: `Вернуть в проект «${r.unit.detached.parentLabel}»`, run: () => detachOrReturn(r) });
    if (r.unit.kind === 'group') {
      const open = S.expanded.has(r.unit.key);
      items.push({ label: open ? 'Скрыть копии' : 'Показать копии', run: () => expand(r, !open) });
    }
    items.push({ label: 'Дежурство…', run: () => dutyMenuFor(r) });
    items.push({ label: 'Горячая клавиша…', run: () => hotkeyFor(r) });
    items.push({ label: 'Звёздочка…', run: () => starMenu(r) });
  } else {
    items.push({ label: 'Вынести из проекта…', run: () => detachOrReturn(r) });
    items.push({ label: 'Дежурство…', run: () => dutyMenuFor(r) });
    items.push({ label: 'Горячая клавиша…', run: () => hotkeyFor(r) });
    items.push({ label: 'Звёздочка…', run: () => starMenu(r) });
  }
  const title = r.type === 'cat' ? r.name : (r.type === 'child' ? r.child.label : r.unit.label);
  return menu(title, items);
}

function uninstallFlow() {
  const detached = S.view ? S.view.categories.reduce((n, c) => n + c.units.filter(u => u.detached).length, 0) : 0;
  const note = detached ? ` Вынесенных копий: ${detached} — они останутся отдельно; вернуть их можно заранее клавишей w.` : '';
  input(`Выключить плагин и вернуть панель как было?${note} Напишите «да»`, '', v => {
    if (v.trim().toLowerCase() !== 'да') { setMsg('Отменено.'); return; }
    spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'uninstall'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    }).unref();
    setMsg('Выключаю плагин…');
    render();
    setTimeout(quit, 300);
  });
}

// ---- input ----

function runMenuItem(i) {
  const it = S.mode && S.mode.items[i];
  S.mode = null;
  if (it) it.run();
}

function modeKey(ev) {
  const m = S.mode;
  if (m.type === 'help') { S.mode = null; return; }
  if (ev.key === 'escape') { S.mode = null; return; }
  if (m.type === 'menu') {
    if (ev.key === 'up') m.sel = (m.sel + m.items.length - 1) % m.items.length;
    else if (ev.key === 'down') m.sel = (m.sel + 1) % m.items.length;
    else if (ev.key === 'enter') runMenuItem(m.sel);
    else if (ev.char && /^[1-9]$/.test(ev.char) && Number(ev.char) <= m.items.length) runMenuItem(Number(ev.char) - 1);
    return;
  }
  if (m.type === 'input') {
    if (ev.key === 'enter') {
      const v = m.value.trim();
      S.mode = null;
      if (v) m.onDone(v);
    } else if (ev.key === 'backspace') {
      m.value = [...m.value].slice(0, -1).join('');
    } else if (ev.char) {
      m.value += ev.char;
    }
    return;
  }
  if (m.type === 'confirm') {
    if (['y', 'Y', 'д', 'Д'].includes(ev.char)) { S.mode = null; m.onYes(); } else if (['n', 'N', 'н', 'Н'].includes(ev.char)) S.mode = null;
  }
}

function onKey(ev) {
  if (S.mode) { modeKey(ev); return; }
  const r = S.rows[S.cursor];
  const ch = ev.char ? core.latin(ev.char) : null;
  const plain = !ev.shift && !ev.alt;
  if (ev.key === 'up' && plain) move(-1);
  else if (ev.key === 'down' && plain) move(1);
  else if ((ev.key === 'up' && !plain) || ch === 'K') shift(r, -1);
  else if ((ev.key === 'down' && !plain) || ch === 'J') shift(r, 1);
  else if (ev.key === 'pageup') move(-listHeight());
  else if (ev.key === 'pagedown') move(listHeight());
  else if (ev.key === 'home') S.cursor = 0;
  else if (ev.key === 'end') S.cursor = Math.max(0, S.rows.length - 1);
  else if (ev.key === 'right') expand(r, true);
  else if (ev.key === 'left') expand(r, false);
  else if (ev.key === 'enter') openMenu(r);
  else if (ev.key === 'escape' || ch === 'q') quit();
  else if (ch === 'n') newCategory();
  else if (ch === 'r') renameCategory(r);
  else if (ch === 'x' || ev.key === 'delete') deleteCategory(r);
  else if (ch === 'm') pickCategory(r);
  else if (ch === 'w') detachOrReturn(r);
  else if (ch === 't') dutyMenuFor(r);
  else if (ch === 'k') hotkeyFor(r);
  else if (ch === 's' || ev.char === '*') starMenu(r);
  else if (ch === '?' || ev.char === ',') S.mode = { type: 'help', title: 'Помощь' };
  else if (ch === 'U') uninstallFlow();
}

function onMouse(m) {
  if (m.wheel) { if (!S.mode) move(m.wheel === 'down' ? 3 : -3); return; }
  if (S.mode) {
    if (S.mode.type === 'menu' && m.button === 0 && !m.release && !m.motion && S.menuBox) {
      const j = m.y - S.menuBox.firstItemY; // only rows that are on screen
      if (j >= 0 && j < S.menuBox.shown) runMenuItem(S.menuBox.off + j);
    }
    return;
  }
  const idx = S.scroll + (m.y - LIST_TOP);
  const inList = m.y >= LIST_TOP && m.y < LIST_TOP + listHeight() && idx >= 0 && idx < S.rows.length;
  if (m.motion) { if (S.drag) S.hover = inList ? idx : -1; return; }
  if (!m.release && m.button === 0) {
    if (inList) { S.cursor = idx; S.drag = { from: idx }; S.hover = idx; }
    return;
  }
  if (m.release) {
    const drag = S.drag;
    S.drag = null;
    S.hover = -1;
    if (drag && inList && idx !== drag.from) drop(S.rows[drag.from], S.rows[idx]);
  }
}

function restoreTerminal() { out.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l'); }

function quit() {
  if (quitting) return;
  quitting = true;
  restoreTerminal();
  try { if (inp.isTTY) inp.setRawMode(false); } catch {}
  process.exit(0);
}

async function main() {
  out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  if (inp.isTTY) inp.setRawMode(true);
  inp.setEncoding('utf8');
  inp.on('data', chunk => {
    for (const ev of core.parseInput(chunk)) {
      if (ev.key === 'ctrl-c') { quit(); return; }
      if (ev.mouse) onMouse(ev.mouse); else onKey(ev);
    }
    render();
  });
  out.on('resize', render);
  process.on('exit', () => { if (!quitting) restoreTerminal(); });
  render();
  await refresh();
  render();
  setInterval(async () => {
    if (S.mode || S.busy || S.drag) return;
    await refresh();
    render();
  }, 3000);
}

main();
