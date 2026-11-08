const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { chunks, webhookUrl, verifySignature, createInteractionHandler, sendText } = require('../discord');
const { createPendingApprovals, authorize, consumeAuthorization, context } = require('../operator-context');

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const env = { DISCORD_PUBLIC_KEY: publicKey, DISCORD_APPLICATION_ID: '123', DISCORD_OWNER_ID: 'jun', DISCORD_GUILD_ID: 'guild', DISCORD_OPS_CHANNEL_ID: 'ops' };
function request(event, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = Buffer.from(JSON.stringify(event));
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), keys.privateKey).toString('hex');
  return { body, get: name => ({ 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp })[name] };
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, sendStatus(code) { this.statusCode = code; }, json(value) { this.body = value; }, end() {} };
}
const event = (name = 'ask') => ({ application_id: '123', id: '567', token: 'dummy_token', type: 2, guild_id: 'guild', channel_id: 'ops', member: { user: { id: 'jun' } }, data: { name, options: [{ name: 'message', value: 'hello' }] } });

test('signature is over raw body + fresh timestamp, rejects tampering and missing key', () => {
  const req = request(event());
  assert.equal(verifySignature(req, publicKey), true);
  req.body = Buffer.from('{}');
  assert.equal(verifySignature(req, publicKey), false);
  assert.equal(verifySignature(request(event(), '1000000000'), publicKey), false);
  assert.equal(verifySignature(request(event()), undefined), false);
});

test('signed PING succeeds, owner/guild/channel/application mismatch fail closed', async () => {
  let calls = 0;
  const handler = createInteractionHandler({ env, fetchImpl: async () => { calls++; throw new Error('no network'); } });
  const ping = response();
  await handler(request({ application_id: '123', type: 1 }), ping);
  assert.deepEqual(ping.body, { type: 1 });
  for (const change of [{ member: { user: { id: 'other' } } }, { guild_id: 'other' }, { channel_id: 'public' }, { application_id: 'other' }, { member: undefined }]) {
    const res = response();
    await handler(request({ ...event(), ...change }), res);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(calls, 0);
});

test('ACK acceptance precedes work; duplicate ACK rejection never executes work', async () => {
  const calls = [];
  let accepted = true;
  const handler = createInteractionHandler({ env, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: accepted }; }, ask: async () => { calls.push('ask'); } });
  await handler(request(event()), response());
  assert.equal(calls[0].body.type, 5);
  assert.equal(calls[0].body.data.flags, 64);
  assert.equal(calls[1], 'ask');
  accepted = false;
  await handler(request(event()), response());
  assert.equal(calls.filter(c => c === 'ask').length, 1);
});

test('resume approval is immutable, owner-bound, single-use and executed only after click', async () => {
  const posts = [], executions = [];
  const handler = createInteractionHandler({ env, fetchImpl: async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true }; }, execute: async (name, input, grant) => {
    assert.equal(consumeAuthorization(grant, name, input), 'jun');
    executions.push({ name, input });
    return { status: 'resumed' };
  } });
  await handler(request(event('resume')), response());
  assert.equal(executions.length, 0);
  const custom_id = posts.find(p => p.components).components[0].components[0].custom_id;
  const click = { ...event(), id: '568', type: 3, data: { custom_id } };
  await Promise.all([handler(request(click), response()), handler(request({ ...click, id: '569' }), response())]);
  assert.deepEqual(executions, [{ name: 'resume_trading', input: {} }]);
});

test('pending approvals expire, survive input mutation safely, and reject other identities', () => {
  let now = 0;
  const store = createPendingApprovals({ now: () => now });
  const identity = { actor: 'jun', guild: 'guild', channel: 'ops' };
  const params = { symbol: 'AAPL', qty: 1 };
  const p = store.create('order', params, identity);
  params.qty = 999;
  assert.equal(store.take(p.id, { ...identity, actor: 'other' }), null);
  assert.equal(store.take(p.id, identity).input.qty, 1);
  assert.equal(store.take(p.id, identity), null);
  const expired = store.create('order', {}, identity);
  now = 60001;
  assert.equal(store.take(expired.id, identity), null);
  const grant = authorize('order', { qty: 1 }, 'jun');
  assert.equal(consumeAuthorization(grant, 'order', { qty: 2 }), null);
  assert.equal(consumeAuthorization(grant, 'order', { qty: 1 }), null);
});

test('Discord sends are chunked, mention-safe, destination-restricted and report failure', async () => {
  const posts = [];
  const text = '😀'.repeat(2100);
  assert.equal(chunks(text).join(''), text);
  assert.ok(chunks(text).every(p => p.length <= 2000 && !/[\uD800-\uDBFF]$/.test(p)));
  assert.throws(() => webhookUrl('https://evil.test/api/webhooks/123/dummy'));
  assert.equal(await sendText('https://discord.com/api/webhooks/123/dummy', '@everyone'.repeat(300), { fetchImpl: async (_, init) => { posts.push(JSON.parse(init.body)); return { ok: posts.length === 1 }; } }), false);
  assert.deepEqual(posts[0].allowed_mentions, { parse: [] });
});

test('operator contexts stay isolated across simultaneous requests', async () => {
  const seen = [];
  await Promise.all(['one', 'two'].map(actor => context.run({ actor }, async () => { await Promise.resolve(); seen.push(context.getStore().actor); })));
  assert.deepEqual(seen.sort(), ['one', 'two']);
  assert.equal(context.getStore(), undefined);
});
