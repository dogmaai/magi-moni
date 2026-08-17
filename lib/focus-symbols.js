/**
 * @module lib/focus-symbols
 * HERMES manual focus-symbol management (magi_core.manual_focus_symbols).
 *
 * Symbols added here are unioned with the ISABEL daily focus list by
 * magi-core src/hermes.js getHermesCollectionSymbols(), so HERMES collects
 * news/sentiment for them on every run until they are deactivated.
 * All writes use DML (MERGE / UPDATE) so deactivation takes effect
 * immediately (no streaming-buffer restrictions).
 */
const { runQuery } = require('./bigquery');
const { PROJECT_ID, nyDateString } = require('./config');

const MANUAL_TABLE = `\`${PROJECT_ID}.magi_core.manual_focus_symbols\``;
const FOCUS_TABLE = `\`${PROJECT_ID}.magi_core.focus_symbols\``;
const SYMBOL_PATTERN = /^[A-Z]{1,6}(?:[.\-][A-Z0-9]{1,3})?$/;
const MAX_MANUAL_SYMBOLS = 30;

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function isValidSymbol(symbol) {
  return SYMBOL_PATTERN.test(normalizeSymbol(symbol));
}

async function countActiveManualSymbols() {
  const rows = await runQuery(
    `SELECT COUNT(*) AS cnt FROM ${MANUAL_TABLE} WHERE active`
  );
  return Number(rows[0]?.cnt || 0);
}

async function addFocusSymbol(symbol, { addedBy = 'AKA-1 Telegram', note = null } = {}) {
  const sym = normalizeSymbol(symbol);
  if (!isValidSymbol(sym)) {
    throw new Error(`無効なティッカーシンボルです: ${symbol}`);
  }
  const active = await countActiveManualSymbols();
  if (active >= MAX_MANUAL_SYMBOLS) {
    throw new Error(`手動監視銘柄が上限（${MAX_MANUAL_SYMBOLS}件）に達しています。先に削除してください。`);
  }
  await runQuery(
    `MERGE ${MANUAL_TABLE} T
     USING (SELECT @symbol AS symbol) S
     ON T.symbol = S.symbol
     WHEN MATCHED THEN UPDATE SET
       active = TRUE,
       added_by = @added_by,
       note = @note,
       updated_at = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (symbol, active, added_by, note, added_at, updated_at)
       VALUES (@symbol, TRUE, @added_by, @note, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
    { symbol: sym, added_by: addedBy, note },
    { note: 'STRING' }
  );
  return { symbol: sym, active_count: active + 1 };
}

async function removeFocusSymbol(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!isValidSymbol(sym)) {
    throw new Error(`無効なティッカーシンボルです: ${symbol}`);
  }
  const rows = await runQuery(
    `SELECT COUNT(*) AS cnt FROM ${MANUAL_TABLE} WHERE symbol = @symbol AND active`,
    { symbol: sym }
  );
  const existed = Number(rows?.[0]?.cnt || 0) > 0;
  if (existed) {
    await runQuery(
      `UPDATE ${MANUAL_TABLE}
       SET active = FALSE, updated_at = CURRENT_TIMESTAMP()
       WHERE symbol = @symbol AND active`,
      { symbol: sym }
    );
  }
  return { symbol: sym, removed: existed };
}

async function listFocusSymbols() {
  const [manual, isabel] = await Promise.all([
    runQuery(
      `SELECT symbol, added_by, note, added_at
       FROM ${MANUAL_TABLE}
       WHERE active
       ORDER BY added_at ASC`
    ),
    runQuery(
      `SELECT symbol, win_rate, rank
       FROM ${FOCUS_TABLE}
       WHERE date = @today
       ORDER BY rank ASC`,
      { today: nyDateString() }
    ).catch(() => []),
  ]);
  return { manual, isabel };
}

module.exports = {
  MAX_MANUAL_SYMBOLS,
  normalizeSymbol,
  isValidSymbol,
  addFocusSymbol,
  removeFocusSymbol,
  listFocusSymbols,
};
