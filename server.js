const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const https = require('https');
const crypto = require('crypto');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID || 'screen-share-459802';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AKA1_MODEL = process.env.AKA1_MODEL || 'claude-fable-5';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
const AKA1_MAX_TOOL_ITERATIONS = 5;

// Telegram webhook secret: derived from bot token to prevent spoofed webhook calls
const WEBHOOK_SECRET = TELEGRAM_BOT_TOKEN
  ? crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest('hex').slice(0, 32)
  : null;

// OIDC token verifier for internal endpoints (Cloud Scheduler, Pub/Sub)
const oidcClient = new OAuth2Client();
const SERVICE_URL = process.env.K_SERVICE
  ? `https://${process.env.K_SERVICE}-398890937507.asia-northeast1.run.app`
  : null;

async function verifyInternalRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  if (!SERVICE_URL) return true; // skip verification in local dev
  try {
    const token = authHeader.split(' ')[1];
    const ticket = await oidcClient.verifyIdToken({ idToken: token, audience: SERVICE_URL });
    return !!ticket;
  } catch {
    return false;
  }
}

app.use(express.json());

const bq = new BigQuery({ projectId: PROJECT_ID });

// ===== magi-moomoo Cloud Run proxy =====
let _moomooIdTokenClient = null;

async function getMoomooUrl() {
  const [rows] = await bq.query({
    query: `SELECT url FROM \`${PROJECT_ID}.magi_core.service_endpoints\`
            WHERE service = 'magi-moomoo'
            ORDER BY updated_at DESC LIMIT 1`,
    location: 'US'
  });
  if (!rows || rows.length === 0) throw new Error('magi-moomoo URL not found in service_endpoints');
  return rows[0].url;
}

async function getMoomooIdToken(targetUrl) {
  if (!_moomooIdTokenClient) {
    const auth = new GoogleAuth();
    _moomooIdTokenClient = await auth.getIdTokenClient(targetUrl);
  }
  const headers = await _moomooIdTokenClient.getRequestHeaders();
  return typeof headers.get === 'function'
    ? headers.get('Authorization')
    : headers.Authorization;
}

async function callMoomoo(path, options = {}) {
  const baseUrl = await getMoomooUrl();
  const authHeader = await getMoomooIdToken(baseUrl);
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, 'Authorization': authHeader },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`moomoo HTTP ${res.status}: ${errBody}`);
  }
  return res.json();
}

// 取引結果の履歴を保存（既存機能）
const tradeResults = [];

// LLM API 死活 state。外部ポーラーから setLlmHealth() 等で更新される想定（未実装なら空のまま）。
// /status コマンドが Object.entries() でそのまま読めるようプレーンオブジェクトとして定義。
const llmHealthState = {};

// Cloud Run Jobs 状態 state。同上。/jobs コマンドが空のとき「取得中...」と表示するフォールバックを持つ。
const jobsState = {};

// AKA-1 が最後に使用した実モデル名（Anthropic API レスポンスの model フィールド）
let aka1LastResponseModel = null;

// ===== Telegram送信ヘルパー =====
async function sendTelegramTo(chatId, message, { parseMode = 'HTML' } = {}) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.log('[MONI] Telegram not configured, skipping');
    return;
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: parseMode
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        console.log(`[MONI] Telegram sent to ${chatId} (status ${res.statusCode})`);
        resolve();
      });
    });
    req.on('error', (e) => {
      console.error('[MONI] Telegram error:', e.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

async function sendTelegram(message) {
  return sendTelegramTo(TELEGRAM_CHAT_ID, message);
}

async function sendTypingAction(chatId) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (_) { /* ignore typing failures */ }
}

// ===== AKA-1 (Claude Fable) - 自然言語 Telegram チャット =====
//
// 仕様参照: dogmaai/magi-stg/MEMORY.md, specifications/system/overview.md
// 役割: Telegram で自然文を受け、tool calling で BigQuery を直接照会して応答する。
//       slash コマンド (/status, /wr, /jobs, /today, /help) は従来通り別経路で処理。
// 認可: TELEGRAM_CHAT_ID と一致する chat からのメッセージのみ受け付ける。
// ツール: 読み取り専用の事前定義クエリのみ公開する（任意 SQL は意図的に未公開）。

const AKA1_TOOLS = [
  {
    name: 'get_today_trades',
    description:
      '本日 (America/New_York) の取引一覧を取得する。symbol / side / llm_provider / result / pnl_amount / timestamp を返す。',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '取得する最大件数 (1-100, default 20)'
        }
      }
    }
  },
  {
    name: 'get_winrate_by_llm',
    description:
      '指定期間の LLM × 方向別の勝率を返す。各行: llm_provider / side / trades / wins / losses / win_rate。',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: '過去何日間を集計するか (1-90, default 30)'
        }
      }
    }
  },
  {
    name: 'get_daily_summary',
    description:
      '指定日 (YYYY-MM-DD, America/New_York) の取引サマリーを返す。LLM 別の trades / wins / losses / win_rate / total_pnl_usd を含む。',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'YYYY-MM-DD 形式の日付 (省略時は本日)'
        }
      }
    }
  },
  {
    name: 'get_l4_probation',
    description:
      '現在 L4 プロベーション中の LLM × 方向と経過時間を返す。空配列ならブロック無し。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'moomoo_account_info',
    description:
      'MooMooペーパー取引口座の残高・資産情報を取得する。total_assets / cash / market_value / pnl 等を返す。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'moomoo_positions',
    description:
      'MooMooペーパー取引口座の保有ポジション一覧を取得する。各行: symbol / qty / cost_price / market_value / pnl 等。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'moomoo_quote',
    description:
      '指定シンボルの現在気配値を取得する。last_price / bid / ask / volume 等を返す。',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '銘柄シンボル (例: AAPL, TSLA, NVDA)'
        }
      },
      required: ['symbol']
    }
  },
  {
    name: 'moomoo_place_order',
    description:
      'MooMooペーパー取引口座で成行注文を発注する。SIMULATEモードのみ（本番取引不可）。',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '銘柄シンボル (例: AAPL)'
        },
        side: {
          type: 'string',
          description: '売買方向: BUY または SELL'
        },
        qty: {
          type: 'integer',
          description: '注文数量'
        }
      },
      required: ['symbol', 'side', 'qty']
    }
  },
  {
    name: 'moomoo_connectivity',
    description:
      'MooMoo接続チェーン全体の疎通確認。proxy → bridge → OpenD の各ステップの状態を返す。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_constitution',
    description:
      'MAGI Constitution（最上位ルール）を BigQuery から取得する。セクション名を指定すると該当セクションのみ返す。省略時は全文を返す。',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'セクション名（例: NORTH STAR, CORE PRINCIPLES, FORBIDDEN ACTIONS）。省略時は全文'
        }
      }
    }
  }
];

async function akaTool_getTodayTrades({ limit }) {
  const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
  const query = `
    SELECT symbol, side, llm_provider, result,
           ROUND(pnl_amount, 2) AS pnl_usd, timestamp
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') = CURRENT_DATE('America/New_York')
    ORDER BY timestamp DESC
    LIMIT @lim
  `;
  const rows = await runQuery(query, { lim }, { lim: 'INT64' });
  return { count: rows.length, trades: rows };
}

async function akaTool_getWinrateByLlm({ days }) {
  const d = Math.max(1, Math.min(Number(days) || 30, 90));
  const query = `
    SELECT
      llm_provider,
      side,
      COUNT(*) AS trades,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS losses,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNTIF(result IN ('WIN','LOSE')), 0) * 100, 1) AS win_rate
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @d DAY)
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider, side
    ORDER BY llm_provider, side
  `;
  const rows = await runQuery(query, { d }, { d: 'INT64' });
  return { days: d, rows };
}

async function akaTool_getDailySummary({ date }) {
  const target = date || new Date().toISOString().split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    throw new Error('date は YYYY-MM-DD 形式で指定してください');
  }
  const query = `
    SELECT
      llm_provider,
      COUNT(*) AS trades,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS losses,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      ROUND(SUM(pnl_amount), 2) AS total_pnl_usd
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') = @date
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider
    ORDER BY total_pnl_usd DESC
  `;
  const rows = await runQuery(query, { date: target }, { date: 'DATE' });
  return { date: target, rows };
}

async function akaTool_getL4Probation() {
  const query = `
    SELECT llm_provider, side, blocked_at,
           TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), blocked_at, HOUR) AS hours_blocked
    FROM \`${PROJECT_ID}.magi_core.l4_probation\`
    ORDER BY blocked_at DESC
  `;
  const rows = await runQuery(query).catch(() => []);
  return { count: rows.length, rows };
}

async function akaTool_moomooAccountInfo() {
  return callMoomoo('/trade/account_info');
}

async function akaTool_moomooPositions() {
  return callMoomoo('/trade/positions');
}

async function akaTool_moomooQuote({ symbol }) {
  if (!symbol) throw new Error('symbol は必須です');
  return callMoomoo(`/trade/quote?symbol=${encodeURIComponent(symbol)}`);
}

async function akaTool_moomooPlaceOrder({ symbol, side, qty }) {
  if (!symbol || !side || !qty) throw new Error('symbol, side, qty は必須です');
  return callMoomoo('/trade/place_order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol,
      side: side.toUpperCase(),
      qty: Number(qty),
      price: 0,
      order_type: 'MARKET',
      remark: 'AKA-1 Telegram'
    })
  });
}

async function akaTool_moomooConnectivity() {
  return callMoomoo('/connectivity');
}

async function akaTool_getConstitution({ section }) {
  const query = `
    SELECT version, content, sha256, effective_date, section_index
    FROM \`${PROJECT_ID}.magi_core.constitution\`
    WHERE deprecated_at IS NULL
    ORDER BY effective_date DESC
    LIMIT 1
  `;
  const rows = await runQuery(query);
  if (!rows.length) return { error: 'Constitution not found' };
  const row = rows[0];
  if (!section) {
    return {
      version: row.version,
      sha256: row.sha256,
      effective_date: row.effective_date?.value || row.effective_date,
      content: row.content
    };
  }
  const lines = row.content.split('\n');
  const sectionHeader = lines.findIndex(l =>
    l.startsWith('## ') && l.toLowerCase().includes(section.toLowerCase())
  );
  if (sectionHeader === -1) {
    const sections = JSON.parse(row.section_index || '[]');
    return { error: `Section "${section}" not found`, available_sections: sections };
  }
  const nextHeader = lines.findIndex(
    (l, i) => i > sectionHeader && l.startsWith('## ')
  );
  const sectionContent = lines
    .slice(sectionHeader, nextHeader === -1 ? undefined : nextHeader)
    .join('\n')
    .trim();
  return {
    version: row.version,
    sha256: row.sha256,
    section: lines[sectionHeader].replace(/^## /, ''),
    content: sectionContent
  };
}

const AKA1_TOOL_HANDLERS = {
  get_today_trades: akaTool_getTodayTrades,
  get_winrate_by_llm: akaTool_getWinrateByLlm,
  get_daily_summary: akaTool_getDailySummary,
  get_l4_probation: akaTool_getL4Probation,
  moomoo_account_info: akaTool_moomooAccountInfo,
  moomoo_positions: akaTool_moomooPositions,
  moomoo_quote: akaTool_moomooQuote,
  moomoo_place_order: akaTool_moomooPlaceOrder,
  moomoo_connectivity: akaTool_moomooConnectivity,
  get_constitution: akaTool_getConstitution
};

async function executeAka1Tool(name, input) {
  const handler = AKA1_TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(input || {});
}

// Convert Anthropic tool schema to Gemini function declarations
function toGeminiFunctionDeclarations() {
  return AKA1_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema
  }));
}

async function callGeminiWithTools(userMessage) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY が未設定です');
  }
  const systemPrompt =
    'あなたは MAGI トレーディングシステムの監視 bot 「AKA-1」(Gemini fallback) です。' +
    '日本語で簡潔に応答してください。' +
    '取引・勝率・P&L・L4 プロベーション等のデータは必ず提供された tool を使って取得し、推測で答えないこと。' +
    'MAGI Constitution（憲法）は最上位ルールです。get_constitution ツールで取得できます。' +
    '憲法に関する質問には必ずツールで原文を取得してから回答してください。' +
    '勝率や金額には具体的な数値と件数 (n) を付記してください。' +
    'Telegram 宛のため、絵文字や箇条書きは控えめに、HTML タグは使わずプレーンテキストで返してください。' +
    '\n\nMooMooペーパー取引機能も利用可能です。moomoo_* ツールで口座残高・ポジション・気配値の確認、' +
    '成行注文の発注ができます。全て SIMULATE（デモ）環境のみで、本番取引は行われません。' +
    '発注時は必ずユーザーの指示を確認し、symbol / side / qty を明示してから実行してください。';

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
    if (!candidate?.content?.parts) {
      return '（Gemini から応答がありませんでした）';
    }

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
        fnResponses.push({
          functionResponse: { name, response: { result } }
        });
      } catch (e) {
        console.error(`[AKA-1:GEMINI] tool error: ${e.message}`);
        fnResponses.push({
          functionResponse: { name, response: { error: e.message } }
        });
      }
    }
    contents.push({ role: 'function', parts: fnResponses });
  }
  return 'tool 呼び出し回数の上限に達しました。質問を簡素化してもう一度お試しください。';
}

async function callClaudeWithTools(userMessage) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY が未設定です');
  }
  const systemPrompt =
    `あなたは MAGI トレーディングシステムの監視 bot「AKA-1」です。モデル: ${AKA1_MODEL}。` +
    'あなたは Anthropic の Claude です。Gemini ではありません。モデル名を聞かれたら上記を正確に答えてください。' +
    '日本語で簡潔に応答してください。' +
    '取引・勝率・P&L・L4 プロベーション等のデータは必ず提供された tool を使って取得し、推測で答えないこと。' +
    'MAGI Constitution（憲法）は最上位ルールです。get_constitution ツールで取得できます。' +
    '憲法に関する質問には必ずツールで原文を取得してから回答してください。' +
    '勝率や金額には具体的な数値と件数 (n) を付記してください。' +
    'Telegram 宛のため、絵文字や箇条書きは控えめに、HTML タグは使わずプレーンテキストで返してください。' +
    '\n\nMooMooペーパー取引機能も利用可能です。moomoo_* ツールで口座残高・ポジション・気配値の確認、' +
    '成行注文の発注ができます。全て SIMULATE（デモ）環境のみで、本番取引は行われません。' +
    '発注時は必ずユーザーの指示を確認し、symbol / side / qty を明示してから実行してください。';

  const messages = [{ role: 'user', content: userMessage }];

  for (let i = 0; i < AKA1_MAX_TOOL_ITERATIONS; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
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
      throw new Error(`Anthropic API: ${errMsg}`);
    }

    if (data.model) {
      aka1LastResponseModel = data.model;
      console.log(`[AKA-1] API response model: ${data.model}`);
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
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result)
        });
      } catch (e) {
        console.error(`[AKA-1] tool error: ${e.message}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Error: ${e.message}`,
          is_error: true
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return 'tool 呼び出し回数の上限に達しました。質問を簡素化してもう一度お試しください。';
}

// ===== BigQueryクエリヘルパー =====
async function runQuery(query, params, types) {
  const options = { query };
  if (params) options.params = params;
  if (types) options.types = types;
  const [rows] = await bq.query(options);
  return rows;
}

// ===== 日次レポート生成 =====
// Phase 4: 毎日22:00 UTCにCloud Schedulerが /report/daily を叩く
async function generateDailyReport() {
  const today = new Date().toISOString().split('T')[0];

  // 当日取引サマリー
  const tradeQuery = `
    SELECT
      llm_provider,
      COUNT(*) AS trades,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS losses,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      ROUND(SUM(pnl_amount), 2) AS total_pnl_usd
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp) = @today
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider
    ORDER BY total_pnl_usd DESC
  `;

  // L4プロベーション状態
  const l4Query = `
    SELECT llm_provider, side, blocked_at,
           TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), blocked_at, HOUR) AS hours_blocked
    FROM \`${PROJECT_ID}.magi_core.l4_probation\`
    ORDER BY blocked_at DESC
  `;

  // ブロック統計
  const blockQuery = `
    SELECT blocked_by, COUNT(*) AS count
    FROM \`${PROJECT_ID}.magi_core.trades\`
    WHERE DATE(timestamp) = @today
      AND trade_mode = 'BLOCKED'
    GROUP BY blocked_by
    ORDER BY count DESC
  `;

  const todayParams = { today };
  const todayTypes = { today: 'DATE' };

  const [trades, l4Blocks, blockStats] = await Promise.all([
    runQuery(tradeQuery, todayParams, todayTypes).catch(() => []),
    runQuery(l4Query).catch(() => []),
    runQuery(blockQuery, todayParams, todayTypes).catch(() => [])
  ]);

  // レポート構築
  const totalTrades = trades.reduce((a, r) => a + Number(r.trades || 0), 0);
  const totalWins   = trades.reduce((a, r) => a + Number(r.wins || 0), 0);
  const totalLosses = trades.reduce((a, r) => a + Number(r.losses || 0), 0);
  const totalPnl    = trades.reduce((a, r) => a + Number(r.total_pnl_usd || 0), 0);
  const overallWR   = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';

  let msg = `📊 <b>MAGI Daily Report</b> - ${today}\n\n`;
  msg += `📈 <b>取引サマリー</b>\n`;
  msg += `総取引: ${totalTrades}件 | WIN: ${totalWins} | LOSE: ${totalLosses}\n`;
  msg += `勝率: ${overallWR}% | P&L: $${totalPnl.toFixed(2)}\n\n`;

  if (trades.length > 0) {
    msg += `<b>LLM別パフォーマンス</b>\n`;
    for (const r of trades) {
      const wr = r.win_rate || 0;
      const emoji = wr >= 60 ? '🟢' : wr >= 40 ? '🟡' : '🔴';
      msg += `${emoji} ${r.llm_provider}: ${r.trades}件 WR${wr}% P&L$${Number(r.total_pnl_usd).toFixed(2)}\n`;
    }
    msg += '\n';
  }

  if (l4Blocks.length > 0) {
    msg += `🔒 <b>L4ブロック状態</b>\n`;
    for (const b of l4Blocks) {
      msg += `  ${b.llm_provider}(${b.side}): ${b.hours_blocked}時間経過\n`;
    }
    msg += '\n';
  } else {
    msg += `✅ L4ブロック: なし\n\n`;
  }

  if (blockStats.length > 0) {
    msg += `🛡 <b>本日のガードブロック</b>\n`;
    for (const s of blockStats) {
      msg += `  ${s.blocked_by}: ${s.count}件\n`;
    }
  }

  return { message: msg, data: { trades, l4Blocks, blockStats } };
}

// ===== 週次レポート生成 =====
// Phase 4: 毎週月曜00:00 UTCにCloud Schedulerが /report/weekly を叩く
async function generateWeeklyReport() {
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 7 * 86400 * 1000).toISOString().split('T')[0];

  // 週次勝率トレンド（日別）
  const trendQuery = `
    SELECT
      DATE(timestamp) AS trade_date,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      COUNT(*) AS trades
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp) BETWEEN @startDate AND @endDate
      AND result IN ('WIN','LOSE')
    GROUP BY trade_date
    ORDER BY trade_date
  `;

  // LLM別パフォーマンス推移
  const llmPerfQuery = `
    SELECT
      llm_provider,
      COUNT(*) AS total_trades,
      COUNTIF(result = 'WIN') AS wins,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      ROUND(SUM(pnl_amount), 2) AS total_pnl_usd,
      ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp) BETWEEN @startDate AND @endDate
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider
    ORDER BY win_rate DESC
  `;

  // 注目パターン（ISABELから）
  const patternQuery = `
    SELECT
      pattern_summary,
      win_probability,
      similar_trade_count
    FROM \`${PROJECT_ID}.magi_core.isabel_analysis\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    ORDER BY win_probability DESC
    LIMIT 3
  `;

  const dateParams = { startDate, endDate };
  const dateTypes = { startDate: 'DATE', endDate: 'DATE' };

  const [trend, llmPerf, patterns] = await Promise.all([
    runQuery(trendQuery, dateParams, dateTypes).catch(() => []),
    runQuery(llmPerfQuery, dateParams, dateTypes).catch(() => []),
    runQuery(patternQuery).catch(() => [])
  ]);

  // 週全体の集計
  const weekTotal  = llmPerf.reduce((a, r) => a + Number(r.total_trades || 0), 0);
  const weekWins   = llmPerf.reduce((a, r) => a + Number(r.wins || 0), 0);
  const weekPnl    = llmPerf.reduce((a, r) => a + Number(r.total_pnl_usd || 0), 0);
  const weekWR     = weekTotal > 0 ? ((weekWins / weekTotal) * 100).toFixed(1) : '0.0';

  let msg = `📅 <b>MAGI Weekly Report</b>\n`;
  msg += `期間: ${startDate} ～ ${endDate}\n\n`;

  msg += `📊 <b>週間サマリー</b>\n`;
  msg += `総取引: ${weekTotal}件 | 勝率: ${weekWR}% | P&L: $${weekPnl.toFixed(2)}\n\n`;

  // 日別トレンド
  if (trend.length > 0) {
    msg += `📈 <b>勝率トレンド</b>\n`;
    for (const d of trend) {
      const bar = '█'.repeat(Math.round(Number(d.win_rate) / 10));
      msg += `${d.trade_date}: ${d.win_rate}% ${bar} (${d.trades}件)\n`;
    }
    msg += '\n';
  }

  // LLM別パフォーマンス
  if (llmPerf.length > 0) {
    msg += `🤖 <b>LLM別パフォーマンス</b>\n`;
    for (const r of llmPerf) {
      const wr = Number(r.win_rate);
      const emoji = wr >= 60 ? '🟢' : wr >= 40 ? '🟡' : '🔴';
      msg += `${emoji} ${r.llm_provider}: WR${wr}% | ${r.total_trades}件 | P&L$${Number(r.total_pnl_usd).toFixed(2)}\n`;
    }
    msg += '\n';
  }

  // 注目パターン
  if (patterns.length > 0) {
    msg += `🔍 <b>ISABEL注目パターン</b>\n`;
    for (const p of patterns) {
      msg += `  勝率予測${Number(p.win_probability * 100).toFixed(0)}%: ${p.pattern_summary}\n`;
    }
  }

  return { message: msg, data: { trend, llmPerf, patterns } };
}

// ===== /status /wr /jobs ハンドラ用 BigQuery クエリ =====
//
// これらは commit 67f131b 以来 handleBotCommand から参照されているが、
// ファイル内に未定義のままだった（呼び出すと ReferenceError で /status /wr が壊れる既知のバグ）。
// trades_active テーブルの result 列 ('WIN' / 'LOSE' / その他 = HOLD 扱い) を集計する。

async function queryTodaySummary() {
  const query = `
    SELECT
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS loses,
      COUNTIF(result NOT IN ('WIN', 'LOSE') OR result IS NULL) AS holds
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') = CURRENT_DATE('America/New_York')
  `;
  const rows = await runQuery(query).catch((e) => {
    console.error('[MONI] queryTodaySummary error:', e.message);
    return [];
  });
  const r = rows[0] || {};
  return {
    wins: Number(r.wins || 0),
    loses: Number(r.loses || 0),
    holds: Number(r.holds || 0)
  };
}

async function queryOverallStats() {
  const query = `
    SELECT
      COUNTIF(result = 'WIN') AS total_wins,
      COUNTIF(result = 'LOSE') AS total_loses,
      ROUND(
        COUNTIF(result = 'WIN')
          / NULLIF(COUNTIF(result IN ('WIN','LOSE')), 0) * 100,
        1
      ) AS overall_wr
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE result IN ('WIN', 'LOSE')
  `;
  const rows = await runQuery(query).catch((e) => {
    console.error('[MONI] queryOverallStats error:', e.message);
    return [];
  });
  const r = rows[0] || {};
  return {
    total_wins: Number(r.total_wins || 0),
    total_loses: Number(r.total_loses || 0),
    overall_wr: r.overall_wr ?? null
  };
}

// /wr コマンド用: LLM × 方向別 (BUY/SELL) の勝率テーブル。
// デフォルトで過去 30 日間の集計（L4 プロベーションの閾値評価と整合しやすい期間）。
async function queryTradeMetrics({ days = 30 } = {}) {
  const query = `
    SELECT
      llm_provider,
      side,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS loses,
      ROUND(
        COUNTIF(result = 'WIN')
          / NULLIF(COUNTIF(result IN ('WIN','LOSE')), 0) * 100,
        1
      ) AS win_rate
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      AND result IN ('WIN', 'LOSE')
      AND llm_provider IS NOT NULL
      AND side IS NOT NULL
    GROUP BY llm_provider, side
    HAVING wins + loses >= 1
    ORDER BY llm_provider, side
  `;
  const rows = await runQuery(query, { days }, { days: 'INT64' }).catch((e) => {
    console.error('[MONI] queryTradeMetrics error:', e.message);
    return [];
  });
  return rows.map((r) => ({
    llm_provider: r.llm_provider,
    side: r.side,
    wins: Number(r.wins || 0),
    loses: Number(r.loses || 0),
    win_rate: r.win_rate ?? null
  }));
}

// ===== ヘルスチェック =====
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'magi-moni',
    version: '3.0.0',
    resultsCount: tradeResults.length,
    timestamp: new Date().toISOString()
  });
});

// ===== Pub/Sub エンドポイント（既存機能） =====
app.post('/pubsub/trade-result', async (req, res) => {
  if (!(await verifyInternalRequest(req))) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const message = req.body.message;
    if (!message || !message.data) {
      console.log('[MONI] No message data');
      return res.status(200).send('OK');
    }
    const data = JSON.parse(Buffer.from(message.data, 'base64').toString());
    console.log('[MONI] Received trade result:', JSON.stringify(data));
    tradeResults.push({ ...data, receivedAt: new Date().toISOString() });
    if (tradeResults.length > 100) tradeResults.shift();
    res.status(200).send('OK');
  } catch (error) {
    console.error('[MONI] Error processing message:', error.message);
    res.status(200).send('OK');
  }
});

// ===== 取引結果履歴取得（既存機能） =====
app.get('/results', (req, res) => {
  res.json({
    count: tradeResults.length,
    results: tradeResults.slice(-20).reverse()
  });
});

// ===== 日次レポート（Phase 4）=====
// Cloud Schedulerから毎日22:00 UTCに叩かれる
app.post('/report/daily', async (req, res) => {
  if (!(await verifyInternalRequest(req))) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  console.log('[MONI] Generating daily report...');
  try {
    const { message, data } = await generateDailyReport();
    await sendTelegram(message);
    console.log('[MONI] Daily report sent');
    res.json({ status: 'ok', message: 'Daily report sent', data });
  } catch (err) {
    console.error('[MONI] Daily report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 週次レポート（Phase 4）=====
// Cloud Schedulerから毎週月曜00:00 UTCに叩かれる
app.post('/report/weekly', async (req, res) => {
  if (!(await verifyInternalRequest(req))) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  console.log('[MONI] Generating weekly report...');
  try {
    const { message, data } = await generateWeeklyReport();
    await sendTelegram(message);
    console.log('[MONI] Weekly report sent');
    res.json({ status: 'ok', message: 'Weekly report sent', data });
  } catch (err) {
    console.error('[MONI] Weekly report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ---- Telegram Bot コマンドハンドラー ----

async function handleBotCommand(chatId, text) {
  const cmd = text.split(' ')[0].toLowerCase().replace('@magi_claw_bot', '');

  if (cmd === '/help' || cmd === '/start') {
    return sendTelegramTo(chatId, `[MAGI Monitor] コマンド一覧\n\n/status  - LLM API死活 + 本日サマリー\n/wr      - LLM x 方向別勝率テーブル\n/jobs    - Cloud Run Jobs状態\n/today   - 本日の取引一覧\n/llm     - AKA-1 の現在の LLM 設定\n/help    - このメッセージ\n\n📝 自然文での質問 (AKA-1 / ${AKA1_MODEL}) にも対応しています。\n例: 「直近1週間のGroqの勝率は？」「今日のWIN件数を教えて」`);
  }

  if (cmd === '/llm') {
    const claude = ANTHROPIC_API_KEY ? `✓ ${AKA1_MODEL}` : '✗ ANTHROPIC_API_KEY 未設定';
    const gemini = GEMINI_API_KEY ? `✓ ${GEMINI_FALLBACK_MODEL}` : '✗ GEMINI_API_KEY 未設定';
    const actual = aka1LastResponseModel ? `\n実モデル (API確認): ${aka1LastResponseModel}` : '\n実モデル: まだ応答なし（自然文を送ると記録されます）';
    return sendTelegramTo(chatId, `[AKA-1] LLM 設定\n\nPrimary: Claude — ${claude}\nFallback: Gemini — ${gemini}${actual}\n\n※ Claude を常に優先。Claude 失敗時のみ Gemini にフォールバック。`);
  }

  if (cmd === '/status') {
    try {
      const [today, overall] = await Promise.all([queryTodaySummary(), queryOverallStats()]);
      const llmVals = Object.entries(llmHealthState);
      const upList = llmVals.filter(([,v]) => v.status === 'UP').map(([k]) => k);
      const downList = llmVals.filter(([,v]) => v.status === 'DOWN').map(([k]) => k);
      let msg = `[MAGI Status] ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n\n`;
      msg += `総合勝率: ${overall.overall_wr ?? '--'}% (${overall.total_wins ?? 0}W ${overall.total_loses ?? 0}L)\n`;
      msg += `評価済み: ${(overall.total_wins ?? 0) + (overall.total_loses ?? 0)} 件\n\n`;
      msg += `本日: WIN ${today.wins} / LOSE ${today.loses} / HOLD ${today.holds}\n\n`;
      msg += `LLM API UP: ${upList.length > 0 ? upList.join(', ') : 'なし'}\n`;
      if (downList.length > 0) msg += `DOWN: ${downList.join(', ')}\n`;
      return sendTelegram(msg);
    } catch (e) { return sendTelegram(`[MAGI] /status エラー: ${e.message}`); }
  }

  if (cmd === '/wr') {
    try {
      const rows = await queryTradeMetrics();
      let msg = `[MAGI] LLM x 方向別勝率\n\n`;
      const byLLM = {};
      for (const r of rows) {
        if (!byLLM[r.llm_provider]) byLLM[r.llm_provider] = [];
        byLLM[r.llm_provider].push(r);
      }
      for (const [llm, entries] of Object.entries(byLLM)) {
        msg += `${llm.toUpperCase()}\n`;
        for (const r of entries) {
          const wr = r.win_rate ?? '--';
          const blocked = r.win_rate <= 30 && r.loses >= 3 ? ' [BLOCKED]' : '';
          msg += `  ${r.side}: ${wr}% (${r.wins}W ${r.loses}L)${blocked}\n`;
        }
      }
      return sendTelegram(msg);
    } catch (e) { return sendTelegram(`[MAGI] /wr エラー: ${e.message}`); }
  }

  if (cmd === '/jobs') {
    try {
      const entries = Object.entries(jobsState);
      let msg = `[MAGI] Cloud Run Jobs\n\n`;
      if (entries.length === 0) {
        msg += '取得中... 10分後に再度お試しください';
      } else {
        for (const [name, j] of entries) {
          const icon = j.status === 'SUCCESS' ? 'OK' : j.status === 'FAILED' ? 'FAIL' : j.status === 'RUNNING' ? 'RUN' : '??';
          const diff = j.lastRun ? Math.floor((Date.now() - new Date(j.lastRun)) / 60000) : null;
          const ago = diff !== null ? (diff < 60 ? `${diff}m前` : `${Math.floor(diff/60)}h前`) : '--';
          msg += `[${icon}] ${name} (${ago})\n`;
        }
      }
      return sendTelegram(msg);
    } catch (e) { return sendTelegram(`[MAGI] /jobs エラー: ${e.message}`); }
  }

  if (cmd === '/today') {
    try {
      const query = `SELECT symbol, side, llm_provider, result, timestamp FROM \`${PROJECT_ID}.magi_core.trades_active\` WHERE DATE(timestamp) = CURRENT_DATE('America/New_York') ORDER BY timestamp DESC LIMIT 20`;
      const [rows] = await bq.query({ query, useLegacySql: false });
      if (rows.length === 0) return sendTelegram('[MAGI] 本日の取引はまだありません');
      let msg = `[MAGI] 本日の取引 (${rows.length}件)\n\n`;
      for (const r of rows) {
        const result = r.result || 'pending';
        const time = new Date(r.timestamp?.value || r.timestamp).toLocaleTimeString('ja-JP', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
        msg += `${time} ${r.symbol} ${r.side} [${r.llm_provider}] -> ${result}\n`;
      }
      return sendTelegram(msg);
    } catch (e) { return sendTelegram(`[MAGI] /today エラー: ${e.message}`); }
  }

  return sendTelegram(`[MAGI] 不明なコマンド: ${cmd}\n/help でコマンド一覧を確認してください`);
}

// ===== AKA-1 自然言語ハンドラー =====
// Claude primary → Gemini fallback (non-sticky: always tries Claude first)
async function handleAka1Chat(chatId, text) {
  await sendTypingAction(chatId);
  console.log(`[AKA-1] chat=${chatId} text="${text}"`);

  // Try Claude (primary)
  let claudeError = null;
  if (ANTHROPIC_API_KEY) {
    try {
      const answer = await callClaudeWithTools(text);
      await sendTelegramTo(chatId, answer, { parseMode: 'Markdown' });
      return;
    } catch (e) {
      claudeError = e.message;
      console.error('[AKA-1] Claude error, trying Gemini fallback:', claudeError);
    }
  } else {
    console.log('[AKA-1] ANTHROPIC_API_KEY not set, using Gemini fallback');
  }

  // Gemini fallback
  if (GEMINI_API_KEY) {
    try {
      const answer = await callGeminiWithTools(text);
      await sendTelegramTo(chatId, answer, { parseMode: 'Markdown' });
      return;
    } catch (e) {
      console.error('[AKA-1] Gemini fallback also failed:', e.message);
      await sendTelegramTo(chatId, `[AKA-1 エラー] Claude / Gemini 両方失敗: ${e.message}`);
      return;
    }
  }

  if (claudeError) {
    await sendTelegramTo(chatId, `[AKA-1 エラー] Claude 失敗: ${claudeError}。Gemini フォールバックは未設定です。`);
  } else {
    await sendTelegramTo(chatId, '[AKA-1] LLM API キーが未設定です。ANTHROPIC_API_KEY または GEMINI_API_KEY を設定してください。');
  }
}

// Telegram Webhook
// - slash コマンド (/help, /status, /wr, /jobs, /today) は従来の handleBotCommand
// - それ以外の自然文は AKA-1 (Claude Fable + tool calling) に渡す
// - 認可: TELEGRAM_CHAT_ID と一致する chat 以外は無視 (誤爆・乱用防止)
app.post('/webhook/telegram', async (req, res) => {
  // Verify Telegram secret_token header to prevent spoofed webhook calls
  if (WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret !== WEBHOOK_SECRET) {
      console.log('[BOT] Rejected webhook: invalid secret token');
      return res.status(403).send('Forbidden');
    }
  }
  res.status(200).send('OK');
  try {
    const update = req.body;
    const message = update.message || update.edited_message;
    if (!message || !message.text) return;

    const chatId = message.chat.id.toString();
    if (TELEGRAM_CHAT_ID && chatId !== TELEGRAM_CHAT_ID) {
      console.log(`[BOT] Ignoring chat ${chatId} (not authorized)`);
      return;
    }

    // @magi_claw_bot メンションを除去
    const text = message.text.replace(/@magi_claw_bot/gi, '').trim();
    if (!text) return;

    if (text.startsWith('/')) {
      console.log(`[BOT] Command: ${text}`);
      await handleBotCommand(chatId, text);
      return;
    }

    if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) {
      console.log('[BOT] Natural language received but no LLM API key set, ignoring');
      await sendTelegramTo(chatId, '[AKA-1] LLM API キーが未設定のため自然言語応答は無効です。/help で利用可能なコマンドを確認してください。');
      return;
    }

    await handleAka1Chat(chatId, text);
  } catch (e) { console.error('[BOT] Webhook error:', e.message); }
});

// Webhook登録
app.post('/setup/webhook', async (req, res) => {
  if (!(await verifyInternalRequest(req))) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const webhookUrl = `https://magi-moni-398890937507.asia-northeast1.run.app/webhook/telegram`;
    const result = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: WEBHOOK_SECRET }),
    });
    const data = await result.json();
    // Register bot commands in Telegram menu
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [
        { command: 'status', description: 'LLM API死活 + 本日サマリー' },
        { command: 'wr', description: 'LLM x 方向別勝率テーブル' },
        { command: 'jobs', description: 'Cloud Run Jobs状態' },
        { command: 'today', description: '本日の取引一覧' },
        { command: 'llm', description: 'AKA-1 の現在の LLM 設定' },
        { command: 'help', description: 'コマンド一覧' },
      ]}),
    });
    res.json({ webhookUrl, result: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MAGI Monitoring v3.0 on port ${PORT}`);
});
