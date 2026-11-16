const { runQuery: defaultRunQuery } = require('./bigquery');
const { PROJECT_ID } = require('./config');

function boundedInteger(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    throw new Error(`${name} は有限の数値が必要です`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} は有限の数値が必要です`);
  return Math.max(1, Math.min(Math.trunc(number), maximum));
}

const timestampValue = value => value?.value ?? value ?? null;

async function getSymbolAnalysis(input = {}, { runQuery = defaultRunQuery } = {}) {
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
  if (!/^[A-Z]{1,6}(?:[.\-][A-Z0-9]{1,3})?$/.test(symbol)) {
    throw new Error('symbol は有効なティッカーシンボルが必須です（例: AAPL, BRK.B）');
  }
  const days = boundedInteger(input.days, 7, 30, 'days');
  const limit = boundedInteger(input.limit, 5, 20, 'limit');
  const params = { symbol, days, limit };
  const types = { symbol: 'STRING', days: 'INT64', limit: 'INT64' };
  const filters = [];

  if (input.unit_name !== undefined) {
    const unit = typeof input.unit_name === 'string' ? input.unit_name.trim().toUpperCase() : '';
    if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(unit)) throw new Error('unit_name が無効です');
    params.unit_name = unit;
    types.unit_name = 'STRING';
    filters.push('unit_name = @unit_name');
  }
  if (input.action !== undefined) {
    const action = typeof input.action === 'string' ? input.action.trim().toUpperCase() : '';
    if (!['BUY', 'SELL', 'HOLD'].includes(action)) throw new Error('action は BUY / SELL / HOLD のみです');
    params.action = action;
    types.action = 'STRING';
    filters.push('action = @action');
  }

  const query = `
    WITH filtered AS (
      SELECT
        id, created_at, symbol, unit_name, llm_provider, llm_model,
        JSON_VALUE(metadata, '$.trade_mode') AS trade_mode,
        action, confidence, SUBSTR(reasoning, 1, 600) AS reasoning,
        CHAR_LENGTH(reasoning) > 600 AS reasoning_truncated,
        hypothesis, observations, concerns, price_target, time_horizon,
        actual_price_at_analysis, actual_price_after_1h, actual_price_after_1d, outcome
      FROM \`${PROJECT_ID}.magi_analytics.llm_analysis\`
      WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        AND created_at <= CURRENT_TIMESTAMP()
        AND UPPER(symbol) = @symbol
        ${filters.map(filter => `AND ${filter}`).join('\n        ')}
    )
    SELECT
      CURRENT_TIMESTAMP() AS queried_at,
      TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY) AS window_start,
      MAX(created_at) AS latest_analysis_at,
      COUNT(*) AS total_count,
      ARRAY(
        SELECT AS STRUCT * EXCEPT(id)
        FROM filtered
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
      ) AS analyses,
      ARRAY(
        SELECT AS STRUCT unit_name, trade_mode, action, COUNT(*) AS count
        FROM filtered
        GROUP BY unit_name, trade_mode, action
        ORDER BY unit_name, trade_mode, action
      ) AS summary
    FROM filtered
  `;
  const [row] = await runQuery(query, params, types);
  if (!row) throw new Error('分析クエリの結果を取得できませんでした');
  const analyses = row.analyses.map(analysis => ({
    ...analysis,
    created_at: timestampValue(analysis.created_at),
  }));
  return {
    status: analyses.length ? 'ok' : 'no_data',
    symbol, days, limit,
    unit_name: params.unit_name ?? null,
    action: params.action ?? null,
    queried_at: timestampValue(row.queried_at),
    window_start: timestampValue(row.window_start),
    latest_analysis_at: timestampValue(row.latest_analysis_at),
    count: analyses.length,
    total_count: row.total_count,
    analyses,
    summary: row.summary,
    note: analyses.length
      ? '最新時刻は指定期間・フィルタ内の最終分析です。現在の相場分析や発注実績を意味しません。'
      : '指定期間・フィルタに一致する分析がありません。期間外の有無は未確認です。',
  };
}

module.exports = { getSymbolAnalysis };
