'use strict';
// Edit herdr's config.toml: replace the Spaces rows with our rows and add our
// key bindings (the window, the star keys and the jump hotkeys), both between
// marker comments, and undo that exactly.
const { KINDS, token } = require('./stars');

const BEGIN = '# >>> anton.sidebar (плагин «Категории и дежурства»; откат: node sidebar/src/cli.js uninstall)';
const END = '# <<< anton.sidebar';
const KEYS_BEGIN = '# >>> anton.sidebar keys';
const KEYS_END = '# <<< anton.sidebar keys';

// The first row is the category title: only the first project of a category
// reports $section, and a row with no value is not drawn at all.
const STYLED_ROWS = [
  '  [{ token = "$section", fg = "#fabd2f", bold = true }],',
  `  ["state_icon", { token = "$star", rules = [${KINDS.map(k => `{ starts_with = "${token(k.kind)}", fg = "${k.color}" }`).join(', ')}] }, "workspace", { token = "$key", fg = "#83a598" }],`,
  '  ["branch", "git_status"],',
  '  [{ token = "$project", dim = true }],',
  '  [{ token = "$duty", rules = [{ starts_with = "▲", fg = "#fb4934", bold = true }, { starts_with = "◆", fg = "#b8bb26" }] }],',
];
const OPEN_KEY = 'prefix+shift+s';
// Alt+N walks through the workspaces with a star of kind N.
const STAR_KEYS = KINDS.map(k => `alt+${k.kind}`);
const binding = (key, action, description) => [
  '[[keys.command]]', `key = "${key}"`, 'type = "plugin_action"', `command = "anton.sidebar.${action}"`, `description = "${description}"`,
];
const FIXED_BINDINGS = [
  ...binding(OPEN_KEY, 'open', 'категории и дежурства'),
  ...KINDS.flatMap((k, i) => binding(STAR_KEYS[i], `star-${k.kind}`, `звёздочки ${k.kind}: ${k.name}`)),
];
const keysBlock = (extra = []) => [KEYS_BEGIN, ...FIXED_BINDINGS, ...extra, KEYS_END];
const squash = s => s.replace(/\s+/g, '');
const DEFAULT_ROWS = new Set(['["state_icon","workspace"]', '["branch","git_status"]']);
// Rows written by this or an earlier version of the plugin; a refresh drops them.
const OUR_ROWS = new Set([
  ...DEFAULT_ROWS,
  ...STYLED_ROWS.map(r => squash(r).replace(/,$/, '')),
  squash('["state_icon", { token = "workspace", rules = [{ starts_with = "━━", fg = "#fabd2f", bold = true }] }]'),
  squash('["state_icon", "workspace", { token = "$key", fg = "#83a598" }]'),
  squash('["state_icon", { token = "$star", fg = "#fabd2f" }, "workspace", { token = "$key", fg = "#83a598" }]'),
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

// The hotkey bindings inside the keys block: [[keys.command]] entries that
// point at a jump action. Everything else there is written by keysBlock.
function jumpBindings(inner) {
  const chunks = [];
  for (const l of inner) {
    if (l.trim() === '[[keys.command]]' || !chunks.length) chunks.push([]);
    chunks[chunks.length - 1].push(l);
  }
  return chunks.filter(c => c.some(l => /^\s*command\s*=\s*"anton\.sidebar\.jump-\d+"/.test(l))).flat();
}

// Rewrite the installed blocks to this version: the rows (keeping rows the
// person added inside the block) and the fixed key bindings (keeping the
// hotkeys). Uninstall still restores the rows saved at install.
function refreshConfig(text) {
  const { eol, lines } = splitLines(text);
  const b = lines.findIndex(l => l.trim() === BEGIN);
  const e = lines.findIndex(l => l.trim() === END);
  if (b < 0 || e <= b) throw new Error('not installed');
  const extra = topLevelElements(lines.slice(b + 1, e).join('\n')).filter(x => !OUR_ROWS.has(squash(x)));
  lines.splice(b, e - b + 1, ...rowsBlock(extra));
  const kb = lines.findIndex(l => l.trim() === KEYS_BEGIN);
  const ke = lines.findIndex(l => l.trim() === KEYS_END);
  if (kb >= 0 && ke > kb) {
    lines.splice(kb, ke - kb + 1, ...keysBlock(jumpBindings(lines.slice(kb + 1, ke))));
  } else {
    const at = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(at, 0, ...keysBlock());
  }
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

module.exports = { BEGIN, END, KEYS_BEGIN, KEYS_END, OPEN_KEY, STAR_KEYS, patchConfig, refreshConfig, setKeysBlock, unpatchConfig, _internal: { topLevelElements, findRows } };
