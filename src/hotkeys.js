'use strict';
// Hotkeys that jump to a workspace or to one of its tabs: the keys on offer,
// bindings already taken elsewhere, the config lines, and finding the target
// again after a rename or a herdr restart. Everything here is pure.
const { normPath } = require('./paths');

const MAX_SLOTS = 30; // herdr-plugin.toml declares the actions jump-1 … jump-30
// Digits and function keys do not depend on the keyboard layout (Russian or
// English), and Windows Terminal leaves Alt+digit and these F keys alone.
const CHOICES = [
  ...'1234567890'.split('').map(d => `alt+${d}`),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map(n => `f${n}`),
];
const MOD_ORDER = ['prefix', 'ctrl', 'alt', 'shift', 'cmd', 'super'];
const MOD_ALIAS = { control: 'ctrl', option: 'alt', meta: 'alt', win: 'super' };
const MOD_SHOW = { prefix: 'prefix', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Cmd', super: 'Super' };

// One comparable spelling: lower case, modifiers in a fixed order, key last.
// Returns null for something that is not a usable binding.
function normKey(s) {
  const parts = String(s || '').toLowerCase().replace(/\s+/g, '').split('+');
  const key = parts.pop();
  if (!key || parts.some(p => !p)) return null;
  const mods = parts.map(p => MOD_ALIAS[p] || p);
  if (mods.some(m => !MOD_ORDER.includes(m)) || new Set(mods).size !== mods.length) return null;
  if (MOD_ORDER.includes(key)) return null;
  // A bare letter or digit would swallow ordinary typing.
  if (!mods.length && !/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return null;
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, key].join('+');
}

function displayKey(k) {
  const parts = String(k).split('+');
  const key = parts.pop();
  const shown = key.length === 1 || /^f\d+$/.test(key) ? key.toUpperCase() : key;
  return [...parts.map(p => MOD_SHOW[p] || p), shown].join('+');
}

// "prefix+1..9" stands for nine bindings.
function expandRange(v) {
  const m = String(v).match(/^(.*?)(\d)\.\.(\d)$/);
  if (!m) return [v];
  const out = [];
  for (let d = Number(m[2]); d <= Number(m[3]); d++) out.push(`${m[1]}${d}`);
  return out;
}

const tomlStrings = v => [...String(v).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
const tableName = line => {
  const m = line.match(/^\s*(\[\[?)\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*(#.*)?$/);
  return m ? (m[1] === '[[' ? `[[${m[2]}]]` : m[2]) : null;
};

// Bindings that belong to herdr itself or to other plugins: normKey -> who.
// Lines between ourBegin and ourEnd are the plugin's own and do not count.
// defaultsText is `herdr --default-config`: its commented key lines are the
// built-in bindings, except the ones config.toml sets to something else.
function usedKeys(configText, defaultsText, ourBegin, ourEnd) {
  const used = new Map();
  const add = (v, who) => {
    for (const x of expandRange(v)) {
      const k = normKey(x);
      if (k && !used.has(k)) used.set(k, who);
    }
  };
  const overridden = new Set();
  let table = null;
  let ours = false;
  let cmd = null;
  const flush = () => {
    if (cmd && cmd.key) add(cmd.key, cmd.desc ? `«${cmd.desc}»` : 'другая команда herdr');
    cmd = null;
  };
  for (const line of String(configText || '').split(/\r?\n/)) {
    const t = line.trim();
    if (t === ourBegin) { flush(); ours = true; continue; }
    if (t === ourEnd) { ours = false; table = null; continue; }
    if (ours) continue;
    const name = tableName(t);
    if (name) { flush(); table = name; if (name === '[[keys.command]]') cmd = {}; continue; }
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!m) continue;
    if (table === 'keys') {
      overridden.add(m[1]);
      for (const v of tomlStrings(m[2])) add(v, `herdr: ${m[1]}`);
    } else if (table === 'keys.indexed') {
      for (const v of tomlStrings(m[2])) if (v) add(`${v}+1..9`, `herdr: ${m[1]}`);
    } else if (table === '[[keys.command]]' && cmd) {
      const v = tomlStrings(m[2])[0];
      if (m[1] === 'key') cmd.key = v;
      else if (m[1] === 'description' && v) cmd.desc = v;
    }
  }
  flush();
  let inKeys = false;
  for (const line of String(defaultsText || '').split(/\r?\n/)) {
    const t = line.replace(/^\s*#\s?/, '').trim();
    if (/^\[.+\]$/.test(t)) { inKeys = t === '[keys]'; continue; }
    if (/^Navigate-mode/i.test(t)) inKeys = false; // those keys only work inside navigate mode
    if (!inKeys) continue;
    const m = t.match(/^([a-z_]+)\s*=\s*"([^"]+)"/);
    if (m && m[1] !== 'prefix' && !overridden.has(m[1])) add(m[2], `herdr: ${m[1]}`);
  }
  return used;
}

const tomlEsc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]+/g, ' ');
const targetText = t => (t.tabLabel ? `${t.label} › ${t.tabLabel}` : t.label);

function bindingLines(hotkeys, pluginId) {
  const out = [];
  for (const hk of [...hotkeys].sort((a, b) => a.slot - b.slot)) {
    out.push('[[keys.command]]', `key = "${tomlEsc(hk.key)}"`, 'type = "plugin_action"',
      `command = "${pluginId}.jump-${hk.slot}"`, `description = "${tomlEsc(`прыжок: ${targetText(hk.target)}`)}"`);
  }
  return out;
}

function nextSlot(hotkeys) {
  const taken = new Set(hotkeys.map(h => h.slot));
  for (let s = 1; s <= MAX_SLOTS; s++) if (!taken.has(s)) return s;
  return null;
}

// The folder a workspace stands for: its worktree checkout, else its first pane's folder.
function wsPath(w, paths) {
  const p = w.worktree && w.worktree.checkout_path ? w.worktree.checkout_path : (paths || {})[w.workspace_id];
  return normPath(p);
}

// The workspace a hotkey points at. The id alone is not proof: after a herdr
// restart an id can belong to another workspace, so the name decides, the
// folder breaks ties, and an id whose name changed counts only if its folder
// is still the same (renamed while herdr was down).
function findWorkspace(target, workspaces, paths) {
  const byId = workspaces.find(w => w.workspace_id === target.wsId);
  if (byId && byId.label === target.label) return byId;
  const same = workspaces.filter(w => w.label === target.label);
  if (same.length) return same.find(w => target.path && wsPath(w, paths) === target.path) || same[0];
  if (byId && target.path && wsPath(byId, paths) === target.path) return byId;
  return null;
}

function findTab(target, tabs, wsId) {
  if (!target.tabId) return null;
  const own = tabs.filter(t => t.workspace_id === wsId);
  return own.find(t => t.tab_id === target.tabId && t.label === target.tabLabel)
    || own.find(t => t.label === target.tabLabel)
    || own.find(t => t.tab_id === target.tabId)
    || null;
}

// Follow renames and new ids. continuous: the helper saw the previous cycle,
// so a known id whose name or folder is unchanged is the same workspace.
function refreshTargets(hotkeys, workspaces, paths, continuous) {
  let changed = false;
  const out = hotkeys.map(hk => {
    const t = hk.target;
    const byId = workspaces.find(w => w.workspace_id === t.wsId);
    const keep = continuous && byId && (byId.label === t.label || wsPath(byId, paths) === t.path);
    const w = keep ? byId : findWorkspace(t, workspaces, paths);
    if (!w) return hk;
    const next = { ...t, wsId: w.workspace_id, label: w.label, path: wsPath(w, paths) || t.path };
    if (next.wsId === t.wsId && next.label === t.label && next.path === t.path) return hk;
    changed = true;
    return { ...hk, target: next };
  });
  return { hotkeys: out, changed };
}

module.exports = {
  MAX_SLOTS, CHOICES, normKey, displayKey, usedKeys, bindingLines, nextSlot, wsPath, findWorkspace, findTab,
  refreshTargets, targetText,
};
