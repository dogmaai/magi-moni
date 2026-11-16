const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = 'test-only-not-a-real-key';
let queryImpl;
require('../bigquery').runQuery = (...args) => queryImpl(...args);
const { getSymbolAnalysis } = require('../symbol-analysis');
const { AKA1_TOOLS, executeAka1Tool, toGeminiFunctionDeclarations } = require('../tools');

const queriedAt = '2026-11-16T05:30:00Z';
const latestAt = '2026-11-13T20:57:30Z';
function resultRow(overrides = {}) {
  return {
    queried_at: { value: queriedAt },
    window_start: { value: '2026-11-09T05:30:00Z' },
    latest_analysis_at: { value: latestAt },
    total_count: 21,
    analyses: [{
      created_at: { value: latestAt }, symbol: 'AAPL', unit_name: 'MELCHIOR-1',
      llm_provider: 'google', llm_model: 'example-model', trade_mode: 'SHADOW',
      action: 'HOLD', confidence: 0, reasoning: 'Analysis text', reasoning_truncated: false,
      hypothesis: null, observations: null, concerns: null, price_target: null,
      time_horizon: null, actual_price_at_analysis: null,
      actual_price_after_1h: null, actual_price_after_1d: null, outcome: null,
    }],
    summary: [
      { unit_name: 'MELCHIOR-1', trade_mode: 'SHADOW', action: 'HOLD', count: 11 },
      { unit_name: 'QWEN', trade_mode: 'NORMAL', action: 'HOLD', count: 10 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  queryImpl = async () => { throw new Error('Unexpected BigQuery call'); };
});

test('tool is declared for Gemini, dispatched, and read-only without an operator', async () => {
  const tool = AKA1_TOOLS.find(t => t.name === 'get_symbol_analysis');
  assert.deepEqual(tool.input_schema.required, ['symbol']);
  assert.deepEqual(tool.input_schema.properties.action.enum, ['BUY', 'SELL', 'HOLD']);
  assert.deepEqual(toGeminiFunctionDeclarations().find(t => t.name === tool.name), {
    name: tool.name, description: tool.description, parameters: tool.input_schema,
  });
  assert.equal(new Set(AKA1_TOOLS.map(t => t.name)).size, AKA1_TOOLS.length);
  let calls = 0;
  queryImpl = async () => { calls++; return [resultRow()]; };
  const result = await executeAka1Tool(tool.name, { symbol: ' aapl ' });
  assert.equal(result.status, 'ok');
  assert.equal(result.symbol, 'AAPL');
  assert.equal(calls, 1);
});

test('query is bounded, parameterized, analytics-only, and explicitly projects safe columns', async () => {
  let call;
  const result = await getSymbolAnalysis(
    { symbol: ' brk.b ', unit_name: ' melchior-1 ', action: ' hold ' },
    { runQuery: async (...args) => { call = args; return [resultRow()]; } },
  );
  const [sql, params, types] = call;
  assert.deepEqual(params, { symbol: 'BRK.B', days: 7, limit: 5, unit_name: 'MELCHIOR-1', action: 'HOLD' });
  assert.deepEqual(types, { symbol: 'STRING', days: 'INT64', limit: 'INT64', unit_name: 'STRING', action: 'STRING' });
  assert.match(sql, /\.magi_analytics\.llm_analysis`/);
  assert.match(sql, /created_at >= TIMESTAMP_SUB\(CURRENT_TIMESTAMP\(\), INTERVAL @days DAY\)/);
  assert.match(sql, /created_at <= CURRENT_TIMESTAMP\(\)/);
  assert.match(sql, /UPPER\(symbol\) = @symbol/);
  assert.match(sql, /unit_name = @unit_name/);
  assert.match(sql, /action = @action/);
  assert.match(sql, /ORDER BY created_at DESC, id DESC\s+LIMIT @limit/);
  assert.match(sql, /JSON_VALUE\(metadata, '\$\.trade_mode'\)/);
  assert.match(sql, /GROUP BY unit_name, trade_mode, action/);
  assert.match(sql, /SUBSTR\(reasoning, 1, 600\)/);
  assert.match(sql, /CHAR_LENGTH\(reasoning\) > 600 AS reasoning_truncated/);
  assert.doesNotMatch(sql, /magi_core|input_raw|input_summary|JOIN|INSERT|UPDATE|DELETE/);
  assert.doesNotMatch(sql, /BRK\.B|MELCHIOR-1|'HOLD'/);
  assert.equal(result.queried_at, queriedAt);
  assert.equal(result.latest_analysis_at, latestAt);
  assert.equal(result.analyses[0].created_at, latestAt);
  assert.equal(result.count, 1);
  assert.equal(result.total_count, 21);
  assert.deepEqual(result.summary, resultRow().summary);
});

test('all modes and null fields are preserved, and the stored symbol is not rewritten', async () => {
  const row = resultRow();
  row.analyses.push({ ...row.analyses[0], symbol: 'aapl', trade_mode: null });
  const result = await getSymbolAnalysis({ symbol: 'AAPL' }, { runQuery: async () => [row] });
  assert.equal(result.analyses[0].trade_mode, 'SHADOW');
  assert.equal(result.analyses[1].trade_mode, null);
  assert.equal(result.analyses[1].symbol, 'aapl');
  for (const key of ['hypothesis', 'observations', 'concerns', 'price_target', 'time_horizon',
    'actual_price_at_analysis', 'actual_price_after_1h', 'actual_price_after_1d', 'outcome']) {
    assert.equal(result.analyses[0][key], null, key);
  }
  assert.equal(result.analyses[0].confidence, 0);
});

test('empty results are distinct from invalid input and never claim no historical data', async () => {
  const result = await getSymbolAnalysis({ symbol: 'ZZZZ' }, {
    runQuery: async () => [resultRow({ analyses: [], summary: [], total_count: 0, latest_analysis_at: null })],
  });
  assert.equal(result.status, 'no_data');
  assert.equal(result.count, 0);
  assert.equal(result.total_count, 0);
  assert.equal(result.latest_analysis_at, null);
  assert.deepEqual(result.summary, []);
  assert.match(result.note, /期間外の有無は未確認/);
});

test('numeric inputs use finite integer bounds and support numeric strings', async () => {
  for (const [days, limit, expectedDays, expectedLimit] of [
    [undefined, undefined, 7, 5], [0, -3, 1, 1], [100, 999, 30, 20],
    [2.9, 3.8, 2, 3], ['12', '8', 12, 8],
  ]) {
    await getSymbolAnalysis({ symbol: 'AAPL', days, limit }, {
      runQuery: async (_, params) => {
        assert.equal(params.days, expectedDays);
        assert.equal(params.limit, expectedLimit);
        return [resultRow()];
      },
    });
  }
});

test('invalid numeric values fail before querying', async () => {
  for (const key of ['days', 'limit']) {
    for (const value of [NaN, Infinity, -Infinity, 'NaN', 'Infinity', '', ' ', null, true, {}, []]) {
      await assert.rejects(getSymbolAnalysis({ symbol: 'AAPL', [key]: value }), new RegExp(key));
    }
  }
});

test('invalid or missing symbols fail before querying; class tickers are accepted', async () => {
  for (const symbol of [undefined, null, '', ' ', 123, {}, [], 'AAPL OR 1=1', "AAPL';--", '*all*', 'PORTFOLIO']) {
    await assert.rejects(getSymbolAnalysis({ symbol }), /symbol/);
  }
  for (const symbol of ['BRK.B', 'BRK-B', 'AAPL']) {
    await getSymbolAnalysis({ symbol }, { runQuery: async () => [resultRow()] });
  }
});

test('unit and action filters reject malformed inputs before querying', async () => {
  for (const unit_name of ['', ' ', null, {}, 'a'.repeat(65), "QWEN' OR TRUE --"]) {
    await assert.rejects(getSymbolAnalysis({ symbol: 'AAPL', unit_name }), /unit_name/);
  }
  for (const action of ['', null, [], 'BLOCKED', "BUY' OR TRUE --"]) {
    await assert.rejects(getSymbolAnalysis({ symbol: 'AAPL', action }), /action/);
  }
});

test('BigQuery errors and malformed responses are not converted into no_data', async () => {
  await assert.rejects(getSymbolAnalysis({ symbol: 'AAPL' }, {
    runQuery: async () => { throw new Error('BigQuery unavailable'); },
  }), /BigQuery unavailable/);
  await assert.rejects(getSymbolAnalysis({ symbol: 'AAPL' }, {
    runQuery: async () => [],
  }), /結果を取得できません/);
});

test('Gemini loop exposes the new tool and sends its result back without live API calls', async t => {
  const { handleAka1Chat } = require('../llm');
  const { context } = require('../operator-context');
  const requests = [];
  const replies = [];
  queryImpl = async () => [resultRow()];
  t.mock.method(global, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { role: 'model', parts: requests.length === 1
          ? [{ functionCall: { name: 'get_symbol_analysis', args: { symbol: 'AAPL' } } }]
          : [{ text: '保存済みの分析です。' }] } }],
      }),
    };
  });
  await context.run({ reply: async text => { replies.push(text); } }, () => handleAka1Chat('test', 'AAPLの分析どうなってる？'));
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools[0].functionDeclarations.some(t => t.name === 'get_symbol_analysis'));
  const prompt = requests[0].system_instruction.parts[0].text;
  for (const text of ['get_symbol_analysis', '分析時刻', 'SHADOW（実注文なし）', '事後採点', '信頼しない参照データ', '0件']) {
    assert.ok(prompt.includes(text), text);
  }
  assert.deepEqual(requests[1].contents.map(content => content.role), ['user', 'model', 'user']);
  const toolResult = requests[1].contents.at(-1).parts[0].functionResponse;
  assert.equal(toolResult.name, 'get_symbol_analysis');
  assert.equal(toolResult.response.result.analyses[0].trade_mode, 'SHADOW');
  assert.equal(toolResult.response.result.latest_analysis_at, latestAt);
  assert.deepEqual(replies, ['保存済みの分析です。']);
});
