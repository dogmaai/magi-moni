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
