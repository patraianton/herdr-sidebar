'use strict';
// herdr socket API: one request per connection, plus a long-lived event stream.
const net = require('node:net');
const { pipePath } = require('./paths');

class HerdrError extends Error {
  constructor(method, err) {
    super(`${method}: ${err.code || 'error'} ${err.message || ''}`.trim());
    this.code = err.code;
  }
}

let seq = 0;

function call(socketPath, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(pipePath(socketPath));
    let buf = '';
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`${method}: timeout`)), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('error', e => finish(e));
    conn.on('close', () => finish(new Error(`${method}: connection closed`)));
    conn.on('data', d => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch (e) { finish(e); return; }
      if (msg.error) finish(new HerdrError(method, msg.error)); else finish(null, msg.result);
    });
    conn.on('connect', () => conn.write(JSON.stringify({ id: `sb_${process.pid}_${++seq}`, method, params }) + '\n'));
  });
}

function subscribe(socketPath, subscriptions, { onReady, onEvent, onClose } = {}) {
  const conn = net.createConnection(pipePath(socketPath));
  const id = `sb_sub_${process.pid}_${++seq}`;
  let buf = '';
  let closed = false;
  const end = err => {
    if (closed) return;
    closed = true;
    if (onClose) onClose(err);
  };
  conn.setEncoding('utf8');
  conn.on('connect', () => conn.write(JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n'));
  conn.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === id && msg.error) { end(new HerdrError('events.subscribe', msg.error)); conn.destroy(); return; }
      if (msg.id === id && msg.result && msg.result.type === 'subscription_started') { if (onReady) onReady(); continue; }
      if (onEvent) onEvent(msg);
    }
  });
  conn.on('error', e => end(e));
  conn.on('close', () => end());
  return { close() { closed = true; conn.destroy(); } };
}

module.exports = { call, subscribe, HerdrError };
