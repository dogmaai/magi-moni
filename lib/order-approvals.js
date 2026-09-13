/**
 * @module lib/order-approvals
 * Operator approval issuance and manual-order journaling for the shared
 * magi-moomoo order boundary (R07/R08).
 *
 * The boundary requires a single-use approval token for non-reducing orders
 * from non-magi-core callers. This module writes the ISSUED event to
 * magi_core.order_approvals after an operator confirmation, and journals the
 * submitted order to magi_core.trades with the same honest-fill semantics as
 * magi-core (price_confirmed=false until the broker confirms a fill;
 * fill-reconcile picks the row up from there).
 *
 * Deps are injectable for testing.
 */
const crypto = require('crypto');
const { PROJECT_ID } = require('./config');

const APPROVAL_TTL_S = 60;
const TABLE = `\`${PROJECT_ID}.magi_core.order_approvals\``;

/**
 * Issue a single-use approval token bound to (symbol, side, qty).
 * @returns {Promise<string>} token
 */
async function issueApproval({ symbol, side, qty, createdBy = 'aka1-telegram' }, deps = {}) {
  const query = deps.runQuery || require('./bigquery').runQuery;
  const token = (deps.randomUUID || (() => crypto.randomUUID()))();
  await query(
    `INSERT INTO ${TABLE}
     (token, event, symbol, side, qty, created_by, order_id, expires_at, created_at)
     VALUES (@token, 'ISSUED', @symbol, @side, @qty, @created_by, NULL,
             TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL ${APPROVAL_TTL_S} SECOND),
             CURRENT_TIMESTAMP())`,
    { token, symbol: String(symbol).toUpperCase(), side: String(side).toUpperCase(), qty: Number(qty), created_by: createdBy }
  );
  return token;
}

/**
 * Journal a submitted manual order to magi_core.trades.
 * Follows the R02 convention: qty/price are 0/null until the broker confirms
 * the fill; requested_qty records what was sent; fill-reconcile picks up
 * price_confirmed=false rows.
 */
async function journalManualOrder({ symbol, side, qty, orderId, brokerStatus }, deps = {}) {
  const query = deps.runQuery || require('./bigquery').runQuery;
  await query(
    `INSERT INTO \`${PROJECT_ID}.magi_core.trades\`
     (session_id, timestamp, order_id, symbol, side, qty, price, reason,
      trade_mode, unit_name, result, order_attempts, broker,
      price_confirmed, requested_qty)
     VALUES ('aka1-telegram', CURRENT_TIMESTAMP(), @order_id, @symbol, @side,
             0, NULL, 'AKA-1 Telegram manual order', 'NORMAL', 'AKA-1',
             NULL, 1, 'moomoo', false, @qty)`,
    { order_id: orderId || null, symbol: String(symbol).toUpperCase(), side: String(side).toUpperCase(), qty: Number(qty) }
  );
}

module.exports = { issueApproval, journalManualOrder, APPROVAL_TTL_S };
