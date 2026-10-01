'use strict';
// Thin helpers over the herdr socket API used by the plugin.
const rpc = require('./rpc');

const SOURCE = 'anton.sidebar';
const PLUGIN_ID = 'anton.sidebar';

function makeHerdr(socketPath) {
  const c = (method, params, timeout) => rpc.call(socketPath, method, params, timeout);
  return {
    socketPath,
    ping: () => c('ping', {}, 3000),
    listWorkspaces: async () => (await c('workspace.list', {})).workspaces,
    listPanes: async wsId => (await c('pane.list', wsId ? { workspace_id: wsId } : {})).panes,
    listTabs: async wsId => (await c('tab.list', { workspace_id: wsId })).tabs,
    listAgents: async () => (await c('agent.list', {})).agents,
    getPane: async id => (await c('pane.get', { pane_id: id })).pane,
    createWorkspace: async (label, cwd) => (await c('workspace.create', { label, cwd, focus: false })).workspace,
    closeWorkspace: id => c('workspace.close', { workspace_id: id }),
    renameWorkspace: (id, label) => c('workspace.rename', { workspace_id: id, label }),
    moveBlock: async ids => {
      const r = await c('workspace.move_block', { workspace_ids: ids });
      return r && Array.isArray(r.workspaces) ? r.workspaces.map(w => w.workspace_id) : null;
    },
    setTokens: (wsId, tokens) => c('workspace.report_metadata', { workspace_id: wsId, source: SOURCE, tokens }),
    notify: (title, body) => c('notification.show', { title, body, sound: 'request' }),
    movePane: (paneId, destination) => c('pane.move', { pane_id: paneId, destination, focus: false }, 30000),
    closePane: id => c('pane.close', { pane_id: id }),
    worktreeOpen: params => c('worktree.open', { ...params, focus: false }, 60000),
    openPluginPane: (entrypoint, env) => c('plugin.pane.open', { plugin_id: PLUGIN_ID, entrypoint, env: env || {} }),
    reloadConfig: () => c('server.reload_config', {}),
  };
}

module.exports = { makeHerdr, SOURCE, PLUGIN_ID };
