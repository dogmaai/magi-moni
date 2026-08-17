/**
 * @module lib/llm
 * AKA-1 LLM callers (Sakana AI / Ollama / Gemini) with tool-calling loops,
 * and the main handleAka1Chat dispatcher.
 */
const { sendTelegramTo, sendTelegramPhotoTo, sendTypingAction } = require('./telegram');
const { executeAka1Tool, AKA1_TOOLS, toGeminiFunctionDeclarations, toOpenAiFunctionTools, toSakanaResponsesTools } = require('./tools');
const { getLastScreenshot, clearLastScreenshot } = require('./tiala');
const {
  SAKANA_API_KEY, SAKANA_MODEL, SAKANA_RESPONSES_MODEL,
  OLLAMA_BASE_URL, OLLAMA_MODEL,
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
  '\n\n思考ログ照会: query_thoughts ツールで PLM の推論ログを取得できます。' +
  '\n\nHERMES監視銘柄の管理ツール:' +
  '\n- list_focus_symbols: 手動追加銘柄とISABEL自動選定銘柄の一覧（確認不要）' +
  '\n- add_focus_symbol: 個別株を監視銘柄に追加（confirmed=true 必要）' +
  '\n- remove_focus_symbol: 手動追加銘柄の監視解除（confirmed=true 必要）' +
  '\n手動追加した銘柄はHERMESがニュース・センチメントを収集する対象に加わり、解除するまで永続します。' +
  '\n\nTIALA操作ツール（Mac mini リモート管理、OpenClaw Gateway 経由）:' +
  '\n- tiala_services: TIALA上の全サービス（Ollama, OpenD, moomoo-bridge等）の稼働状態を確認' +
  '\n- tiala_restart: サービス再起動（confirmed=true 必要）' +
  '\n- tiala_exec: 許可コマンド実行（git, ollama, brew, ls, ps 等。confirmed=true 必要）' +
  '\n- tiala_system: CPU/メモリ/ディスク情報' +
  '\n- tiala_screenshot: TIALAの画面をスクリーンショットで取得' +
  '\n- tiala_action: TIALAの画面を操作（クリック・入力・キー・スクロール等、confirmed=true 必要）' +
  '\n- openclaw_agent: OpenClaw エージェント（Sonnet 5）に自然言語で指示。OpenClaw Gateway 上で exec/browser ツールを使ってタスクを実行' +
  '\ntiala_services, tiala_system, tiala_screenshot は確認不要で即時実行可能。' +
  '\ntiala_restart, tiala_exec, tiala_action, openclaw_agent は confirmed=true が必要（初回は確認なしでポリシーチェック→ユーザー確認→再実行）。';

async function callSakanaWithTools(userMessage, { chatId } = {}) {
  if (!SAKANA_API_KEY) throw new Error('SAKANA_API_KEY が未設定です');

  const systemPrompt =
    `あなたは MAGI トレーディングシステムの監視 bot「AKA-1」です。モデル: Sakana AI ${SAKANA_MODEL}。` +
    SYSTEM_PROMPT_CORE;

  // Sakana Responses API uses an array of input items rather than chat-style messages.
  const inputItems = [{ role: 'user', content: [{ type: 'input_text', text: userMessage }] }];
  const tools = toSakanaResponsesTools();
  const responsesModel = SAKANA_RESPONSES_MODEL;

  for (let i = 0; i < AKA1_MAX_TOOL_ITERATIONS; i++) {
    const res = await fetch('https://api.sakana.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SAKANA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: responsesModel,
        input: inputItems,
        instructions: systemPrompt,
        max_output_tokens: 1024,
        tools,
        tool_choice: 'auto',
        metadata: { bot: 'aka1', chat_id: chatId || null }
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      const errMsg = data.error?.message || `HTTP ${res.status}`;
      throw new Error(`Sakana API: ${errMsg}`);
    }

    if (data.model) {
      aka1LastResponseModel = data.model;
      console.log(`[AKA-1:SAKANA] API response model: ${data.model}`);
    }
    if (data.usage) {
      const u = data.usage;
      console.log(`[AKA-1:SAKANA] tokens: in=${u.input_tokens || u.prompt_tokens || 0} out=${u.output_tokens || u.completion_tokens || 0} total=${u.total_tokens || 0}`);
    }

    const output = Array.isArray(data.output) ? data.output : [];
    if (output.length === 0) return '（Sakana AI から応答がありませんでした）';

    // Append assistant output items to the conversation, preserving only the
    // fields the Sakana Responses API accepts as input. Drop reasoning
    // encrypted_content to avoid validation errors.
    for (const item of output) {
      if (item.type === 'message') {
        inputItems.push({ type: 'message', id: item.id, role: item.role, status: item.status, content: item.content });
      } else if (item.type === 'function_call') {
        inputItems.push({ type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, status: item.status, arguments: item.arguments });
      } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        inputItems.push({ type: 'reasoning', id: item.id, summary: item.summary });
      }
    }

    const functionCalls = output.filter(item => item.type === 'function_call');
    if (functionCalls.length === 0) {
      const textParts = output
        .filter(item => item.type === 'message' && Array.isArray(item.content))
        .flatMap(item => item.content.filter(c => c.type === 'output_text').map(c => c.text));
      return textParts.join('\n').trim() || '（応答が空でした）';
    }

    const toolOutputs = await Promise.all(functionCalls.map(async (fc) => {
      const fnName = fc.name;
      let fnArgs;
      try { fnArgs = JSON.parse(fc.arguments || '{}'); } catch { fnArgs = {}; }
      console.log(`[AKA-1:SAKANA] tool=${fnName} input=${JSON.stringify(fnArgs)}`);
      try {
        const result = await executeAka1Tool(fnName, fnArgs);
        return { call_id: fc.call_id, output: JSON.stringify(result) };
      } catch (e) {
        console.error(`[AKA-1:SAKANA] tool error: ${e.message}`);
        return { call_id: fc.call_id, output: JSON.stringify({ error: e.message }) };
      }
    }));

    for (const to of toolOutputs) {
      inputItems.push({ type: 'function_call_output', call_id: to.call_id, output: to.output });
    }
  }
  return 'tool 呼び出し回数の上限に達しました。質問を簡素化してもう一度お試しください。';
}

async function callOllamaWithTools(userMessage) {
  if (!OLLAMA_BASE_URL) throw new Error('OLLAMA_BASE_URL が未設定です');

  const endpoint = `${OLLAMA_BASE_URL}/v1/chat/completions`;
  const systemPrompt =
    `あなたは MAGI トレーディングシステムの監視 bot「AKA-1」です。モデル: ${OLLAMA_MODEL} (TIALA local)。` +
    SYSTEM_PROMPT_CORE;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];
  const tools = toOpenAiFunctionTools();

  for (let i = 0; i < AKA1_MAX_TOOL_ITERATIONS; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.1,
          max_tokens: 1024
        })
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Ollama API: HTTP ${res.status} ${errBody}`);
    }

    const data = await res.json();
    aka1LastResponseModel = data.model || OLLAMA_MODEL;
    console.log(`[AKA-1:OLLAMA] response model: ${aka1LastResponseModel}`);
    if (data.usage) {
      console.log(`[AKA-1:OLLAMA] tokens: in=${data.usage.prompt_tokens || 0} out=${data.usage.completion_tokens || 0}`);
    }

    const message = data.choices?.[0]?.message;
    if (!message) return '（Ollama から応答がありませんでした）';

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return (message.content || '').trim() || '（応答が空でした）';
    }

    messages.push(message);
    for (const tc of message.tool_calls) {
      const fnName = tc.function.name;
      const tcId = tc.id || `call_${fnName}_${i}`;
      let fnArgs = tc.function.arguments;
      if (typeof fnArgs === 'string') {
        try { fnArgs = JSON.parse(fnArgs); } catch (_) { fnArgs = {}; }
      }
      console.log(`[AKA-1:OLLAMA] tool=${fnName} input=${JSON.stringify(fnArgs)}`);
      try {
        const result = await executeAka1Tool(fnName, fnArgs);
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: JSON.stringify(result)
        });
      } catch (e) {
        console.error(`[AKA-1:OLLAMA] tool error: ${e.message}`);
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: `Error: ${e.message}`
        });
      }
    }
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

async function sendAnswerWithPhoto(chatId, answer, chatStartMs) {
  await sendTelegramTo(chatId, answer, { parseMode: 'Markdown' });

  const shot = getLastScreenshot();
  if (shot && shot.capturedAt >= chatStartMs) {
    await sendTelegramPhotoTo(chatId, shot.base64, 'TIALA screenshot');
    clearLastScreenshot();
  }
}

// Main dispatcher: Sakana → Ollama (TIALA) → Gemini (non-sticky fallback)
async function handleAka1Chat(chatId, text) {
  await sendTypingAction(chatId);
  console.log(`[AKA-1] chat=${chatId} text="${text}"`);
  const errors = [];
  const chatStartMs = Date.now();
  clearLastScreenshot();

  if (SAKANA_API_KEY) {
    try {
      const answer = await callSakanaWithTools(text, { chatId });
      await sendAnswerWithPhoto(chatId, answer, chatStartMs);
      return;
    } catch (e) {
      errors.push(`Sakana(${SAKANA_MODEL}): ${e.message}`);
      console.error(`[AKA-1] Sakana (${SAKANA_MODEL}) error, trying Ollama fallback:`, e.message);
    }
  } else {
    console.log('[AKA-1] SAKANA_API_KEY not set, trying Ollama fallback');
  }

  if (OLLAMA_BASE_URL) {
    try {
      const answer = await callOllamaWithTools(text);
      await sendAnswerWithPhoto(chatId, answer, chatStartMs);
      return;
    } catch (e) {
      errors.push(`Ollama(${OLLAMA_MODEL}): ${e.message}`);
      console.error(`[AKA-1] Ollama (${OLLAMA_MODEL}) error, trying Gemini fallback:`, e.message);
    }
  } else {
    console.log('[AKA-1] OLLAMA_BASE_URL not set, skipping Ollama');
  }

  if (GEMINI_API_KEY) {
    try {
      const answer = await callGeminiWithTools(text);
      await sendAnswerWithPhoto(chatId, answer, chatStartMs);
      return;
    } catch (e) {
      errors.push(`Gemini(${GEMINI_FALLBACK_MODEL}): ${e.message}`);
      console.error('[AKA-1] Gemini fallback also failed:', e.message);
    }
  }

  if (errors.length > 0) {
    await sendTelegramTo(chatId, `[AKA-1 エラー] 全 LLM 失敗:\n${errors.join('\n')}`);
  } else {
    await sendTelegramTo(chatId, '[AKA-1] LLM API キーが未設定です。SAKANA_API_KEY / OLLAMA_BASE_URL / GEMINI_API_KEY のいずれかを設定してください。');
  }
}

module.exports = { handleAka1Chat, getLastResponseModel };
