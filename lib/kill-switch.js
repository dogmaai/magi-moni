/**
 * @module lib/kill-switch
 * Emergency kill switch state in BigQuery magi_core.system_control.
 * When trading_halted is true, magi-core blocks ALL orders (entries and
 * exits) at the L0 guard until it is cleared.
 *
 * Three states, mirroring magi-core lib/kill-switch.js:
 *   halted=true              — confirmed engaged (trading_halted === true)
 *   halted=false,unknown=false — confirmed RUNNING (trading_halted === false)
 *   unknown=true             — the control table returned no row, NULL, or
 *                              an uninterpretable value; NOT evidence of
 *                              RUNNING. Status surfaces must say "unknown"
 *                              rather than "通常稼働中".
 */
const { runQuery } = require('./bigquery');
const { PROJECT_ID } = require('./config');

const TABLE = `\`${PROJECT_ID}.magi_core.system_control\``;

/** Last state confirmed by a successful BQ read (HALTED latches). */
let _lastConfirmedHalted = null;

function _unreadable(why) {
  if (_lastConfirmedHalted) {
    console.warn(`[L0] Kill-switch ${why}; confirmed HALTED stays latched`);
    return { ..._lastConfirmedHalted };
  }
  console.warn(`[L0] Kill-switch ${why} — state UNKNOWN`);
  return { halted: false, unknown: true, reason: null, updated_by: null, updated_at: null };
}

async function getKillSwitchStatus({ runQuery: rq = runQuery } = {}) {
  let rows;
  try {
    rows = await rq(
      `SELECT trading_halted, reason, updated_by, updated_at
       FROM ${TABLE}
       ORDER BY updated_at DESC
       LIMIT 1`
    );
  } catch (e) {
    // A rejected query (outage, IAM, missing table) is UNKNOWN, not a
    // generic error — and a confirmed HALTED stays latched through it.
    return _unreadable(`lookup failed (${e.message})`);
  }
  const r = rows[0];
  // Only an explicit boolean confirms state. 0 rows, NULL, or a non-boolean
  // value is UNKNOWN — never report it as "running".
  if (!r || (r.trading_halted !== true && r.trading_halted !== false)) {
    return _unreadable('returned no interpretable row');
  }
  const state = {
    halted: r.trading_halted === true,
    unknown: false,
    reason: r.reason || null,
    updated_by: r.updated_by || null,
    updated_at: r.updated_at?.value || null,
  };
  _lastConfirmedHalted = state.halted ? state : null;
  return state;
}

async function setKillSwitch(halted, { reason = null, updatedBy = null, runQuery: rq = runQuery } = {}) {
  await rq(
    `INSERT INTO ${TABLE} (updated_at, trading_halted, reason, updated_by)
     VALUES (CURRENT_TIMESTAMP(), @halted, @reason, @updatedBy)`,
    { halted, reason, updatedBy },
    { halted: 'BOOL', reason: 'STRING', updatedBy: 'STRING' }
  );
  // The write already succeeded; never fail the operation on the read-back.
  // If the read-back can't confirm (UNKNOWN), report the state we just wrote.
  const s = await getKillSwitchStatus({ runQuery: rq }).catch(() => null);
  if (s && !s.unknown && s.halted === halted) return s;
  const confirmed = {
    halted: Boolean(halted),
    unknown: false,
    reason,
    updated_by: updatedBy,
    updated_at: null,
  };
  _lastConfirmedHalted = confirmed.halted ? confirmed : null;
  return confirmed;
}

/** Test hook: clear the latched HALTED state. */
function _resetLatchForTests() {
  _lastConfirmedHalted = null;
}

module.exports = { getKillSwitchStatus, setKillSwitch, _resetLatchForTests };
