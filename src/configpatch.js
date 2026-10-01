'use strict';
// Edit herdr's config.toml: replace the Spaces rows with our rows and add one
// key binding, both between marker comments, and undo that exactly.
const BEGIN = '# >>> anton.sidebar (плагин «Категории и дежурства»; откат: node sidebar/src/cli.js uninstall)';
const END = '# <<< anton.sidebar';
const KEYS_BEGIN = '# >>> anton.sidebar keys';
const KEYS_END = '# <<< anton.sidebar keys';

const STYLED_ROWS = [
  '  ["state_icon", { token = "workspace", rules = [{ starts_with = "━━", fg = "#fabd2f", bold = true }] }],',
  '  ["branch", "git_status"],',
  '  [{ token = "$project", dim = true }],',
  '  [{ token = "$duty", rules = [{ starts_with = "▲", fg = "#fb4934", bold = true }, { starts_with = "◆", fg = "#b8bb26" }] }],',
];
const KEYS_BLOCK = [
  KEYS_BEGIN,
  '[[keys.command]]',
  'key = "prefix+shift+s"',
  'type = "plugin_action"',
  'command = "anton.sidebar.open"',
  'description = "категории и дежурства"',
  KEYS_END,
];
const DEFAULT_ROWS = new Set(['["state_icon","workspace"]', '["branch","git_status"]']);
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
  return topLevelElements(rowsText).filter(e => !DEFAULT_ROWS.has(e.replace(/\s+/g, '')));
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
  lines.splice(at, 0, ...KEYS_BLOCK);
  return { text: lines.join(eol), originalRows, hadTable };
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

module.exports = { BEGIN, END, KEYS_BEGIN, KEYS_END, patchConfig, unpatchConfig, _internal: { topLevelElements, findRows } };
