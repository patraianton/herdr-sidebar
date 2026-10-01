'use strict';
// Pure parts of the plugin window: rows, move targets, input decoding.
const NONE_ID = '__none';

function flattenRows(view, expanded) {
  const rows = [];
  if (!view || !view.categories) return rows;
  for (const c of view.categories) {
    rows.push({ type: 'cat', catId: c.id, name: c.name, count: c.units.length });
    c.units.forEach((u, index) => {
      rows.push({ type: 'unit', catId: c.id, index, unit: u });
      if (u.kind === 'group' && expanded.has(u.key)) {
        for (const child of u.children) rows.push({ type: 'child', catId: c.id, index, unit: u, child });
      }
    });
  }
  return rows;
}

function rowId(r) {
  if (r.type === 'cat') return `cat:${r.catId}`;
  if (r.type === 'unit') return `unit:${r.unit.key}`;
  return `child:${r.child.wsId}`;
}

function stepTarget(view, catId, index, delta) {
  const cats = view.categories;
  const ci = cats.findIndex(c => c.id === catId);
  if (ci < 0) return null;
  const ni = index + delta;
  if (ni >= 0 && ni < cats[ci].units.length) return { catId, index: ni };
  const nc = cats[ci + delta];
  if (!nc) return null;
  return { catId: nc.id, index: delta < 0 ? nc.units.length : 0 };
}

// Where a unit row lands when dropped on another row.
function dropTarget(view, fromRow, toRow) {
  if (!toRow || fromRow.type !== 'unit') return null;
  if (toRow.type === 'cat') return { catId: toRow.catId, index: 0 };
  return { catId: toRow.catId, index: toRow.index };
}

function locateWs(view, wsId) {
  for (const c of (view && view.categories) || []) {
    for (const u of c.units) {
      if (u.children && u.children.some(ch => ch.wsId === wsId)) return { unitKey: u.key, child: true };
      if (u.wsIds.includes(wsId)) return { unitKey: u.key, child: false };
    }
  }
  return null;
}

const ARROWS = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDE = { 1: 'home', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };

function parseInput(s) {
  const ev = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/))) {
      const b = Number(m[1]);
      ev.push({ mouse: {
        button: b & 3, wheel: b & 64 ? (b & 1 ? 'down' : 'up') : null, motion: !!(b & 32),
        release: m[4] === 'm', x: Number(m[2]), y: Number(m[3]),
      } });
    } else if ((m = rest.match(/^\x1b\[1;(\d+)([ABCDHF])/))) {
      const mod = Number(m[1]) - 1;
      ev.push({ key: ARROWS[m[2]], shift: !!(mod & 1), alt: !!(mod & 2), ctrl: !!(mod & 4) });
    } else if ((m = rest.match(/^\x1b[[O]([ABCDHF])/))) {
      ev.push({ key: ARROWS[m[1]] });
    } else if ((m = rest.match(/^\x1b\[(\d+)~/))) {
      if (TILDE[m[1]]) ev.push({ key: TILDE[m[1]] });
    } else if ((m = rest.match(/^\x1b\[[0-9;?<>=]*[ -/]*[@-~]/))) {
      // other control sequences: ignore
    } else if (rest[0] === '\x1b') {
      m = ['\x1b'];
      ev.push({ key: 'escape' });
    } else {
      const cp = rest.codePointAt(0);
      const ch = String.fromCodePoint(cp);
      m = [ch];
      if (ch === '\r' || ch === '\n') ev.push({ key: 'enter' });
      else if (ch === '\x7f' || ch === '\b') ev.push({ key: 'backspace' });
      else if (ch === '\t') ev.push({ key: 'tab' });
      else if (ch === '\x03') ev.push({ key: 'ctrl-c' });
      else if (cp >= 32) ev.push({ char: ch });
    }
    i += m[0].length;
  }
  return ev;
}

const RU = 'йцукенгшщзфывапролдячсмить';
const EN = 'qwertyuiopasdfghjklzxcvbnm';
function latin(ch) {
  const lower = ch.toLowerCase();
  const i = RU.indexOf(lower);
  if (i < 0) return ch;
  return ch === lower ? EN[i] : EN[i].toUpperCase();
}

function fit(text, width) {
  if (width <= 0) return '';
  const chars = [...String(text)];
  if (chars.length > width) return chars.slice(0, width - 1).join('') + '…';
  return chars.join('') + ' '.repeat(width - chars.length);
}

module.exports = { NONE_ID, flattenRows, rowId, stepTarget, dropTarget, locateWs, parseInput, latin, fit };
