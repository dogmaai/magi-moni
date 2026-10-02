/**
 * @module lib/llm
 * AKA-1 LLM caller (Gemini) with tool-calling loop,
 * and the main handleAka1Chat dispatcher.
 */
const { sendTelegramTo, sendTelegramPhotoTo, sendTypingAction } = require('./telegram');
const { executeAka1Tool, AKA1_TOOLS, toGeminiFunctionDeclarations } = require('./tools');
const { getLastScreenshot, clearLastScreenshot } = require('./tiala');
const {
  GEMINI_API_KEY, GEMINI_MODEL,
  AKA1_MAX_TOOL_ITERATIONS,
} = require('./config');

let aka1LastResponseModel = null;
function getLastResponseModel() { return aka1LastResponseModel; }

// Shared system prompt core (DRY across all LLM providers)
const SYSTEM_PROMPT_CORE =
  '日本語で簡潔に応答してください。' +
  '\n\n【ハルシネーション禁止】数値・状態・結果はツールで取得した事実のみを述べること。' +
  'ツールが失敗した / データが無い / 確認できない場合は、推測や創作をせず「取得できませんでした」と失敗内容を明示すること。' +
  '成功していない操作を成功したかのように報告しない。憶測は「推測ですが」と明示する。' +
  '取引・勝率・P&L・L4 警告等のデータは必ず提供された tool を使って取得し、推測で答えないこと。' +
  '\n\nL4（方向適性層）は warn-only です。LLM が L4 でブロック・プロベーションされる仕組みは現在存在せず、' +
  'get_l4_status が返すのは警告履歴です。「L4ブロック中」「解除が必要」とは述べないこと。' +
  'MAGI Constitution（憲法）は最上位ルールです。get_constitution ツールで取得できます。' +
  '憲法に関する質問には必ずツールで原文を取得してから回答してください。' +
  '勝率や金額には具体的な数値と件数 (n) を付記してください。' +
  'Telegram 宛のため、絵文字や箇条書きは控えめに、HTML タグは使わずプレーンテキストで返してください。' +
  '\n\nMooMooペーパー取引機能も利用可能です。moomoo_* ツールで口座残高・ポジション・気配値の確認、' +
  '成行注文の発注ができます。全て SIMULATE（デモ）環境のみで、本番取引は行われません。' +
  '発注時は必ずユーザーの指示を確認し、symbol / side / qty を明示してから実行してください。' +
  '\n\nシステム操作ツールも利用可能です:' +
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
  '\n\n緊急キルスイッチ（全注文ブロック）:' +
  '\n- emergency_kill: 緊急停止。magi-core の全注文（新規・決済とも）を即時ブロック。緊急性が高いため確認不要で即時実行（reason に理由を渡す）' +
  '\n- resume_trading: キルスイッチ解除・取引再開（confirmed=true 必要）' +
  '\n- get_kill_status: 現在の停止状態の確認（確認不要）' +
  '\nユーザーが「緊急停止」「全部止めて」「キルスイッチ」等と指示したら emergency_kill を即座に実行してください。' +
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

async function callGeminiWithTools(userMessage) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');

  const systemPrompt =
    `あなたは MAGI トレーディングシステムの監視 bot「AKA-1」です。モデル: ${GEMINI_MODEL}。` +
    SYSTEM_PROMPT_CORE;

  const contents = [{ role: 'user', parts: [{ text: userMessage }] }];
  const tools = [{ functionDeclarations: toGeminiFunctionDeclarations() }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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

    aka1LastResponseModel = data.modelVersion || GEMINI_MODEL;
    if (data.usageMetadata) {
      const u = data.usageMetadata;
      console.log(`[AKA-1:GEMINI] tokens: in=${u.promptTokenCount || 0} out=${u.candidatesTokenCount || 0} total=${u.totalTokenCount || 0}`);
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

async function sendAnswerWithPhoto(chatId, answer, chatStartMs, notice) {
  // The notice goes out separately without a parse mode so provider error text
  // cannot break Markdown parsing and drop the whole message.
  if (notice) await sendTelegramTo(chatId, notice, { parseMode: '' });
  await sendTelegramTo(chatId, answer, { parseMode: 'Markdown' });

  const shot = getLastScreenshot();
  if (shot && shot.capturedAt >= chatStartMs) {
    await sendTelegramPhotoTo(chatId, shot.base64, 'TIALA screenshot');
    clearLastScreenshot();
  }
}

// Main dispatcher: Gemini is the sole provider (Sakana AI retired, Ollama path removed)
async function handleAka1Chat(chatId, text) {
  await sendTypingAction(chatId);
  console.log(`[AKA-1] chat=${chatId} text="${text}"`);
  const chatStartMs = Date.now();
  clearLastScreenshot();

  if (!GEMINI_API_KEY) {
    await sendTelegramTo(chatId, '[AKA-1] LLM API キーが未設定です。GEMINI_API_KEY を設定してください。');
    return;
  }

  try {
    const answer = await callGeminiWithTools(text);
    await sendAnswerWithPhoto(chatId, answer, chatStartMs);
  } catch (e) {
    console.error(`[AKA-1] Gemini (${GEMINI_MODEL}) error:`, e.message);
    await sendTelegramTo(chatId, `[AKA-1 エラー] Gemini(${GEMINI_MODEL}): ${e.message}`);
  }
}

module.exports = { handleAka1Chat, getLastResponseModel };
