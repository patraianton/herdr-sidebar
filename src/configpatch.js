'use strict';
// Edit herdr's config.toml: replace the Spaces rows with our rows and add our
// key bindings (the window, the star keys and the jump hotkeys), both between
// marker comments, and undo that exactly.
const { KINDS, token } = require('./stars');
const lavish = require('./lavish');
const remote = require('./remote');

const BEGIN = '# >>> anton.sidebar (Sidebar Organizer plugin; undo: U in its window)';
const END = '# <<< anton.sidebar';
// Earlier versions wrote another text after the id; the id is what counts.
const isBegin = l => l.trim() === BEGIN || l.trim().startsWith('# >>> anton.sidebar (');
const KEYS_BEGIN = '# >>> anton.sidebar keys';
const KEYS_END = '# <<< anton.sidebar keys';

// The first row is the category title: only the first project of a category
// reports $section, and a row with no value is not drawn at all.
// A project is one line: no branch row; right of its name stand the duty mark
// ($duty, `3d/30m`, red on an alarm) and the project of a detached copy
// ($project, `⎇ name`).
// $lavish is the violet dot after the star: an agent there waits for your answer on a Lavish page.
// $remote (`@mac`) right of the name: a remote machine runs work started from this project.
const STAR_TOKEN = `{ token = "$star", rules = [${KINDS.map(k => `{ starts_with = "${token(k.kind)}", fg = "${k.color}" }`).join(', ')}] }`;
const LAVISH_TOKEN = `{ token = "$lavish", fg = "${lavish.COLOR}" }`;
const DUTY_TOKEN = '{ token = "$duty", fg = "#b8bb26", rules = [{ starts_with = "▲", fg = "#fb4934", bold = true }] }';
const REMOTE_TOKEN = `{ token = "$remote", fg = "${remote.COLOR}" }`;
const STYLED_ROWS = [
  '  [{ token = "$section", fg = "#fabd2f", bold = true }],',
  `  ["state_icon", ${STAR_TOKEN}, ${LAVISH_TOKEN}, "workspace", ${REMOTE_TOKEN}, ${DUTY_TOKEN}, { token = "$project", dim = true }, { token = "$key", fg = "#83a598" }],`,
];
const OPEN_KEY = 'prefix+shift+s';
// Alt+N walks through the workspaces with a star of kind N; FN puts that star
// on the focused workspace or takes it off. (Alt+Shift+N does not reach herdr.)
const STAR_KEYS = KINDS.map(k => `alt+${k.kind}`);
const TOGGLE_KEYS = KINDS.map(k => `f${k.kind}`);
// Alt+0 takes every star off; pressed again while there are none, brings them back.
const RESET_KEY = 'alt+0';
// Alt+5 walks through the workspaces with the violet Lavish dot.
const LAVISH_KEY = 'alt+5';
// F5 takes the dot off the focused workspace (a report you have read) or brings it back.
const LAVISH_OFF_KEY = 'f5';
const binding = (key, action, description) => [
  '[[keys.command]]', `key = "${key}"`, 'type = "plugin_action"', `command = "anton.sidebar.${action}"`, `description = "${description}"`,
];
// Descriptions name no star kinds, so renaming a kind leaves config.toml alone.
const FIXED_BINDINGS = [
  ...binding(OPEN_KEY, 'open', 'sidebar organizer'),
  ...KINDS.flatMap((k, i) => binding(STAR_KEYS[i], `star-${k.kind}`, `stars ${k.kind}: next project with this star`)),
  ...KINDS.flatMap((k, i) => binding(TOGGLE_KEYS[i], `star-toggle-${k.kind}`, `star ${k.kind}: put on or take off`)),
  ...binding(RESET_KEY, 'star-reset', 'stars: take all off or bring back'),
  ...binding(LAVISH_KEY, 'lavish-next', 'lavish: next window waiting for your answer'),
  ...binding(LAVISH_OFF_KEY, 'lavish-toggle', 'lavish: dot off this window or back'),
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
  squash(`["state_icon", ${STAR_TOKEN}, "workspace", { token = "$key", fg = "#83a598" }]`), // before the $lavish dot (08.10.2026)
  squash(`["state_icon", ${STAR_TOKEN}, ${LAVISH_TOKEN}, "workspace", { token = "$key", fg = "#83a598" }]`), // before one line per project (11.10.2026)
  squash('[{ token = "$project", dim = true }]'),
  // before the duty mark moved right of the name (12.10.2026)
  squash(`["state_icon", ${STAR_TOKEN}, ${LAVISH_TOKEN}, "workspace", { token = "$project", dim = true }, { token = "$key", fg = "#83a598" }]`),
  squash('[{ token = "$duty", rules = [{ starts_with = "▲", fg = "#fb4934", bold = true }, { starts_with = "◆", fg = "#b8bb26" }] }]'),
  // before the remote machine mark (13.10.2026)
  squash(`["state_icon", ${STAR_TOKEN}, ${LAVISH_TOKEN}, "workspace", ${DUTY_TOKEN}, { token = "$project", dim = true }, { token = "$key", fg = "#83a598" }]`),
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

// flat: herdr can list worktree copies on lines of their own, so the plugin
// asks it to (then no copy has to be detached).
const FLAT_LINE = 'group_worktrees = false';
// compact: herdr can draw a plain space between the parts of a row instead
// of " · ", so more of a name fits.
const COMPACT_LINE = 'separator = " "';
function rowsBlock(extra, { flat = false, compact = false } = {}) {
  return [BEGIN, 'rows = [', ...STYLED_ROWS, ...extra.map(e => `  ${e},`), ']', ...(flat ? [FLAT_LINE] : []), ...(compact ? [COMPACT_LINE] : []), END];
}

function patchConfig(text, opts = {}) {
  const { eol, lines } = splitLines(text);
  if (lines.some(l => isBegin(l) || l.trim() === KEYS_BEGIN)) throw new Error('already installed');
  let originalRows = null;
  const t = findTable(lines, 'ui.sidebar.spaces');
  const hadTable = t >= 0;
  if (hadTable) {
    const r = findRows(lines, t);
    if (r) {
      originalRows = lines.slice(r.start, r.end + 1).join('\n');
      lines.splice(r.start, r.end - r.start + 1, ...rowsBlock(extraRows(originalRows), opts));
    } else {
      lines.splice(t + 1, 0, ...rowsBlock([], opts));
    }
  } else {
    const at = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(at, 0, '[ui.sidebar.spaces]', ...rowsBlock([], opts));
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
function refreshConfig(text, opts = {}) {
  const { eol, lines } = splitLines(text);
  const b = lines.findIndex(isBegin);
  const e = lines.findIndex(l => l.trim() === END);
  if (b < 0 || e <= b) throw new Error('not installed');
  const extra = topLevelElements(lines.slice(b + 1, e).join('\n')).filter(x => !OUR_ROWS.has(squash(x)));
  lines.splice(b, e - b + 1, ...rowsBlock(extra, opts));
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
  const b = lines.findIndex(isBegin);
  const e = lines.findIndex(l => l.trim() === END);
  if (b >= 0 && e > b) {
    const repl = originalRows ? originalRows.split('\n') : [];
    lines.splice(b, e - b + 1, ...repl);
    if (!hadTable && b > 0 && lines[b - 1].trim() === '[ui.sidebar.spaces]') lines.splice(b - 1, 1);
  }
  return lines.join(eol);
}

module.exports = { BEGIN, END, KEYS_BEGIN, KEYS_END, OPEN_KEY, STAR_KEYS, TOGGLE_KEYS, RESET_KEY, LAVISH_KEY, LAVISH_OFF_KEY, patchConfig, refreshConfig, setKeysBlock, unpatchConfig, _internal: { topLevelElements, findRows } };
