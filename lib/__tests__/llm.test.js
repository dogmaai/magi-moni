const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = 'test-only-not-a-real-key';
let toolImpl;
require('../tools').executeAka1Tool = (...args) => toolImpl(...args);
const { handleAka1Chat } = require('../llm');
const { context } = require('../operator-context');

beforeEach(() => {
  toolImpl = async () => { throw new Error('Unexpected tool call'); };
});

function mockGemini(t, candidates) {
  const requests = [];
  t.mock.method(global, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    for (const content of body.contents) {
      assert.ok(['user', 'model'].includes(content.role), `Unsupported role: ${content.role}`);
    }
    const candidate = candidates[requests.length - 1];
    assert.ok(candidate, 'Unexpected Gemini request');
    return { ok: true, json: async () => ({ candidates: [{ content: candidate }] }) };
  });
  return requests;
}

async function ask() {
  const replies = [];
  await context.run({ reply: async text => { replies.push(text); } },
    () => handleAka1Chat('test', 'AAPLの分析どうなってる？'));
  return replies;
}

for (const withId of [false, true]) {
  for (const fails of [false, true]) {
    test(`Gemini tool ${fails ? 'error' : 'result'} uses user role ${withId ? 'with' : 'without'} call ID`, async t => {
      const call = {
        name: 'get_symbol_analysis', args: { symbol: 'AAPL' },
        ...(withId ? { id: 'call-1' } : {}),
      };
      const modelTurn = {
        role: 'model',
        parts: [{ functionCall: call, thoughtSignature: 'test-signature' }],
      };
      const requests = mockGemini(t, [
        modelTurn, { role: 'model', parts: [{ text: '確認結果です。' }] },
      ]);
      toolImpl = async (name, args) => {
        assert.equal(name, call.name);
        assert.deepEqual(args, call.args);
        if (fails) throw new Error('BigQuery unavailable');
        return { status: 'ok', symbol: 'AAPL' };
      };

      assert.deepEqual(await ask(), ['確認結果です。']);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1].contents[1], modelTurn);
      assert.deepEqual(requests[1].contents[2], {
        role: 'user',
        parts: [{
          functionResponse: {
            name: call.name,
            ...(withId ? { id: call.id } : {}),
            response: fails
              ? { error: 'BigQuery unavailable' }
              : { result: { status: 'ok', symbol: 'AAPL' } },
          },
        }],
      });
    });
  }
}

test('Gemini groups parallel tool results in one user turn and preserves sequential history', async t => {
  const modelTurns = [
    { role: 'model', parts: [
      { functionCall: { name: 'get_symbol_analysis', id: 'aapl-1', args: { symbol: 'AAPL' } }, thoughtSignature: 'first' },
      { functionCall: { name: 'get_symbol_analysis', id: 'mu-1', args: { symbol: 'MU' } } },
    ] },
    { role: 'model', parts: [
      { functionCall: { name: 'get_symbol_analysis', id: 'aapl-2', args: { symbol: 'AAPL', days: 30 } }, thoughtSignature: 'second' },
    ] },
  ];
  const requests = mockGemini(t, [
    ...modelTurns, { role: 'model', parts: [{ text: '比較結果です。' }] },
  ]);
  const calls = [];
  toolImpl = async (name, args) => {
    calls.push({ name, args });
    if (args.symbol === 'MU') throw new Error('BigQuery unavailable');
    return { symbol: args.symbol };
  };

  assert.deepEqual(await ask(), ['比較結果です。']);
  assert.equal(calls.length, 3);
  assert.equal(requests.length, 3);
  const history = requests[2].contents;
  assert.deepEqual(history.map(turn => turn.role), ['user', 'model', 'user', 'model', 'user']);
  assert.deepEqual(history[1], modelTurns[0]);
  assert.deepEqual(history[3], modelTurns[1]);
  assert.deepEqual(history[2].parts.map(part => part.functionResponse), [
    { name: 'get_symbol_analysis', id: 'aapl-1', response: { result: { symbol: 'AAPL' } } },
    { name: 'get_symbol_analysis', id: 'mu-1', response: { error: 'BigQuery unavailable' } },
  ]);
  assert.equal(history[4].parts[0].functionResponse.id, 'aapl-2');
});

test('Gemini text-only response does not add a tool turn', async t => {
  const requests = mockGemini(t, [{ role: 'model', parts: [{ text: 'こんにちは。' }] }]);
  assert.deepEqual(await ask(), ['こんにちは。']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].contents.length, 1);
});
