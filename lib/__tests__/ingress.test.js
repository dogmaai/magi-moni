const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { generateKeyPairSync, sign } = require('node:crypto');

delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
const commands = [];
require('../commands').handleBotCommand = async (...args) => { commands.push(args); };
const app = require('../../server');

test('Discord-only deployment cannot expose unauthenticated legacy kill/resume', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const enabled of ['true', 'false']) {
      process.env.TELEGRAM_ENABLED = enabled;
      for (const text of ['/kill', '/resume']) {
        const res = await fetch(`${url}/webhook/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { chat: { id: 'fake' }, text } }) });
        assert.equal(res.status, enabled === 'false' ? 410 : 403);
      }
    }
    assert.equal(commands.length, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.TELEGRAM_ENABLED; }
});

test('Express passes untouched bytes into Discord signature verification', async () => {
  const keys = generateKeyPairSync('ed25519');
  process.env.DISCORD_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  process.env.DISCORD_APPLICATION_ID = '123';
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/webhook/discord`;
  const body = '{  "application_id" : "123", "type" : 1 }';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex');
  const headers = { 'Content-Type': 'application/json', 'x-signature-timestamp': timestamp, 'x-signature-ed25519': signature };
  try {
    const ping = await fetch(url, { method: 'POST', headers, body });
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { type: 1 });
    const tampered = await fetch(url, { method: 'POST', headers, body: JSON.stringify(JSON.parse(body)) });
    assert.equal(tampered.status, 401);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
