/**
 * MAGI Monitoring Service — server.js (entry point)
 *
 * Telegram Bot (@magi_claw_bot) + AKA-1 agent + reporting.
 * magi-moni serves Telegram bot + AKA-1 agent. TIALA remote operations use OpenClaw Gateway.
 *
 * Modules:
 *   lib/config.js        — env vars, constants
 *   lib/telegram.js      — Telegram send helpers
 *   lib/bigquery.js      — BQ client + runQuery
 *   lib/moomoo.js        — magi-moomoo proxy client
 *   lib/openclaw.js      — OpenClaw Gateway client for TIALA remote ops
 *   lib/tiala.js         — TIALA service/exec/system/screenshot/action handlers
 *   lib/policy-engine.js — policy checks for system operations
 *   lib/tools.js         — AKA-1 tool definitions + handlers
 *   lib/llm.js           — LLM callers (Sakana/Ollama/Gemini) + handleAka1Chat
 *   lib/commands.js      — Slash command handler
 *   lib/reports.js       — Daily/weekly report generators
 */
const express = require('express');
const { OAuth2Client } = require('google-auth-library');

const {
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WEBHOOK_SECRET,
  SAKANA_API_KEY, SAKANA_MODEL,
  OLLAMA_BASE_URL, OLLAMA_MODEL,
  GEMINI_API_KEY, GEMINI_FALLBACK_MODEL,
} = require('./lib/config');
const { sendTelegramTo, sendTelegram } = require('./lib/telegram');
const { handleAka1Chat } = require('./lib/llm');
const { handleBotCommand } = require('./lib/commands');
const { generateDailyReport, generateWeeklyReport } = require('./lib/reports');

const app = express();
const PORT = process.env.PORT || 8080;

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

// In-memory trade results buffer (Pub/Sub)
const tradeResults = [];

// ===== Health check =====
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'magi-moni',
    version: '4.0.0',
    resultsCount: tradeResults.length,
    timestamp: new Date().toISOString()
  });
});

// ===== Pub/Sub: trade result =====
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

// ===== Trade results history =====
app.get('/results', (req, res) => {
  res.json({
    count: tradeResults.length,
    results: tradeResults.slice(-20).reverse()
  });
});

// ===== Daily report (Cloud Scheduler) =====
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

// ===== Weekly report (Cloud Scheduler) =====
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

// ===== Telegram Webhook =====
app.post('/webhook/telegram', async (req, res) => {
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

    const text = message.text.replace(/@magi_claw_bot/gi, '').trim();
    if (!text) return;

    if (text.startsWith('/')) {
      console.log(`[BOT] Command: ${text}`);
      await handleBotCommand(chatId, text);
      return;
    }

    if (!SAKANA_API_KEY && !OLLAMA_BASE_URL && !GEMINI_API_KEY) {
      console.log('[BOT] Natural language received but no LLM API key set, ignoring');
      await sendTelegramTo(chatId, '[AKA-1] LLM API キーが未設定のため自然言語応答は無効です。/help で利用可能なコマンドを確認してください。');
      return;
    }

    await handleAka1Chat(chatId, text);
  } catch (e) { console.error('[BOT] Webhook error:', e.message); }
});

// ===== Webhook registration =====
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
  console.log(`MAGI Monitoring v4.0 on port ${PORT}`);
  console.log(`[AKA-1] Primary: SAKANA_MODEL="${SAKANA_MODEL}" (key ${SAKANA_API_KEY ? 'set' : 'NOT set'})`);
  console.log(`[AKA-1] Fallback 1: Ollama ${OLLAMA_MODEL} (${OLLAMA_BASE_URL ? 'configured' : 'NOT configured'})`);
  console.log(`[AKA-1] Fallback 2: GEMINI_FALLBACK_MODEL="${GEMINI_FALLBACK_MODEL}" (key ${GEMINI_API_KEY ? 'set' : 'NOT set'})`);
});
