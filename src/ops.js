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
      out.push({ paneId: p.pane_id, label: i ? `${t.label} ${i + 1}` : t.label });
    });
  }
  return out;
}

async function detach(herdr, state, { wsId, catId }) {
  const workspaces = await herdr.listWorkspaces();
  const ws = workspaces.find(w => w.workspace_id === wsId);
  if (!ws) throw new Error('Такого рабочего места уже нет.');
  if (!ws.worktree || !ws.worktree.is_linked_worktree) throw new Error('Это не копия проекта (worktree), выносить нечего.');
  const rk = normPath(ws.worktree.repo_key);
  const parent = workspaces.find(w => w.worktree && normPath(w.worktree.repo_key) === rk && !w.worktree.is_linked_worktree);
  const panes = await panesInTabOrder(herdr, wsId);
  if (!panes.length) throw new Error('В рабочем месте нет окон.');

  const first = await herdr.movePane(panes[0].paneId, { type: 'new_workspace', label: ws.label, tab_label: panes[0].label });
  const newId = (first.created_workspace && first.created_workspace.workspace_id) || (first.pane && first.pane.workspace_id);
  if (!newId) throw new Error('herdr не сообщил номер нового рабочего места.');
  for (const p of panes.slice(1)) {
    await herdr.movePane(p.paneId, { type: 'new_tab', workspace_id: newId, label: p.label });
  }

  state.detached[newId] = {
    checkout: cleanPath(ws.worktree.checkout_path),
    repoKey: rk,
    repoRoot: cleanPath(ws.worktree.repo_root),
    parentLabel: parent ? parent.label : (ws.worktree.repo_name || 'проект'),
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
  return { wsId: newId };
}

async function reattach(herdr, state, { wsId }) {
  const d = state.detached[wsId];
  if (!d) throw new Error('Это рабочее место не выносилось плагином.');
  const workspaces = await herdr.listWorkspaces();
  if (!workspaces.some(w => w.workspace_id === wsId)) { delete state.detached[wsId]; throw new Error('Вынесенного рабочего места уже нет.'); }
  const parent = workspaces.find(w => w.worktree && normPath(w.worktree.repo_key) === d.repoKey && !w.worktree.is_linked_worktree);
  const where = parent ? { workspace_id: parent.workspace_id } : { cwd: d.repoRoot };
  const res = await herdr.worktreeOpen({ ...where, path: d.checkout, label: d.name });
  const target = res.workspace.workspace_id;
  if (target !== wsId) {
    // herdr did not recognise our workspace (its first pane left the checkout)
    // and opened a fresh one: move our panes over, then close its empty shell.
    const fresh = res.root_pane && res.root_pane.pane_id;
    for (const p of await panesInTabOrder(herdr, wsId)) {
      await herdr.movePane(p.paneId, { type: 'new_tab', workspace_id: target, label: p.label });
    }
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
