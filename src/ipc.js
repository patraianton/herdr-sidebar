'use strict';
// The helper's own pipe: newline-delimited JSON { id, cmd, args } -> { id, ok, result | error }.
const net = require('node:net');
const fs = require('node:fs');

const CONN_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

function isConnError(e) { return !!e && !e.remote && CONN_CODES.has(e.code); }

function listen(pipe, onConn) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConn);
    server.once('error', reject);
    server.listen(pipe, () => { server.removeListener('error', reject); resolve(server); });
  });
}

async function serve(pipe, handler) {
  const onConn = conn => {
    conn.setEncoding('utf8');
    let buf = '';
    conn.on('error', () => {});
    conn.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        Promise.resolve()
          .then(() => handler(req.cmd, req.args || {}))
          .then(result => ({ id: req.id, ok: true, result: result === undefined ? null : result }),
            e => ({ id: req.id, ok: false, error: String((e && e.message) || e) }))
          .then(res => { if (!conn.destroyed) conn.write(JSON.stringify(res) + '\n'); });
      }
    });
  };
  try {
    return await listen(pipe, onConn);
  } catch (e) {
    // Unix only: a socket file left by a crashed helper.
    if (e.code === 'EADDRINUSE' && process.platform !== 'win32') {
      const alive = await request(pipe, 'ping', {}, 1000).then(() => true, () => false);
      if (!alive) { try { fs.unlinkSync(pipe); } catch {} return listen(pipe, onConn); }
    }
    throw e;
  }
}

function request(pipe, cmd, args = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(pipe);
    let buf = '';
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error(`${cmd}: the helper did not answer in time`), { code: 'ETIMEDOUT' })), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('error', e => finish(e));
    conn.on('close', () => finish(Object.assign(new Error(`${cmd}: the connection to the helper broke`), { code: 'ECONNRESET' })));
    conn.on('data', d => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch (e) { finish(e); return; }
      if (msg.ok) finish(null, msg.result);
      else finish(Object.assign(new Error(msg.error || 'helper error'), { remote: true }));
    });
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, cmd, args }) + '\n'));
  });
}

module.exports = { serve, request, isConnError };
