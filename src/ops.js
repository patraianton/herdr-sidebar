'use strict';
// Pull a worktree out of its project's group and put it back, without
// stopping the processes in its panes.
const { normPath } = require('./paths');
const { NONE_ID } = require('./model');

const cleanPath = p => String(p || '').replace(/^\\\\\?\\/, '');

async function panesInTabOrder(herdr, wsId) {
  const tabs = (await herdr.listTabs(wsId)).slice().sort((a, b) => a.number - b.number);
  const panes = await herdr.listPanes(wsId);
  const out = [];
  for (const t of tabs) {
    panes.filter(p => p.tab_id === t.tab_id).forEach((p, i) => {
      out.push({ paneId: p.pane_id, tabId: t.tab_id, label: i ? `${t.label} ${i + 1}` : t.label });
    });
  }
  return out;
}

// herdr refuses to move a pane out of a zoomed tab (changed:false, reason
// zoomed_tab), so switch zoom off in every tab first.
async function unzoomTabs(herdr, panes) {
  const seen = new Set();
  for (const p of panes) {
    if (seen.has(p.tabId)) continue;
    seen.add(p.tabId);
    await herdr.zoomPane(p.paneId, 'off').catch(() => {});
  }
}

const movedTo = (res, wsId) => !!res && res.changed !== false && !!res.pane && res.pane.workspace_id === wsId;

async function detach(herdr, state, { wsId, catId }) {
  const workspaces = await herdr.listWorkspaces();
  const ws = workspaces.find(w => w.workspace_id === wsId);
  if (!ws) throw new Error('This workspace is gone.');
  if (!ws.worktree || !ws.worktree.is_linked_worktree) throw new Error('This is not a worktree copy of a project, there is nothing to detach.');
  const rk = normPath(ws.worktree.repo_key);
  const parent = workspaces.find(w => w.worktree && normPath(w.worktree.repo_key) === rk && !w.worktree.is_linked_worktree);
  const panes = await panesInTabOrder(herdr, wsId);
  if (!panes.length) throw new Error('The workspace has no panes.');
  await unzoomTabs(herdr, panes);

  const first = await herdr.movePane(panes[0].paneId, { type: 'new_workspace', label: ws.label, tab_label: panes[0].label });
  const newId = first && first.changed !== false && first.created_workspace && first.created_workspace.workspace_id;
  if (!newId || newId === wsId) {
    throw new Error(`herdr did not move the pane${first && first.reason ? ` (${first.reason})` : ''}. Nothing changed.`);
  }

  // The new workspace exists from here on: record it before moving the rest.
  state.detached[newId] = {
    checkout: cleanPath(ws.worktree.checkout_path),
    repoKey: rk,
    repoRoot: cleanPath(ws.worktree.repo_root),
    parentLabel: parent ? parent.label : (ws.worktree.repo_name || 'project'),
    name: ws.label,
    at: Date.now(),
  };
  const key = `ws:${newId}`;
  const groupKey = `repo:${rk}`;
  for (const c of state.categories) c.units = c.units.filter(k => k !== key);
  let target = null;
  if (catId === undefined || catId === null) target = state.categories.find(c => c.units.includes(groupKey)) || null;
  else if (catId !== NONE_ID) target = state.categories.find(c => c.id === catId) || null;
  if (target) {
    const i = target.units.indexOf(groupKey);
    target.units.splice(i >= 0 ? i + 1 : target.units.length, 0, key);
  }
  state.units[key] = { path: normPath(ws.worktree.checkout_path), label: ws.label, seen: Date.now() };
  for (const d of Object.values(state.duty)) if (d.wsId === wsId) d.wsId = newId;

  const stuck = [];
  for (const p of panes.slice(1)) {
    const res = await herdr.movePane(p.paneId, { type: 'new_tab', workspace_id: newId, label: p.label });
    if (!movedTo(res, newId)) stuck.push(p.paneId);
  }
  if (stuck.length) {
    throw new Error(`Detached only in part: panes ${stuck.join(', ')} stayed in "${ws.label}" (${wsId}), the rest are in the new workspace ${newId}. Nothing was closed.`);
  }
  return { wsId: newId };
}

async function reattach(herdr, state, { wsId }) {
  const d = state.detached[wsId];
  if (!d) throw new Error('This workspace was not detached by the plugin.');
  const workspaces = await herdr.listWorkspaces();
  if (!workspaces.some(w => w.workspace_id === wsId)) { delete state.detached[wsId]; throw new Error('The detached workspace is gone.'); }
  const parent = workspaces.find(w => w.worktree && normPath(w.worktree.repo_key) === d.repoKey && !w.worktree.is_linked_worktree);
  const where = parent ? { workspace_id: parent.workspace_id } : { cwd: d.repoRoot };
  const res = await herdr.worktreeOpen({ ...where, path: d.checkout, label: d.name });
  const target = res.workspace.workspace_id;
  if (target !== wsId) {
    // herdr answered with another workspace: either it opened a fresh one (our
    // first pane left the checkout) or one was already open on this checkout.
    // Move our panes there; close only the empty shell of a freshly made one.
    const panes = await panesInTabOrder(herdr, wsId);
    await unzoomTabs(herdr, panes);
    const stuck = [];
    for (const p of panes) {
      const moved = await herdr.movePane(p.paneId, { type: 'new_tab', workspace_id: target, label: p.label });
      if (!movedTo(moved, target)) stuck.push(p.paneId);
    }
    if (stuck.length) {
      throw new Error(`Not everything came back: panes ${stuck.join(', ')} stayed in ${wsId}, the rest are in ${target}. Nothing was closed.`);
    }
    const fresh = res.already_open === false && res.root_pane && res.root_pane.pane_id;
    if (fresh) await herdr.closePane(fresh).catch(() => {});
    for (const x of Object.values(state.duty)) if (x.wsId === wsId) x.wsId = target;
  }
  delete state.detached[wsId];
  const key = `ws:${wsId}`;
  for (const c of state.categories) c.units = c.units.filter(k => k !== key);
  delete state.units[key];
  return { wsId: target };
}

module.exports = { detach, reattach };
