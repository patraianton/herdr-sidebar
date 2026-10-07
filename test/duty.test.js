'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const duty = require('../src/duty');

const MIN = 60000;
const S = duty.DEFAULT_SETTINGS;
const T0 = 1_000_000_000;
const STARTED = T0 - 60 * MIN; // helper started long ago: no grace

const agent = (over = {}) => ({
  pane_id: 'w1:p1', workspace_id: 'w1', terminal_id: 't1', agent_status: 'idle', state_change_seq: 10,
  agent_session: { value: 'sess-1' }, ...over,
});
const fresh = (over = {}) => duty.newDuty({
  id: 'd1', wsId: 'w1', label: 'ads-watch', paneId: 'w1:p1', terminalId: 't1', agentSession: 'sess-1',
  everyMs: 30 * MIN, note: '', source: 'agent', now: T0, ...over,
});

test('parseEvery', () => {
  assert.equal(duty.parseEvery('30m'), 30 * MIN);
  assert.equal(duty.parseEvery('1h'), 60 * MIN);
  assert.equal(duty.parseEvery('2h'), 120 * MIN);
  assert.equal(duty.parseEvery('90'), 90 * MIN);
  assert.equal(duty.parseEvery('1,5h'), 90 * MIN);
  assert.equal(duty.parseEvery('45s'), 45000);
  assert.equal(duty.parseEvery('soon'), null);
  assert.equal(duty.parseEvery('0m'), null);
});

test('fmtDur', () => {
  assert.equal(duty.fmtDur(25 * MIN + 59000), '25m');
  assert.equal(duty.fmtDur(60 * MIN), '1h');
  assert.equal(duty.fmtDur(90 * MIN), '1h30m');
  assert.equal(duty.fmtDur(50 * 60 * MIN), '2d');
});

test('ok token while healthy', () => {
  assert.equal(duty.dutyToken(fresh()), '◆ on duty · 30m');
  assert.equal(duty.dutyToken(fresh({ everyMs: 60 * MIN })), '◆ on duty · 1h');
});

test('locateAgent: terminal, then agent session, then pane', () => {
  const d = fresh();
  assert.equal(duty.locateAgent(d, [agent({ pane_id: 'w9:p1', terminal_id: 't1' })]).pane_id, 'w9:p1');
  assert.equal(duty.locateAgent(d, [agent({ terminal_id: 't2', pane_id: 'w5:p3' })]).pane_id, 'w5:p3');
  assert.equal(duty.locateAgent(d, [agent({ terminal_id: 't2', agent_session: { value: 'other' } })]), null, 'same pane, another agent session: not ours');
  assert.equal(duty.locateAgent(d, [agent({ terminal_id: 't2', agent_session: null })]).pane_id, 'w1:p1');
  assert.equal(duty.locateAgent(d, [agent({ terminal_id: 't2', agent_session: null, pane_id: 'w2:p1' })]), null);
});

test('stopped waking up: alert after interval + max(interval/2, 10m), once', () => {
  let d = fresh();
  let r = duty.evaluate(d, agent(), T0 + 44 * MIN, S, STARTED);
  assert.equal(r.event, null);
  r = duty.evaluate(r.duty, agent(), T0 + 46 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  assert.equal(r.duty.alert.kind, 'sleep');
  assert.equal(duty.dutyToken(r.duty), '▲ no wake-up for 46m');
  r = duty.evaluate(r.duty, agent(), T0 + 75 * MIN, S, STARTED);
  assert.equal(r.event, null, 'no repeat while the alert stands');
  assert.equal(duty.dutyToken(r.duty), '▲ no wake-up for 1h15m');
});

test('a short wake-up between checks counts as life (state_change_seq grew)', () => {
  let r = duty.evaluate(fresh(), agent({ state_change_seq: 10 }), T0 + 1 * MIN, S, STARTED);
  r = duty.evaluate(r.duty, agent({ state_change_seq: 14 }), T0 + 40 * MIN, S, STARTED);
  assert.equal(r.duty.lastLifeAt, T0 + 40 * MIN);
  r = duty.evaluate(r.duty, agent({ state_change_seq: 14 }), T0 + 80 * MIN, S, STARTED);
  assert.equal(r.event, null);
});

test('working status counts as life', () => {
  const r = duty.evaluate(fresh(), agent({ agent_status: 'working' }), T0 + 50 * MIN, S, STARTED);
  assert.equal(r.event, null);
  assert.equal(r.duty.lastLifeAt, T0 + 50 * MIN);
});

test('recovery after an alert sends one recover event', () => {
  let r = duty.evaluate(fresh(), agent(), T0 + 50 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  r = duty.evaluate(r.duty, agent({ agent_status: 'working' }), T0 + 51 * MIN, S, STARTED);
  assert.equal(r.event, 'recover');
  assert.equal(r.duty.alert, null);
  assert.equal(duty.dutyToken(r.duty), '◆ on duty · 30m');
});

test('stuck on a question: blocked longer than 10 minutes', () => {
  let r = duty.evaluate(fresh(), agent({ agent_status: 'blocked', state_change_seq: 11 }), T0 + 1 * MIN, S, STARTED);
  assert.equal(r.event, null);
  r = duty.evaluate(r.duty, agent({ agent_status: 'blocked', state_change_seq: 11 }), T0 + 12 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  assert.equal(r.duty.alert.kind, 'blocked');
  assert.equal(duty.dutyToken(r.duty), '▲ waiting for input 11m');
});

test('agent window gone for 3 minutes', () => {
  let r = duty.evaluate(fresh(), null, T0 + 1 * MIN, S, STARTED);
  assert.equal(r.event, null);
  r = duty.evaluate(r.duty, null, T0 + 4 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  assert.equal(duty.dutyToken(r.duty), '▲ agent pane is gone');
  r = duty.evaluate(r.duty, agent({ terminal_id: 't7' }), T0 + 5 * MIN, S, STARTED);
  assert.equal(r.event, 'recover', 'found again by agent session after a restart');
  assert.equal(r.duty.terminalId, 't7');
});

test('agent reported trouble: immediate, cleared only by ok or reset', () => {
  let d = duty.applyFail(fresh(), T0 + 1 * MIN, 'Google Ads console does not open');
  let r = duty.evaluate(d, agent({ agent_status: 'working' }), T0 + 1 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  assert.equal(duty.dutyToken(r.duty), '▲ Google Ads console does not open');
  r = duty.evaluate(r.duty, agent({ agent_status: 'working' }), T0 + 2 * MIN, S, STARTED);
  assert.equal(r.event, null);
  d = duty.applyOk(r.duty, T0 + 3 * MIN);
  r = duty.evaluate(d, agent(), T0 + 3 * MIN, S, STARTED);
  assert.equal(r.event, 'recover');
  d = duty.applyReset(duty.applyFail(r.duty, T0 + 4 * MIN, 'x'), T0 + 4 * MIN);
  assert.equal(d.fail, null);
  assert.equal(d.alert, null);
});

test('fail reason is shortened to fit a token', () => {
  const d = duty.applyFail(fresh(), T0, 'x'.repeat(200));
  assert.ok(d.fail.reason.length <= 70);
  assert.equal(duty.applyFail(fresh(), T0, '   ').fail.reason, 'the agent reported a problem');
});

test('grace after the helper starts: no new alert, no false recovery', () => {
  const started = T0 + 100 * MIN;
  let d = fresh();
  let r = duty.evaluate(d, null, T0 + 101 * MIN, S, started);
  assert.equal(r.event, null);
  r = duty.evaluate(r.duty, null, T0 + 109 * MIN, S, started);
  assert.equal(r.event, null, 'still in grace');
  r = duty.evaluate(r.duty, null, T0 + 111 * MIN, S, started);
  assert.equal(r.event, 'alert');
  // an alert that already stood before a restart is kept during grace
  r = duty.evaluate(r.duty, null, T0 + 200 * MIN, S, T0 + 199 * MIN);
  assert.equal(r.event, null);
  assert.ok(r.duty.alert);
});

test('fail alerts even in grace', () => {
  const d = duty.applyFail(fresh(), T0, 'trouble');
  assert.equal(duty.evaluate(d, agent(), T0 + MIN, S, T0).event, 'alert');
});

test('alert kind change during one incident does not notify again', () => {
  let r = duty.evaluate(fresh(), agent({ agent_status: 'blocked' }), T0 + 1 * MIN, S, STARTED);
  r = duty.evaluate(r.duty, agent({ agent_status: 'blocked' }), T0 + 12 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  r = duty.evaluate(r.duty, null, T0 + 13 * MIN, S, STARTED);
  r = duty.evaluate(r.duty, null, T0 + 17 * MIN, S, STARTED);
  assert.equal(r.event, null);
  assert.equal(r.duty.alert.kind, 'gone');
});

test('messages', () => {
  const d = { ...fresh(), alert: { kind: 'sleep', text: 'no wake-up for 75m', since: T0 } };
  assert.equal(duty.alertText('ads-watch', d), '🔴 Duty: ads-watch — no wake-up for 75m');
  assert.equal(duty.recoverText('ads-watch'), '🟢 Duty: ads-watch — working again');
});

test('after a restart a new terminal with a lower seq is not a wake-up; a sleep alert waits for real activity', () => {
  let r = duty.evaluate(fresh(), agent({ state_change_seq: 500 }), T0 + 1 * MIN, S, STARTED);
  r = duty.evaluate(r.duty, agent({ state_change_seq: 500 }), T0 + 50 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  const started2 = T0 + 60 * MIN;
  r = duty.evaluate(r.duty, agent({ terminal_id: 't9', state_change_seq: 3 }), T0 + 61 * MIN, S, started2);
  assert.equal(r.event, null);
  r = duty.evaluate(r.duty, agent({ terminal_id: 't9', state_change_seq: 3 }), T0 + 72 * MIN, S, started2);
  assert.equal(r.event, null, 'no false recovery after grace');
  assert.ok(r.duty.alert);
  r = duty.evaluate(r.duty, agent({ terminal_id: 't9', state_change_seq: 4 }), T0 + 73 * MIN, S, started2);
  assert.equal(r.event, 'recover', 'real activity clears it');
});

test('an agent back after a long absence with a new terminal is not reported as not waking', () => {
  let r = duty.evaluate(fresh(), null, T0 + 1 * MIN, S, STARTED);
  r = duty.evaluate(r.duty, null, T0 + 5 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  r = duty.evaluate(r.duty, agent({ terminal_id: 't9' }), T0 + 200 * MIN, S, STARTED);
  assert.equal(r.event, 'recover');
  assert.equal(duty.dutyToken(r.duty), '◆ on duty · 30m');
});

test('ok clears an agent-reported alert at once, even right after the helper started', () => {
  let d = duty.applyFail(fresh(), T0 + MIN, 'trouble');
  let r = duty.evaluate(d, agent(), T0 + MIN, S, T0);
  assert.equal(r.event, 'alert');
  d = duty.applyOk(r.duty, T0 + 2 * MIN);
  r = duty.evaluate(d, agent(), T0 + 2 * MIN, S, T0);
  assert.equal(r.event, 'recover');
  assert.equal(duty.dutyToken(r.duty), '◆ on duty · 30m');
});

test('a window that comes back during the grace period is reported as recovered', () => {
  let r = duty.evaluate(fresh(), null, T0 + 1 * MIN, S, STARTED);
  r = duty.evaluate(r.duty, null, T0 + 5 * MIN, S, STARTED);
  assert.equal(r.event, 'alert');
  r = duty.evaluate(r.duty, agent(), T0 + 6 * MIN, S, T0 + 6 * MIN);
  assert.equal(r.event, 'recover');
});
