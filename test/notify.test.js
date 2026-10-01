'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notify = require('../src/notify');

test('readEnvValue handles BOM, CRLF, export and quotes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-env-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, '﻿# c\r\nA=1\r\nexport TELEGRAM_SESSION_BOT_TOKEN="123:abc"\r\nB = \'x y\'\r\n');
  assert.equal(notify.readEnvValue(f, 'TELEGRAM_SESSION_BOT_TOKEN'), '123:abc');
  assert.equal(notify.readEnvValue(f, 'B'), 'x y');
  assert.equal(notify.readEnvValue(f, 'NOPE'), null);
  assert.equal(notify.readEnvValue(path.join(dir, 'missing'), 'A'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sendTelegram stays silent when not configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tg-'));
  assert.equal(await notify.sendTelegram(dir, 'x'), null);
  fs.writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify({ envFile: 'x', chatId: 0 }));
  assert.equal(await notify.sendTelegram(dir, 'x'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
