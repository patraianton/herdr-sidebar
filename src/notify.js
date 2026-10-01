'use strict';
// Telegram messages from the Fixer bot. The bot key is read from its .env on
// every send and is never copied or logged.
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { loadJson } = require('./store');

function readEnvValue(file, key) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return null;
}

// true: sent; false: failed (worth one retry); null: Telegram is not set up.
function sendTelegram(configDir, text, { log = () => {} } = {}) {
  if (process.env.SIDEBAR_TELEGRAM_DISABLED === '1') return Promise.resolve(null);
  const cfg = loadJson(path.join(configDir, 'telegram.json'), null);
  if (!cfg || !cfg.chatId || cfg.enabled === false) return Promise.resolve(null);
  const token = readEnvValue(cfg.envFile, cfg.envKey || 'TELEGRAM_SESSION_BOT_TOKEN');
  if (!token) { log('telegram: bot key not found in', cfg.envFile); return Promise.resolve(false); }
  const body = JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', timeout: 15000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) log('telegram: http', res.statusCode, data.slice(0, 200));
        resolve(res.statusCode === 200);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => { log('telegram:', e.message); resolve(false); });
    req.end(body);
  });
}

async function sendTelegramWithRetry(configDir, text, opts = {}) {
  const first = await sendTelegram(configDir, text, opts);
  if (first !== false) return first;
  await new Promise(r => setTimeout(r, opts.retryMs || 60000));
  return sendTelegram(configDir, text, opts);
}

module.exports = { readEnvValue, sendTelegram, sendTelegramWithRetry };
