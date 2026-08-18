/**
 * @module lib/kill-switch
 * Emergency kill switch state in BigQuery magi_core.system_control.
 * When trading_halted is true, magi-core blocks ALL orders (entries and
 * exits) at the L0 guard until it is cleared.
 */
const { runQuery } = require('./bigquery');
const { PROJECT_ID } = require('./config');

const TABLE = `\`${PROJECT_ID}.magi_core.system_control\``;

async function getKillSwitchStatus() {
  const rows = await runQuery(
    `SELECT trading_halted, reason, updated_by, updated_at
     FROM ${TABLE}
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const r = rows[0];
  if (!r) return { halted: false, reason: null, updated_by: null, updated_at: null };
  return {
    halted: Boolean(r.trading_halted),
    reason: r.reason || null,
    updated_by: r.updated_by || null,
    updated_at: r.updated_at?.value || null,
  };
}

async function setKillSwitch(halted, { reason = null, updatedBy = null } = {}) {
  await runQuery(
    `INSERT INTO ${TABLE} (updated_at, trading_halted, reason, updated_by)
     VALUES (CURRENT_TIMESTAMP(), @halted, @reason, @updatedBy)`,
    { halted, reason, updatedBy },
    { halted: 'BOOL', reason: 'STRING', updatedBy: 'STRING' }
  );
  // The write already succeeded; never fail the operation on the read-back.
  return getKillSwitchStatus().catch(() => ({
    halted: Boolean(halted),
    reason,
    updated_by: updatedBy,
    updated_at: null,
  }));
}

module.exports = { getKillSwitchStatus, setKillSwitch };
