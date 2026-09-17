/**
 * Tests for lib/kill-switch.js three-state status reporting (R05).
 * A 0-row / NULL / non-boolean control-table read must surface UNKNOWN —
 * never "running" — so operators are not misled during a BQ outage.
 * Run: node --test lib/__tests__/kill-switch.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getKillSwitchStatus, setKillSwitch, _resetLatchForTests } = require('../kill-switch');

const HALTED_ROW = [{ trading_halted: true, reason: 'manual', updated_by: 'jun', updated_at: { value: '2026-09-13T00:00:00Z' } }];
const RUNNING_ROW = [{ trading_halted: false, reason: null, updated_by: 'jun', updated_at: { value: '2026-09-13T00:00:00Z' } }];

const rq = (rows) => async () => rows;

test('confirmed halted row -> halted=true, unknown=false', async () => {
  const s = await getKillSwitchStatus({ runQuery: rq(HALTED_ROW) });
  assert.equal(s.halted, true);
  assert.equal(s.unknown, false);
  assert.equal(s.reason, 'manual');
});

test('confirmed not-halted row -> halted=false, unknown=false', async () => {
  const s = await getKillSwitchStatus({ runQuery: rq(RUNNING_ROW) });
  assert.equal(s.halted, false);
  assert.equal(s.unknown, false);
});

test('0 rows -> unknown=true (not "running")', async () => {
  _resetLatchForTests();
  const s = await getKillSwitchStatus({ runQuery: rq([]) });
  assert.equal(s.halted, false);
  assert.equal(s.unknown, true);
});

test('NULL / non-boolean trading_halted -> unknown=true', async () => {
  _resetLatchForTests();
  for (const bad of [null, 'true', 1, 'false', 0]) {
    const s = await getKillSwitchStatus({ runQuery: rq([{ trading_halted: bad }]) });
    assert.equal(s.unknown, true, `trading_halted=${String(bad)} must be UNKNOWN`);
    assert.equal(s.halted, false);
  }
});

test('setKillSwitch writes through and returns confirmed state', async () => {
  const seen = [];
  const runQuery = async (q, p) => { seen.push(p); return RUNNING_ROW; };
  const s = await setKillSwitch(false, { updatedBy: 'test', runQuery });
  assert.equal(seen[0].halted, false);
  assert.equal(s.halted, false);
  assert.equal(s.unknown, false);
});

test('setKillSwitch: read-back failure never fails the write', async () => {
  let calls = 0;
  const runQuery = async () => { calls++; if (calls > 1) throw new Error('read-back failed'); return []; };
  const s = await setKillSwitch(true, { reason: 'panic', updatedBy: 'test', runQuery });
  assert.equal(s.halted, true);
  assert.equal(s.reason, 'panic');
});

test('rejected control query -> unknown=true, not a thrown error', async () => {
  _resetLatchForTests();
  const runQuery = async () => { throw new Error('403 IAM denied'); };
  const s = await getKillSwitchStatus({ runQuery });
  assert.equal(s.halted, false);
  assert.equal(s.unknown, true);
});

test('confirmed HALTED stays latched across read failures and empty reads', async () => {
  _resetLatchForTests();
  const halted = await getKillSwitchStatus({ runQuery: rq(HALTED_ROW) });
  assert.equal(halted.halted, true);
  // Later unreadable reads must not clear the latch.
  const afterError = await getKillSwitchStatus({
    runQuery: async () => { throw new Error('BQ outage'); }
  });
  assert.equal(afterError.halted, true);
  const afterEmpty = await getKillSwitchStatus({ runQuery: rq([]) });
  assert.equal(afterEmpty.halted, true);
});

test('confirmed RUNNING does not latch: later failure -> unknown', async () => {
  _resetLatchForTests();
  const running = await getKillSwitchStatus({ runQuery: rq(RUNNING_ROW) });
  assert.equal(running.halted, false);
  const s = await getKillSwitchStatus({
    runQuery: async () => { throw new Error('BQ outage'); }
  });
  assert.equal(s.halted, false);
  assert.equal(s.unknown, true);
  _resetLatchForTests();
});
