'use strict';
// Stars of four kinds: my project and three jobs. Alt+1…Alt+4 walk through the
// workspaces of one kind. A star points at a workspace the same way a hotkey
// does ({ kind, target: { wsId, label, path } }), so it follows renames and restarts.
const hotkeys = require('./hotkeys');

const KINDS = [
  { kind: 1, name: 'Мой проект', color: '#fabd2f' },
  { kind: 2, name: 'Первая работа', color: '#8ec07c' },
  { kind: 3, name: 'Вторая работа', color: '#d3869b' },
  { kind: 4, name: 'Третья работа', color: '#fe8019' },
];
const kindOf = s => s.kind || 1; // stars saved before kinds existed
const token = kind => `★${kind}`;

// Open workspace id -> kind of its star.
function starKinds(stars, workspaces, paths) {
  const kinds = new Map();
  for (const s of stars || []) {
    const w = hotkeys.findWorkspace(s.target, workspaces, paths);
    if (w && !kinds.has(w.workspace_id)) kinds.set(w.workspace_id, kindOf(s));
  }
  return kinds;
}

// Where Alt+<kind> goes. Inside the kind: the next one down the sidebar, round
// at the end. From elsewhere: the one of this kind visited last, else the first.
// null when nothing of this kind is open.
function nextStar(stars, workspaces, paths, kind, lastId) {
  const kinds = starKinds(stars, workspaces, paths);
  const mine = w => kinds.get(w.workspace_id) === kind;
  const of = workspaces.filter(mine);
  if (!of.length) return null;
  const here = workspaces.findIndex(w => w.focused);
  if (here >= 0 && mine(workspaces[here])) return workspaces.find((w, i) => i > here && mine(w)) || of[0];
  return of.find(w => w.workspace_id === lastId) || of[0];
}

module.exports = { KINDS, kindOf, token, starKinds, nextStar };
