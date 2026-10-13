'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const remote = require('../src/remote');
const { createDaemon } = require('../src/daemon');

test('remotes from settings: a plain name is the ssh host too, bad entries are left out', () => {
  assert.deepEqual(remote.parseRemotes(['mac', { name: 'dev', ssh: 'root@codex-dev' }, { name: 'hst' }]), [
    { name: 'mac', ssh: 'mac' }, { name: 'dev', ssh: 'root@codex-dev' }, { name: 'hst', ssh: 'hst' },
  ]);
  assert.deepEqual(remote.parseRemotes([
    { name: 'far-too-long-name', ssh: 'x' }, { name: 'bad name', ssh: 'x' }, { name: 'opt', ssh: '-oProxyCommand=x' },
    { name: 'mac', ssh: 'mac' }, { name: 'mac', ssh: 'other' }, 42, null,
  ]), [{ name: 'mac', ssh: 'mac' }]);
  assert.deepEqual(remote.parseRemotes(undefined), []);
  assert.deepEqual(remote.parseRemotes('mac'), []);
});

test('the probe answer is read line by line, the same from Linux and from macOS', () => {
  assert.deepEqual(remote.parseProbe('771907 w9T:p1\n70182 wB2:p3\r\n\nnoise here too\n'), [
    { pid: '771907', pane: 'w9T:p1' }, { pid: '70182', pane: 'wB2:p3' },
  ]);
  assert.deepEqual(remote.parseProbe(''), []);
});

test('the mark: one machine, two machines, none', () => {
  assert.equal(remote.token(['mac']), '@mac');
  assert.equal(remote.token(['mac', 'dev', 'mac']), '@mac+dev');
  assert.equal(remote.token([]), null);
});

test('a process counts from its second round on, and goes when it is gone', async () => {
  let answer = { mac: '100 w1:p1\n', dev: '' };
  const w = remote.makeWatch({ remotes: remote.parseRemotes(['mac', 'dev']), run: async host => answer[host] });
  assert.equal((await w.refresh()).marks.size, 0, 'seen once: may be a one-second check');
  assert.deepEqual([...(await w.refresh()).marks], [['w1:p1', ['mac']]]);
  answer = { mac: '100 w1:p1\n101 w2:p1\n', dev: '200 w1:p1\n' };
  assert.deepEqual([...(await w.refresh()).marks], [['w1:p1', ['mac']]], 'the new ones wait a round');
  assert.deepEqual([...(await w.refresh()).marks].sort(), [['w1:p1', ['mac', 'dev']], ['w2:p1', ['mac']]]);
  answer = { mac: '', dev: '201 w1:p1\n' };
  assert.equal((await w.refresh()).marks.size, 0, 'a new process in the same pane waits its round too');
});

test('a machine that does not answer keeps its marks three rounds, then loses them', async () => {
  let down = false;
  const w = remote.makeWatch({ remotes: remote.parseRemotes(['mac']), run: async () => { if (down) throw new Error('timed out'); return '7 w1:p1\n'; } });
  await w.refresh();
  assert.equal((await w.refresh()).marks.size, 1);
  down = true;
  for (let i = 0; i < 3; i++) {
    const r = await w.refresh();
    assert.equal(r.marks.size, 1);
    assert.deepEqual(r.errors, [['mac', 'timed out']]);
  }
  assert.equal((await w.refresh()).marks.size, 0);
});

test('the probe script reads /proc on Linux and ps on macOS, and only the one variable', () => {
  assert.match(remote.PROBE, /\/proc\/\[0-9\]\*\/environ/);
  assert.match(remote.PROBE, /ps -Eww -axo pid=,command=/);
  assert.equal(remote.PROBE.split(`${remote.ENV}=`).length - 1, 3);
});

// --- in the helper: the mark follows the runs -------------------------------------------------

function fakeHerdr(workspaces, panes, moved = {}) {
  return {
    ping: async () => ({ type: 'pong' }),
    listWorkspaces: async () => JSON.parse(JSON.stringify(workspaces)),
    listPanes: async () => panes.slice(),
    listAgents: async () => [],
    getPane: async id => (moved[id] ? { pane_id: moved[id] } : null),
    moveBlock: async ids => ids,
    setTokens: async (id, tokens) => {
      const w = workspaces.find(x => x.workspace_id === id);
      w.tokens = { ...(w.tokens || {}) };
      for (const [k, v] of Object.entries(tokens)) { if (v == null) delete w.tokens[k]; else w.tokens[k] = v; }
    },
    notify: async () => {},
    tokensOf: id => workspaces.find(w => w.workspace_id === id).tokens || {},
  };
}

test('the helper marks the workspace whose pane started a remote run, and clears it when the run ends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-remote-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const herdr = fakeHerdr(
    [{ workspace_id: 'w1', label: 'acme-web' }, { workspace_id: 'w2', label: 'billing' }, { workspace_id: 'w3', label: 'login-form' }],
    [{ pane_id: 'w1:p1', workspace_id: 'w1' }, { pane_id: 'w1:p2', workspace_id: 'w1' }, { pane_id: 'w2:p1', workspace_id: 'w2' }, { pane_id: 'w3:p1', workspace_id: 'w3' }],
    { 'old:p1': 'w3:p1' }, // a detached copy: its pane has a new id, the run still carries the old one
  );
  let marks = new Map([['w1:p2', ['mac']], ['w2:p1', ['mac', 'dev']], ['old:p1', ['dev']]]);
  let errors = [];
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir: path.join(dir, 'config'), herdr,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
    remote: { refresh: async () => ({ marks, errors }) },
  });
  try {
    d._test.markConnected();
    await d._test.cycle('first');
    await d._test.refreshRemote();
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w1').remote, '@mac', 'a second pane of the workspace is enough');
    assert.equal(herdr.tokensOf('w2').remote, '@mac+dev');
    assert.equal(herdr.tokensOf('w3').remote, '@dev', 'the old pane id leads to the pane now');

    marks = new Map();
    errors = [['dev', 'timed out']];
    await d._test.refreshRemote();
    await d._test.cycle('test');
    for (const id of ['w1', 'w2', 'w3']) assert.equal(herdr.tokensOf(id).remote, undefined);
    assert.ok(fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8').includes('remote dev does not answer: timed out'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
