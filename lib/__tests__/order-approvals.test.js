/**
 * Tests for the shared order boundary on the magi-moni side (R07/R08):
 * approval issuance, trades journaling, and the moomoo_place_order wiring.
 * Run: node --test lib/__tests__/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { issueApproval, journalManualOrder } = require('../order-approvals');

function fakeRunQuery(captured) {
  return async (query, params) => { captured.push({ query, params }); return []; };
}

test('issueApproval inserts an ISSUED event bound to order params and returns the token', async () => {
  const captured = [];
  const token = await issueApproval(
    { symbol: 'aapl', side: 'buy', qty: 10, createdBy: 'test' },
    { runQuery: fakeRunQuery(captured), randomUUID: () => 'fixed-uuid' }
  );
  assert.equal(token, 'fixed-uuid');
  assert.equal(captured.length, 1);
  const { query, params } = captured[0];
  assert.match(query, /order_approvals/);
  assert.match(query, /'ISSUED'/);
  assert.match(query, /INTERVAL 60 SECOND/);
  assert.deepEqual(params, { token: 'fixed-uuid', symbol: 'AAPL', side: 'BUY', qty: 10, created_by: 'test' });
});

test('issueApproval propagates BQ failure (fail closed before broker)', async () => {
  await assert.rejects(
    issueApproval({ symbol: 'AAPL', side: 'BUY', qty: 1 }, { runQuery: async () => { throw new Error('BQ down'); } }),
    /BQ down/
  );
});

test('journalManualOrder writes an honest unconfirmed-fill row', async () => {
  const captured = [];
  await journalManualOrder(
    { symbol: 'msft', side: 'sell', qty: 7, orderId: 'ord-1' },
    { runQuery: fakeRunQuery(captured) }
  );
  const { query, params } = captured[0];
  assert.match(query, /INSERT INTO `.*magi_core\.trades`/);
  assert.match(query, /'AKA-1'/);          // unit_name
  assert.match(query, /false/);            // price_confirmed = false
  assert.match(query, /requested_qty/);
  assert.equal(params.qty, 7);             // bound to requested_qty, not qty
  assert.equal(params.symbol, 'MSFT');
  assert.equal(params.order_id, 'ord-1');
});

// --- tools.js wiring: stub sibling modules via require cache before load ---

test('moomoo_place_order confirmed flow sends approval_token + source and journals', async () => {
  const moomooCalls = [];
  require('../moomoo').callMoomoo = async (path, opts) => {
    moomooCalls.push({ path, body: JSON.parse(opts.body) });
    return { success: true, order_id: 'ORD-42', status: 'FILLED' };
  };
  const bqQueries = [];
  require('../bigquery').runQuery = async (q, p) => { bqQueries.push({ q, p }); return []; };

  const tools = require('../tools');
  const result = await tools.executeAka1Tool('moomoo_place_order', { symbol: 'AAPL', side: 'BUY', qty: 10, confirmed: true });

  assert.equal(result.order_id, 'ORD-42');
  assert.equal(moomooCalls.length, 1);
  const body = moomooCalls[0].body;
  assert.equal(body.source, 'magi-moni');
  assert.ok(body.approval_token, 'approval token sent to the gate');
  assert.equal(body.qty, 10);

  const issued = bqQueries.find(x => /order_approvals/.test(x.q) && /'ISSUED'/.test(x.q));
  assert.ok(issued, 'approval ISSUED row written');
  assert.equal(issued.p.token, body.approval_token);

  const journal = bqQueries.find(x => /magi_core\.trades/.test(x.q));
  assert.ok(journal, 'trades journal row written');
});

test('moomoo_place_order without confirmed returns confirmation prompt and never touches broker', async () => {
  const moomooCalls = [];
  require('../moomoo').callMoomoo = async (...a) => { moomooCalls.push(a); throw new Error('should not be called'); };
  const tools = require('../tools');
  // qty > 100 triggers confirm_required per policy engine
  const result = await tools.executeAka1Tool('moomoo_place_order', { symbol: 'AAPL', side: 'BUY', qty: 200 });
  assert.equal(result.status, 'confirmation_required');
  assert.equal(moomooCalls.length, 0);
});

test('moomoo_place_order: approval issuance failure fails closed (no broker call)', async () => {
  const moomooCalls = [];
  require('../moomoo').callMoomoo = async (...a) => { moomooCalls.push(a); return {}; };
  require('../bigquery').runQuery = async (q) => {
    if (/order_approvals/.test(q)) throw new Error('approvals table missing');
    return [];
  };
  const tools = require('../tools');
  await assert.rejects(
    tools.executeAka1Tool('moomoo_place_order', { symbol: 'AAPL', side: 'BUY', qty: 10, confirmed: true }),
    /approvals table missing/
  );
  assert.equal(moomooCalls.length, 0);
});
