'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lavish = require('../src/lavish');
const { createDaemon } = require('../src/daemon');
const { parseProbe, openPages, waitingPanes } = lavish._internal;

const state = (...sessions) => JSON.stringify({ sessions: Object.fromEntries(sessions.map((s, i) => [`k${i}`, s])) });

test('a wait marks its own pane, wherever the page lives', () => {
  const open = openPages(state(
    { file: 'C:\\Users\\a\\projects\\_conveyor\\sprints\\FIX-9\\lavish\\acceptance\\index.html', status: 'open' },
    { file: 'C:\\Users\\a\\projects\\dutch\\.lavish\\upsell\\index.html', status: 'open' },
  ));
  const panes = waitingPanes([
    // the sprint page sits outside the window's folder: the pane id still names the window
    { pane: 'wB2:p1', cwd: 'C:\\Users\\a\\.herdr\\worktrees\\ap\\fix-9\\', file: 'C:\\Users\\a\\projects\\_conveyor\\sprints\\FIX-9\\lavish\\acceptance\\index.html' },
    // a relative page path is read from the waiting process's folder, in any slash style or case
    { pane: 'wB4:p1', cwd: 'C:\\Users\\a\\projects\\dutch\\', file: '.lavish/Upsell/index.html' },
  ], open);
  assert.deepEqual([...panes].sort(), ['wB2:p1', 'wB4:p1']);
});

test('a page you ended keeps no mark, and a wait with no pane or page counts for nothing', () => {
  const open = openPages(state(
    { file: 'C:\\p\\a.html', status: 'ended' },
    { file: 'C:\\p\\b.html', status: 'open' },
  ));
  const panes = waitingPanes([
    { pane: 'w1:p1', cwd: 'C:\\p', file: 'C:\\p\\a.html' },
    { pane: null, cwd: 'C:\\p', file: 'C:\\p\\b.html' },
    { pane: 'w3:p1', cwd: 'C:\\p', file: null },
  ], open);
  assert.equal(panes.size, 0);
});

test('a page you answered keeps no mark until the agent changes it', () => {
  const open = openPages(state({ file: 'C:\\p\\eval.html', status: 'open', last_answer_at: '2026-10-08T09:59:00.000Z' }));
  const polls = [{ pane: 'wBF:p1', cwd: 'C:\\p', file: 'C:\\p\\eval.html' }];
  const changed = iso => () => Date.parse(iso);
  // the agent keeps waiting after your answer, in case you add something: nothing is asked of you
  assert.equal(waitingPanes(polls, open, changed('2026-10-08T08:15:00.000Z')).size, 0);
  // it rewrote the page after your answer: there is something new to look at
  assert.deepEqual([...waitingPanes(polls, open, changed('2026-10-08T10:20:00.000Z'))], ['wBF:p1']);
  // a page file that cannot be read counts as changed
  assert.deepEqual([...waitingPanes(polls, open, () => Infinity)], ['wBF:p1']);
});

test('when lavish state cannot be read, every wait counts', () => {
  assert.equal(openPages('not json'), null);
  assert.deepEqual([...waitingPanes([{ pane: 'w1:p1', cwd: 'C:\\p', file: 'x.html' }], null)], ['w1:p1']);
});

test('the probe output parses as one row, many rows or none', () => {
  assert.deepEqual(parseProbe(''), []);
  assert.deepEqual(parseProbe('[]'), []);
  assert.deepEqual(parseProbe('{"pane":"w1:p1","cwd":"C:\\\\p","file":"a.html"}'), [{ pane: 'w1:p1', cwd: 'C:\\p', file: 'a.html' }]);
  assert.equal(parseProbe('[{"pane":"w1:p1"},{"pane":"w2:p1"}]').length, 2);
});

test('the watch runs the probe only on Windows and reads the state every round (remembered pages need it)', async () => {
  let reads = 0;
  const watch = rows => lavish.makeWatch({ platform: 'win32', run: async () => JSON.stringify(rows), readState: () => { reads++; return state({ file: 'C:\\p\\a.html', status: 'open' }); } });
  assert.deepEqual([...await watch([{ pane: 'w1:p1', cwd: 'C:\\p', file: 'a.html' }]).refresh()], ['w1:p1']);
  assert.equal((await watch([]).refresh()).size, 0);
  assert.equal(reads, 2);
  let ran = false;
  const mac = lavish.makeWatch({ platform: 'darwin', run: async () => { ran = true; return '[]'; } });
  assert.equal((await mac.refresh()).size, 0);
  assert.equal(ran, false);
});

// --- in the helper: the dot follows the waits ------------------------------------------------------

function fakeHerdr(workspaces, panes) {
  return {
    calls: [],
    ping: async () => ({ type: 'pong' }),
    listWorkspaces: async () => JSON.parse(JSON.stringify(workspaces)),
    listPanes: async () => panes.slice(),
    listAgents: async () => [],
    moveBlock: async ids => ids,
    setTokens: async (id, tokens) => {
      const w = workspaces.find(x => x.workspace_id === id);
      w.tokens = { ...(w.tokens || {}) };
      for (const [k, v] of Object.entries(tokens)) { if (v == null) delete w.tokens[k]; else w.tokens[k] = v; }
    },
    notify: async () => {},
    tokensOf: id => workspaces.find(w => w.workspace_id === id).tokens || {},
    focus: id => { for (const w of workspaces) w.focused = w.workspace_id === id; },
  };
}

test('the helper puts the dot on the workspace of a waiting pane and takes it off when the wait ends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lavish-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const herdr = fakeHerdr(
    [{ workspace_id: 'w1', label: 'dutch-ecom' }, { workspace_id: 'w2', label: 'other' }],
    [{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: 'C:/p/dutch' }, { pane_id: 'w1:p2', workspace_id: 'w1', cwd: 'C:/p/dutch' }, { pane_id: 'w2:p1', workspace_id: 'w2', cwd: 'C:/p/other' }],
  );
  let waiting = new Set(['w1:p2']);
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir: path.join(dir, 'config'), herdr,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
    lavish: { refresh: async () => waiting },
  });
  try {
    d._test.markConnected();
    await d._test.refreshLavish();
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w1').lavish, lavish.MARK, 'a second pane of the workspace is enough');
    assert.equal(herdr.tokensOf('w2').lavish, undefined);

    waiting = new Set();
    await d._test.refreshLavish();
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w1').lavish, undefined, 'the answer went out: the dot goes');

    waiting = new Set(['w2:p1']);
    await d._test.refreshLavish();
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w2').lavish, lavish.MARK, 'a wait in another window moves the dot there');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a probe that fails clears the dots instead of freezing them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lavish-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const herdr = fakeHerdr([{ workspace_id: 'w1', label: 'a' }], [{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: 'C:/p/a' }]);
  let fail = false;
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir: path.join(dir, 'config'), herdr,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
    lavish: { refresh: async () => { if (fail) throw new Error('powershell gone'); return new Set(['w1:p1']); } },
  });
  try {
    d._test.markConnected();
    await d._test.refreshLavish();
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w1').lavish, lavish.MARK);
    fail = true;
    await d._test.refreshLavish();
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w1').lavish, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the dot follows the page, not the waiting process ---------------------------------------------

test('a page stays marked after its wait ends, until you answer it or it is closed', () => {
  const { rememberPages } = lavish._internal;
  const pages = {};
  const old = () => 0; // page files unchanged since long ago
  let open = openPages(state({ file: 'C:\\p\\acc.html', status: 'open' }));
  assert.deepEqual([...rememberPages(pages, [{ pane: 'w35:p2', cwd: 'C:\\p', file: 'acc.html' }], open, old)], ['w35:p2']);
  // the window waits in rounds: between them no wait runs, the dot stays
  assert.deepEqual([...rememberPages(pages, [], open, old)], ['w35:p2']);
  // you answered: the dot goes, the page is still remembered
  open = openPages(state({ file: 'C:\\p\\acc.html', status: 'open', last_answer_at: '2026-10-08T10:00:00.000Z' }));
  assert.equal(rememberPages(pages, [], open, old).size, 0);
  assert.ok(pages['c:/p/acc.html']);
  // the page was ended: forgotten
  open = openPages(state({ file: 'C:\\p\\acc.html', status: 'ended' }));
  assert.equal(rememberPages(pages, [], open, old).size, 0);
  assert.deepEqual(pages, {});
});

test('a page waited on from another pane moves its dot there', () => {
  const { rememberPages } = lavish._internal;
  const pages = {};
  const open = openPages(state({ file: 'C:\\p\\a.html', status: 'open' }));
  rememberPages(pages, [{ pane: 'w1:p1', cwd: 'C:\\p', file: 'a.html' }], open, () => 0);
  assert.deepEqual([...rememberPages(pages, [{ pane: 'w2:p1', cwd: 'C:\\x', file: 'C:\\p\\a.html' }], open, () => 0)], ['w2:p1']);
});

test('the watch keeps its pages across a helper restart and through a failed probe', async () => {
  let disk = {};
  const opts = (run, readState = () => state({ file: 'C:\\p\\a.html', status: 'open' })) => ({
    platform: 'win32', run, readState, mtime: () => 0, load: () => disk, save: d => { disk = d; },
  });
  const first = lavish.makeWatch(opts(async () => JSON.stringify([{ pane: 'w1:p1', cwd: 'C:\\p', file: 'a.html' }])));
  assert.deepEqual([...await first.refresh()], ['w1:p1']);
  assert.deepEqual(disk.panes, ['w1:p1']);
  // restarted helper, the wait is gone, the probe even fails: the page is still remembered
  const second = lavish.makeWatch(opts(async () => { throw new Error('powershell gone'); }));
  assert.deepEqual([...await second.refresh()], ['w1:p1']);
  // nothing remembered and the probe fails: the failure is reported
  disk = {};
  await assert.rejects(lavish.makeWatch(opts(async () => { throw new Error('powershell gone'); })).refresh(), /powershell gone/);
  // state unreadable: only the live waits count, nothing is remembered
  disk = {};
  const blind = lavish.makeWatch(opts(async () => JSON.stringify([{ pane: 'w3:p1', cwd: 'C:\\p', file: 'b.html' }]), () => 'not json'));
  assert.deepEqual([...await blind.refresh()], ['w3:p1']);
  assert.deepEqual(disk, {});
});

test('Alt+5 goes to the next window with the dot down the sidebar, then round to the first', () => {
  const ws = (id, dot, focused = false) => ({ workspace_id: id, focused, tokens: dot ? { lavish: lavish.MARK } : {} });
  assert.equal(lavish.nextMarked([ws('a', true), ws('b', false, true), ws('c', true)]).workspace_id, 'c');
  assert.equal(lavish.nextMarked([ws('a', true), ws('b', false), ws('c', true, true)]).workspace_id, 'a');
  assert.equal(lavish.nextMarked([ws('a', true), ws('b')]).workspace_id, 'a', 'nothing focused: the first one');
  assert.equal(lavish.nextMarked([ws('a'), ws('b', false, true)]), null);
});

test('Alt+5 opens the tab of the pane whose page wants an answer', async () => {
  const { lavishNext } = require('../src/cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lavish-'));
  try {
    fs.writeFileSync(path.join(dir, 'lavish-pages.json'), JSON.stringify({ pages: {}, panes: ['w2:p3'] }));
    const calls = [];
    const h = {
      listWorkspaces: async () => [{ workspace_id: 'w1', focused: true, tokens: {} }, { workspace_id: 'w2', tokens: { lavish: lavish.MARK } }],
      listPanes: async () => [{ pane_id: 'w2:p1', tab_id: 'w2:t1' }, { pane_id: 'w2:p3', tab_id: 'w2:t2' }],
      focusWorkspace: async id => calls.push(['ws', id]),
      focusTab: async id => calls.push(['tab', id]),
      notify: async (t, b) => calls.push(['notify', b]),
    };
    assert.equal(await lavishNext(h, dir), 'w2');
    assert.deepEqual(calls, [['ws', 'w2'], ['tab', 'w2:t2']]);
    calls.length = 0;
    h.listWorkspaces = async () => [{ workspace_id: 'w1', focused: true, tokens: {} }];
    assert.equal(await lavishNext(h, dir), 'none');
    assert.match(calls[0][1], /No window is waiting/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each pane gets the links of its open pages: those that want an answer first, the newest first', () => {
  const { paneLinks, pageName } = lavish._internal;
  const open = openPages(state(
    { file: 'C:/p/acc/index.html', status: 'open', key: 'aaaa000000000001', url: 'http://127.0.0.1:4387/session/aaaa000000000001' },
    { file: 'C:/p/plan.html', status: 'open', key: 'aaaa000000000002', url: 'http://127.0.0.1:4387/session/aaaa000000000002' },
    { file: 'C:/p/done.html', status: 'open', key: 'aaaa000000000003', url: 'http://127.0.0.1:4387/session/aaaa000000000003', last_answer_at: '2026-10-08T10:00:00.000Z' },
  ));
  const pages = {
    'c:/p/acc/index.html': { pane: 'w1:p1', file: 'C:/p/acc/index.html' },
    'c:/p/plan.html': { pane: 'w1:p1', file: 'C:/p/plan.html' },
    'c:/p/done.html': { pane: 'w2:p1', file: 'C:/p/done.html' },
  };
  const changed = f => ({ 'C:/p/acc/index.html': 100, 'C:/p/plan.html': 200, 'C:/p/done.html': 0 })[f];
  // with a public address the link goes there; the answered page keeps its link, marked as not waiting
  assert.deepEqual(paneLinks(pages, open, changed, 'https://lavish.example.com'), {
    'w1:p1': [
      { name: 'plan', url: 'https://lavish.example.com/session/aaaa000000000002', waiting: true },
      { name: 'acc', url: 'https://lavish.example.com/session/aaaa000000000001', waiting: true },
    ],
    'w2:p1': [{ name: 'done', url: 'https://lavish.example.com/session/aaaa000000000003', waiting: false }],
  });
  // a page taken off with F5 goes after the ones that wait, even when it changed later
  pages['c:/p/plan.html'].seen = 300;
  assert.deepEqual(paneLinks(pages, open, changed, '')['w1:p1'].map(l => [l.name, l.waiting]), [['acc', true], ['plan', false]]);
  delete pages['c:/p/plan.html'].seen;
  // without one, the local link
  assert.equal(paneLinks(pages, open, changed, '')['w1:p1'][0].url, 'http://127.0.0.1:4387/session/aaaa000000000002');
  assert.equal(pageName('C:/x/upsell-eli5-2026-10-07/index.html'), 'upsell-eli5-2026-10-07');
  assert.equal(pageName('C:/x/soda-high-level-plan.html'), 'soda-high-level-plan');
});

test('the public address comes from the variable or from lavish config.json, origin only', () => {
  const { publicBase } = lavish._internal;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lavish-'));
  try {
    assert.equal(publicBase({ LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_PUBLIC_URL: 'https://a.example.com/x/y' }), 'https://a.example.com');
    assert.equal(publicBase({ LAVISH_AXI_STATE_DIR: dir }), '');
    fs.writeFileSync(path.join(dir, 'config.json'), '\uFEFF{"publicUrl":"https://b.example.com/"}');
    assert.equal(publicBase({ LAVISH_AXI_STATE_DIR: dir }), 'https://b.example.com');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- F5: a page that needs no answer -----------------------------------------------------------------

test('F5 takes the dot off a read page, keeps its link, and the dot comes back when the page changes', async () => {
  let disk = {};
  let changedAt = 100;
  const watch = lavish.makeWatch({
    platform: 'win32',
    run: async () => JSON.stringify([{ pane: 'w1:p1', cwd: 'C:/p', file: 'C:/p/report.html' }, { pane: 'w2:p1', cwd: 'C:/x', file: 'C:/x/ask.html' }]),
    readState: () => state(
      { file: 'C:/p/report.html', status: 'open', key: 'aaaa000000000001', url: 'http://127.0.0.1:4387/session/aaaa000000000001' },
      { file: 'C:/x/ask.html', status: 'open', key: 'aaaa000000000002', url: 'http://127.0.0.1:4387/session/aaaa000000000002' },
    ),
    mtime: f => (f === 'C:/p/report.html' ? changedAt : 0),
    load: () => disk, save: d => { disk = d; }, base: () => '',
  });
  assert.deepEqual([...await watch.refresh()].sort(), ['w1:p1', 'w2:p1']);

  // F5 in the report's window: its dot goes, the other window keeps its own
  const off = watch.toggle(new Set(['w1:p1', 'w1:p2']), 500);
  assert.deepEqual(off.off, ['report']);
  assert.deepEqual([...off.panes], ['w2:p1']);
  assert.deepEqual(disk.panes, ['w2:p1']);
  assert.deepEqual(disk.links['w1:p1'], [{ name: 'report', url: 'http://127.0.0.1:4387/session/aaaa000000000001', waiting: false }]);
  // the agent keeps waiting on it: the dot stays off
  assert.deepEqual([...await watch.refresh()], ['w2:p1']);
  // F5 again where there is no dot: it comes back
  const back = watch.toggle(new Set(['w1:p1']), 600);
  assert.deepEqual(back.back, ['report']);
  assert.deepEqual([...back.panes].sort(), ['w1:p1', 'w2:p1']);
  // off again, then the agent rewrites the page: the dot is back by itself
  watch.toggle(new Set(['w1:p1']), 700);
  assert.deepEqual([...await watch.refresh()], ['w2:p1']);
  changedAt = 800;
  assert.deepEqual([...await watch.refresh()].sort(), ['w1:p1', 'w2:p1']);
  // a window with no pages
  const none = watch.toggle(new Set(['w9:p1']), 900);
  assert.deepEqual(none.back, []);
  assert.equal(lavish.toggleNote(none), 'No Lavish page in this window.');
  assert.match(lavish.toggleNote(off), /^Dot off: report\. The link stays/);
  assert.equal(lavish.toggleNote(back), 'Dot back: report.');
});

test('F5 is remembered across a helper restart', async () => {
  let disk = {};
  const opts = () => ({
    platform: 'win32', run: async () => JSON.stringify([{ pane: 'w1:p1', cwd: 'C:/p', file: 'C:/p/a.html' }]),
    readState: () => state({ file: 'C:/p/a.html', status: 'open', url: 'http://127.0.0.1:4387/session/a' }),
    mtime: () => 0, load: () => disk, save: d => { disk = d; }, base: () => '',
  });
  const first = lavish.makeWatch(opts());
  await first.refresh();
  first.toggle(new Set(['w1:p1']), 10);
  assert.equal(disk.pages['c:/p/a.html'].seen, 10);
  assert.equal((await lavish.makeWatch(opts()).refresh()).size, 0);
});

test('F5 in herdr takes the dot off the focused window at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lavish-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const herdr = fakeHerdr(
    [{ workspace_id: 'w1', label: 'job-hunting', focused: true }, { workspace_id: 'w2', label: 'other' }],
    [{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: 'C:/p/a' }, { pane_id: 'w2:p1', workspace_id: 'w2', cwd: 'C:/p/b' }],
  );
  const asked = [];
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir: path.join(dir, 'config'), herdr,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
    lavish: {
      refresh: async () => new Set(['w1:p1', 'w2:p1']),
      toggle: panes => { asked.push([...panes]); return { off: ['report'], panes: new Set(['w2:p1']) }; },
    },
  });
  try {
    d._test.markConnected();
    await d._test.refreshLavish();
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w1').lavish, lavish.MARK);
    assert.deepEqual(await d.handle('lavish.toggle', {}), { off: ['report'], back: undefined });
    assert.deepEqual(asked, [['w1:p1']], 'only the panes of the focused window');
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w1').lavish, undefined);
    assert.equal(herdr.tokensOf('w2').lavish, lavish.MARK);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pane that moved with a detached copy keeps its dot: herdr still answers for the old id the agent carries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lavish-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const herdr = fakeHerdr(
    [{ workspace_id: 'w1', label: 'api' }, { workspace_id: 'w9', label: 'cookie' }],
    [{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: 'C:/p/api' }, { pane_id: 'w9:p1', workspace_id: 'w9', cwd: 'C:/wt/cookie' }],
  );
  herdr.getPane = async id => {
    if (id === 'w4:p1') return { pane_id: 'w9:p1', workspace_id: 'w9', tab_id: 'w9:t1' };
    throw new Error('pane_not_found');
  };
  const toggled = [];
  const d = createDaemon({
    socketPath: 'C:/fake/herdr.sock', dir, configDir: path.join(dir, 'config'), herdr,
    subscribe: () => ({ close() {} }), now: () => 1_000_000_000, sendTelegram: async () => true,
    lavish: {
      refresh: async () => new Set(['w4:p1']),
      toggle: ids => { toggled.push([...ids].sort()); return { off: ['page'], panes: new Set() }; },
    },
  });
  try {
    d._test.markConnected();
    await d._test.cycle('test');
    await d._test.refreshLavish();
    await d._test.cycle('test');
    assert.equal(herdr.tokensOf('w9').lavish, lavish.MARK, 'the dot is on the workspace the pane lives in now');
    assert.equal(herdr.tokensOf('w1').lavish, undefined);

    herdr.focus('w9');
    await d.handle('lavish.toggle');
    assert.deepEqual(toggled, [['w4:p1', 'w9:p1']], 'F5 there reaches the page the agent waited on under its old id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
