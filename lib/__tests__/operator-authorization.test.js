const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authorize } = require('../operator-context');

const unexpected = async () => { throw new Error('Unexpected side effect'); };
global.fetch = unexpected;
require('google-auth-library').GoogleAuth.prototype.getClient = unexpected;
require('../bigquery').runQuery = unexpected;
require('../moomoo').callMoomoo = unexpected;
require('../kill-switch').setKillSwitch = unexpected;
const focusCalls = [];
require('../focus-symbols').addFocusSymbol = async (symbol, options) => {
  focusCalls.push({ symbol, options });
  return { symbol, active_count: 1 };
};
const { executeAka1Tool } = require('../tools');

test('every mutating tool rejects LLM confirmed=true and forged grant objects', async () => {
  const mutations = ['moomoo_place_order', 'tiala_restart', 'tiala_exec', 'tiala_action',
    'openclaw_agent', 'add_focus_symbol', 'remove_focus_symbol', 'trigger_job',
    'trigger_optuna', 'emergency_kill', 'resume_trading'];
  for (const name of mutations) {
    const result = await executeAka1Tool(name, { symbol: 'AAPL', side: 'BUY', qty: 1, confirmed: true }, { actor: 'jun' });
    assert.equal(result.status, 'confirmation_required', name);
  }
  assert.equal(focusCalls.length, 0);
});

test('focus-symbol audit uses the authenticated confirming operator, not Telegram', async () => {
  const input = { symbol: 'AAPL', note: 'operator test' };
  const grant = authorize('add_focus_symbol', input, 'jun-test');
  const result = await executeAka1Tool('add_focus_symbol', input, grant);
  assert.equal(result.status, 'executed');
  assert.deepEqual(focusCalls, [{ symbol: 'AAPL', options: { note: 'operator test', addedBy: 'discord:jun-test' } }]);
  assert.equal((await executeAka1Tool('add_focus_symbol', input, grant)).status, 'confirmation_required');
  assert.equal(focusCalls.length, 1);
});

test('/report sends the actual daily generator message, not its wrapper object', async () => {
  const { generateKeyPairSync, sign } = require('node:crypto');
  const { createInteractionHandler } = require('../discord');
  let queries = 0;
  require('../bigquery').runQuery = async () => { queries++; return []; };
  const { generateDailyReport } = require('../reports');
  const keys = generateKeyPairSync('ed25519');
  const env = { DISCORD_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), DISCORD_APPLICATION_ID: '123', DISCORD_OWNER_ID: 'jun', DISCORD_GUILD_ID: 'guild', DISCORD_OPS_CHANNEL_ID: 'ops' };
  const body = Buffer.from(JSON.stringify({ application_id: '123', id: '567', token: 'fake_token', type: 2, guild_id: 'guild', channel_id: 'ops', member: { user: { id: 'jun' } }, data: { name: 'report' } }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), keys.privateKey).toString('hex');
  const posts = [];
  const handler = createInteractionHandler({ env, report: generateDailyReport, fetchImpl: async (_, init) => { posts.push(JSON.parse(init.body)); return { ok: true }; } });
  const req = { body, get: name => ({ 'x-signature-timestamp': timestamp, 'x-signature-ed25519': signature })[name] };
  const res = { status() { return this; }, end() {} };
  await handler(req, res);
  assert.equal(queries, 3);
  const contents = posts.slice(1).map(p => p.content).join('');
  assert.match(contents, /MAGI/);
  assert.match(contents, /取引/);
  assert.equal(contents.includes('[object Object]'), false);
});
