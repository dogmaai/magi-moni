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

async function getKillSwitchStatus({ runQuery: rq = runQuery } = {}) {
  const rows = await rq(
    `SELECT trading_halted, reason, updated_by, updated_at
     FROM ${TABLE}
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const r = rows[0];
  // Only an explicit boolean confirms state. 0 rows, NULL, or a non-boolean
  // value is UNKNOWN — never report it as "running".
  if (!r || (r.trading_halted !== true && r.trading_halted !== false)) {
    return { halted: false, unknown: true, reason: null, updated_by: null, updated_at: null };
  }
  return {
    halted: r.trading_halted === true,
    unknown: false,
    reason: r.reason || null,
    updated_by: r.updated_by || null,
    updated_at: r.updated_at?.value || null,
  };
}

async function setKillSwitch(halted, { reason = null, updatedBy = null, runQuery: rq = runQuery } = {}) {
  await rq(
    `INSERT INTO ${TABLE} (updated_at, trading_halted, reason, updated_by)
     VALUES (CURRENT_TIMESTAMP(), @halted, @reason, @updatedBy)`,
    { halted, reason, updatedBy },
    { halted: 'BOOL', reason: 'STRING', updatedBy: 'STRING' }
  );
  // The write already succeeded; never fail the operation on the read-back.
  return getKillSwitchStatus({ runQuery: rq }).catch(() => ({
    halted: Boolean(halted),
    unknown: false,
    reason,
    updated_by: updatedBy,
    updated_at: null,
  }));
}

module.exports = { getKillSwitchStatus, setKillSwitch };
