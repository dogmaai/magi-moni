/**
 * @module lib/llm
 * AKA-1 LLM callers (Sakana AI / Claude / Gemini) with tool-calling loops,
 * and the main handleAka1Chat dispatcher.
 */
const { sendTelegramTo, sendTypingAction } = require('./telegram');
const { executeAka1Tool, AKA1_TOOLS, toGeminiFunctionDeclarations, toOpenAiFunctionTools } = require('./tools');
const {
  SAKANA_API_KEY, SAKANA_MODEL,
  ANTHROPIC_API_KEY, AKA1_MODEL, AKA1_MODEL_RAW,
  GEMINI_API_KEY, GEMINI_FALLBACK_MODEL,
  AKA1_MAX_TOOL_ITERATIONS,
} = require('./config');

let aka1LastResponseModel = null;
function getLastResponseModel() { return aka1LastResponseModel; }

// Shared system prompt core (DRY across all LLM providers)
const SYSTEM_PROMPT_CORE =
  '日本語で簡潔に応答してください。' +
  '取引・勝率・P&L・L4 プロベーション等のデータは必ず提供された tool を使って取得し、推測で答えないこと。' +
  'MAGI Constitution（憲法）は最上位ルールです。get_constitution ツールで取得できます。' +
  '憲法に関する質問には必ずツールで原文を取得してから回答してください。' +
  '勝率や金額には具体的な数値と件数 (n) を付記してください。' +
  'Telegram 宛のため、絵文字や箇条書きは控えめに、HTML タグは使わずプレーンテキストで返してください。' +
  '\n\nMooMooペーパー取引機能も利用可能です。moomoo_* ツールで口座残高・ポジション・気配値の確認、' +
  '成行注文の発注ができます。全て SIMULATE（デモ）環境のみで、本番取引は行われません。' +
  '発注時は必ずユーザーの指示を確認し、symbol / side / qty を明示してから実行してください。' +
  '\n\nシステム操作ツールも利用可能です:' +
  '\n- unblock_l4: L4プロベーション（自動ブロック）の手動解除' +
  '\n- trigger_job: Cloud Schedulerジョブの手動実行' +
  '\n- trigger_optuna: Optuna再最適化のトリガー' +
  '\nこれらは confirmed=true が必要です。初回は confirmed なしで呼び出してポリシーチェックを行い、' +
  'ユーザーに確認を取ってから confirmed=true で再実行してください。' +
  '\n\n思考ログ照会: query_thoughts ツールで PLM の推論ログを取得できます。';

async function callSakanaWithTools(userMessage) {
  if (!SAKANA_API_KEY) throw new Error('SAKANA_API_KEY が未設定です');

  const systemPrompt =
    `あなたは MAGI トレーディングシステムの監視 bot「AKA-1」です。モデル: Sakana AI ${SAKANA_MODEL}。` +
    SYSTEM_PROMPT_CORE;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];
  const tools = toOpenAiFunctionTools();

  for (let i = 0; i < AKA1_MAX_TOOL_ITERATIONS; i++) {
    const res = await fetch('https://api.sakana.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SAKANA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: SAKANA_MODEL,
        messages,
        max_tokens: 1024,
        tools,
        tool_choice: 'auto'
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      const errMsg = data.error?.message || `HTTP ${res.status}`;
      throw new Error(`Sakana API: ${errMsg}`);
    }

    const choice = data.choices?.[0];
    if (!choice?.message) return '（Sakana AI から応答がありませんでした）';

    if (data.model) {
      aka1LastResponseModel = data.model;
      console.log(`[AKA-1:SAKANA] API response model: ${data.model}`);
    }
    if (data.usage) {
      const u = data.usage;
      console.log(`[AKA-1:SAKANA] tokens: in=${u.prompt_tokens} out=${u.completion_tokens} total=${u.total_tokens}`);
    }

    messages.push(choice.message);

    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      return (choice.message.content || '').trim() || '（応答が空でした）';
    }

    for (const tc of choice.message.tool_calls) {
      const fnName = tc.function.name;
      let fnArgs;
      try { fnArgs = JSON.parse(tc.function.arguments); } catch { fnArgs = {}; }
      console.log(`[AKA-1:SAKANA] tool=${fnName} input=${JSON.stringify(fnArgs)}`);
      try {
        const result = await executeAka1Tool(fnName, fnArgs);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      } catch (e) {
        console.error(`[AKA-1:SAKANA] tool error: ${e.message}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${e.message}` });
      }
    }
  }
  return 'tool 呼び出し回数の上限に達しました。質問を簡素化してもう一度お試しください。';
}

async function callClaudeWithTools(userMessage) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が未設定です');

  const systemPromptText =
    `あなたは MAGI トレーディングシステムの監視 bot「AKA-1」です。モデル: ${AKA1_MODEL}。` +
    'あなたは Anthropic の Claude です。Gemini ではありません。モデル名を聞かれたら上記を正確に答えてください。' +
    SYSTEM_PROMPT_CORE;

  const systemPrompt = [
    { type: 'text', text: systemPromptText, cache_control: { type: 'ephemeral' } }
  ];

  const messages = [{ role: 'user', content: userMessage }];

  for (let i = 0; i < AKA1_MAX_TOOL_ITERATIONS; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: AKA1_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: AKA1_TOOLS,
        messages
      })
    });
    const data = await res.json();
    if (!res.ok || data.type === 'error') {
      const errMsg = data.error?.message || `HTTP ${res.status}`;
      const isModelErr = errMsg.toLowerCase().includes('model') || errMsg.toLowerCase().includes('not_found');
      const hint = isModelErr
        ? ` (AKA1_MODEL="${AKA1_MODEL_RAW}" → API に送信: "${AKA1_MODEL}")。モデル名を確認してください。`
        : '';
      throw new Error(`Anthropic API: ${errMsg}${hint}`);
    }

    if (data.model) {
      aka1LastResponseModel = data.model;
      console.log(`[AKA-1] API response model: ${data.model}`);
    }
    if (data.usage) {
      const u = data.usage;
      const cached = u.cache_read_input_tokens || 0;
      const created = u.cache_creation_input_tokens || 0;
      console.log(`[AKA-1] tokens: in=${u.input_tokens} out=${u.output_tokens} cache_read=${cached} cache_write=${created}`);
    }

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason !== 'tool_use') {
      const text = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return text || '（応答が空でした）';
    }

    const toolUses = data.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const tu of toolUses) {
      console.log(`[AKA-1] tool=${tu.name} input=${JSON.stringify(tu.input)}`);
      try {
        const result = await executeAka1Tool(tu.name, tu.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      } catch (e) {
        console.error(`[AKA-1] tool error: ${e.message}`);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return 'tool 呼び出し回数の上限に達しました。質問を簡素化してもう一度お試しください。';
}

async function callGeminiWithTools(userMessage) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');

  const systemPrompt =
    'あなたは MAGI トレーディングシステムの監視 bot 「AKA-1」(Gemini fallback) です。' +
    SYSTEM_PROMPT_CORE;

  const contents = [{ role: 'user', parts: [{ text: userMessage }] }];
  const tools = [{ functionDeclarations: toGeminiFunctionDeclarations() }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FALLBACK_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  for (let i = 0; i < AKA1_MAX_TOOL_ITERATIONS; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      const errMsg = data.error?.message || `HTTP ${res.status}`;
      throw new Error(`Gemini API: ${errMsg}`);
    }

    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) return '（Gemini から応答がありませんでした）';

    contents.push(candidate.content);

    const fnCalls = candidate.content.parts.filter(p => p.functionCall);
    if (fnCalls.length === 0) {
      const text = candidate.content.parts
        .filter(p => p.text)
        .map(p => p.text)
        .join('\n')
        .trim();
      return text || '（応答が空でした）';
    }

    const fnResponses = [];
    for (const part of fnCalls) {
      const { name, args } = part.functionCall;
      console.log(`[AKA-1:GEMINI] tool=${name} input=${JSON.stringify(args)}`);
      try {
        const result = await executeAka1Tool(name, args);
        fnResponses.push({ functionResponse: { name, response: { result } } });
      } catch (e) {
        console.error(`[AKA-1:GEMINI] tool error: ${e.message}`);
        fnResponses.push({ functionResponse: { name, response: { error: e.message } } });
      }
    }
    contents.push({ role: 'function', parts: fnResponses });
  }
  return 'tool 呼び出し回数の上限に達しました。質問を簡素化してもう一度お試しください。';
}

// Main dispatcher: Sakana → Claude → Gemini (non-sticky fallback)
async function handleAka1Chat(chatId, text) {
  await sendTypingAction(chatId);
  console.log(`[AKA-1] chat=${chatId} text="${text}"`);
  const errors = [];

  if (SAKANA_API_KEY) {
    try {
      const answer = await callSakanaWithTools(text);
      await sendTelegramTo(chatId, answer, { parseMode: 'Markdown' });
      return;
    } catch (e) {
      errors.push(`Sakana(${SAKANA_MODEL}): ${e.message}`);
      console.error(`[AKA-1] Sakana (${SAKANA_MODEL}) error, trying Claude fallback:`, e.message);
    }
  } else {
    console.log('[AKA-1] SAKANA_API_KEY not set, trying Claude fallback');
  }

  if (ANTHROPIC_API_KEY) {
    try {
      const answer = await callClaudeWithTools(text);
      await sendTelegramTo(chatId, answer, { parseMode: 'Markdown' });
      return;
    } catch (e) {
      errors.push(`Claude(${AKA1_MODEL}): ${e.message}`);
      console.error(`[AKA-1] Claude (${AKA1_MODEL}) error, trying Gemini fallback:`, e.message);
    }
  } else {
    console.log('[AKA-1] ANTHROPIC_API_KEY not set, trying Gemini fallback');
  }

  if (GEMINI_API_KEY) {
    try {
      const answer = await callGeminiWithTools(text);
      await sendTelegramTo(chatId, answer, { parseMode: 'Markdown' });
      return;
    } catch (e) {
      errors.push(`Gemini(${GEMINI_FALLBACK_MODEL}): ${e.message}`);
      console.error('[AKA-1] Gemini fallback also failed:', e.message);
    }
  }

  if (errors.length > 0) {
    await sendTelegramTo(chatId, `[AKA-1 エラー] 全 LLM 失敗:\n${errors.join('\n')}`);
  } else {
    await sendTelegramTo(chatId, '[AKA-1] LLM API キーが未設定です。SAKANA_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY のいずれかを設定してください。');
  }
}

module.exports = { handleAka1Chat, getLastResponseModel };
