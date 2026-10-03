'use strict';
// Edit herdr's config.toml: replace the Spaces rows with our rows and add our
// key bindings (the window and the jump hotkeys), both between marker comments,
// and undo that exactly.
const BEGIN = '# >>> anton.sidebar (плагин «Категории и дежурства»; откат: node sidebar/src/cli.js uninstall)';
const END = '# <<< anton.sidebar';
const KEYS_BEGIN = '# >>> anton.sidebar keys';
const KEYS_END = '# <<< anton.sidebar keys';

// The first row is the category title: only the first project of a category
// reports $section, and a row with no value is not drawn at all.
const STYLED_ROWS = [
  '  [{ token = "$section", fg = "#fabd2f", bold = true }],',
  '  ["state_icon", "workspace", { token = "$key", fg = "#83a598" }],',
  '  ["branch", "git_status"],',
  '  [{ token = "$project", dim = true }],',
  '  [{ token = "$duty", rules = [{ starts_with = "▲", fg = "#fb4934", bold = true }, { starts_with = "◆", fg = "#b8bb26" }] }],',
];
const OPEN_BINDING = [
  '[[keys.command]]',
  'key = "prefix+shift+s"',
  'type = "plugin_action"',
  'command = "anton.sidebar.open"',
  'description = "категории и дежурства"',
];
const keysBlock = (extra = []) => [KEYS_BEGIN, ...OPEN_BINDING, ...extra, KEYS_END];
const squash = s => s.replace(/\s+/g, '');
const DEFAULT_ROWS = new Set(['["state_icon","workspace"]', '["branch","git_status"]']);
// Rows written by this or an earlier version of the plugin; a refresh drops them.
const OUR_ROWS = new Set([
  ...DEFAULT_ROWS,
  ...STYLED_ROWS.map(r => squash(r).replace(/,$/, '')),
  squash('["state_icon", { token = "workspace", rules = [{ starts_with = "━━", fg = "#fabd2f", bold = true }] }]'),
]);
const TABLE_RE = /^\s*\[\[?\s*[A-Za-z0-9_."-]+(\s*\.\s*[A-Za-z0-9_."-]+)*\s*\]\]?\s*(#.*)?$/;

function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { eol, lines: text.split(/\r?\n/) };
}

function findTable(lines, name) {
  return lines.findIndex(l => l.trim().replace(/\s*#.*$/, '') === `[${name}]`);
}

// Walk characters after `rows =` and return the line where the array closes.
function findArrayEnd(lines, startLine) {
  let depth = 0;
  let started = false;
  let str = null;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    let j = i === startLine ? line.indexOf('=') + 1 : 0;
    for (; j < line.length; j++) {
      const ch = line[j];
      if (str) {
        if (str === '"' && ch === '\\') { j++; continue; }
        if (ch === str) str = null;
        continue;
      }
      if (ch === '"' || ch === "'") { str = ch; continue; }
      if (ch === '#') break;
      if (ch === '[') { depth++; started = true; } else if (ch === ']') {
        depth--;
        if (started && depth === 0) return i;
      }
    }
  }
  return -1;
}

function findRows(lines, tableIdx) {
  for (let i = tableIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (TABLE_RE.test(t)) return null;
    if (/^rows\s*=/.test(t)) {
      const end = findArrayEnd(lines, i);
      return end < 0 ? null : { start: i, end };
    }
  }
  return null;
}

// Split the outer array of `rows = [ ... ]` into its top-level elements.
function topLevelElements(rowsText) {
  const s = rowsText.slice(rowsText.indexOf('=') + 1);
  const out = [];
  let depth = 0;
  let str = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (str) {
      cur += ch;
      if (str === '"' && ch === '\\') { cur += s[++i] || ''; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (ch === '"' || ch === "'") { str = ch; cur += ch; continue; }
    if (ch === '[') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    if (depth >= 1) cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function extraRows(rowsText) {
  return topLevelElements(rowsText).filter(e => !DEFAULT_ROWS.has(squash(e)));
}

function rowsBlock(extra) {
  return [BEGIN, 'rows = [', ...STYLED_ROWS, ...extra.map(e => `  ${e},`), ']', END];
}

function patchConfig(text) {
  const { eol, lines } = splitLines(text);
  if (lines.some(l => l.trim() === BEGIN || l.trim() === KEYS_BEGIN)) throw new Error('already installed');
  let originalRows = null;
  const t = findTable(lines, 'ui.sidebar.spaces');
  const hadTable = t >= 0;
  if (hadTable) {
    const r = findRows(lines, t);
    if (r) {
      originalRows = lines.slice(r.start, r.end + 1).join('\n');
      lines.splice(r.start, r.end - r.start + 1, ...rowsBlock(extraRows(originalRows)));
    } else {
      lines.splice(t + 1, 0, ...rowsBlock([]));
    }
  } else {
    const at = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(at, 0, '[ui.sidebar.spaces]', ...rowsBlock([]));
  }
  const at = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  lines.splice(at, 0, ...keysBlock());
  return { text: lines.join(eol), originalRows, hadTable };
}

// Rewrite the installed rows block to the current rows, keeping rows the
// person added inside it. Uninstall still restores the rows saved at install.
function refreshConfig(text) {
  const { eol, lines } = splitLines(text);
  const b = lines.findIndex(l => l.trim() === BEGIN);
  const e = lines.findIndex(l => l.trim() === END);
  if (b < 0 || e <= b) throw new Error('not installed');
  const extra = topLevelElements(lines.slice(b + 1, e).join('\n')).filter(x => !OUR_ROWS.has(squash(x)));
  lines.splice(b, e - b + 1, ...rowsBlock(extra));
  return lines.join(eol);
}

// Put the hotkey bindings (extra lines) into the installed keys block.
function setKeysBlock(text, extra) {
  const { eol, lines } = splitLines(text);
  const b = lines.findIndex(l => l.trim() === KEYS_BEGIN);
  const e = lines.findIndex(l => l.trim() === KEYS_END);
  if (b < 0 || e <= b) throw new Error('not installed');
  lines.splice(b, e - b + 1, ...keysBlock(extra));
  return lines.join(eol);
}

function unpatchConfig(text, { originalRows, hadTable }) {
  const { eol, lines } = splitLines(text);
  const kb = lines.findIndex(l => l.trim() === KEYS_BEGIN);
  const ke = lines.findIndex(l => l.trim() === KEYS_END);
  if (kb >= 0 && ke > kb) lines.splice(kb, ke - kb + 1);
  const b = lines.findIndex(l => l.trim() === BEGIN);
  const e = lines.findIndex(l => l.trim() === END);
  if (b >= 0 && e > b) {
    const repl = originalRows ? originalRows.split('\n') : [];
    lines.splice(b, e - b + 1, ...repl);
    if (!hadTable && b > 0 && lines[b - 1].trim() === '[ui.sidebar.spaces]') lines.splice(b - 1, 1);
  }
  return lines.join(eol);
}

module.exports = { BEGIN, END, KEYS_BEGIN, KEYS_END, patchConfig, refreshConfig, setKeysBlock, unpatchConfig, _internal: { topLevelElements, findRows } };
