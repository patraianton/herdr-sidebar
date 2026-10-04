'use strict';
// Starred workspaces: which open workspaces carry a star, and where the star
// key goes next. A star points at a workspace the same way a hotkey does
// ({ target: { wsId, label, path } }), so it follows renames and restarts.
const hotkeys = require('./hotkeys');

function starredIds(stars, workspaces, paths) {
  const ids = new Set();
  for (const s of stars || []) {
    const w = hotkeys.findWorkspace(s.target, workspaces, paths);
    if (w) ids.add(w.workspace_id);
  }
  return ids;
}

// From the focused workspace, the next starred one down the sidebar, going
// round at the end. null when no starred workspace is open.
function nextStar(stars, workspaces, paths) {
  const ids = starredIds(stars, workspaces, paths);
  const here = workspaces.findIndex(w => w.focused);
  const open = workspaces.filter(w => ids.has(w.workspace_id));
  return workspaces.find((w, i) => i > here && ids.has(w.workspace_id)) || open[0] || null;
}

module.exports = { starredIds, nextStar };
