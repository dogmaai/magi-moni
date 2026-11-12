/**
 * MAGI Monitoring Service — server.js (entry point)
 *
 * Discord operations (AKA-1 slash commands + human approval buttons) and reporting.
 * Telegram was retired on 2026-11-08 (Jun); Discord is the only channel.
 * TIALA remote operations use OpenClaw Gateway.
 *
 * Modules:
 *   lib/config.js        — env vars, constants
 *   lib/messaging.js     — outbound messages (Discord)
 *   lib/discord.js       — Discord interactions endpoint, approvals, webhook
 *   lib/bigquery.js      — BQ client + runQuery
 *   lib/moomoo.js        — magi-moomoo proxy client
 *   lib/openclaw.js      — OpenClaw Gateway client for TIALA remote ops
 *   lib/tiala.js         — TIALA service/exec/system/screenshot/action handlers
 *   lib/policy-engine.js — policy checks for system operations
 *   lib/tools.js         — AKA-1 tool definitions + handlers
 *   lib/llm.js           — LLM caller (Gemini) + handleAka1Chat
 *   lib/commands.js      — Slash command handler
 *   lib/reports.js       — Daily/weekly report generators
 */
const express = require('express');
const { OAuth2Client } = require('google-auth-library');

const { GEMINI_API_KEY, GEMINI_MODEL } = require('./lib/config');
const { sendNotification } = require('./lib/messaging');
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

const { createInteractionHandler } = require('./lib/discord');
const { executeAka1Tool } = require('./lib/tools');
app.post('/webhook/discord', express.raw({ type: 'application/json', limit: '256kb' }), createInteractionHandler({
  ask: handleAka1Chat, command: handleBotCommand, report: generateDailyReport, execute: executeAka1Tool,
}));
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
    const delivered = await sendNotification(message);
    if (!delivered) throw new Error('Discord report delivery failed');
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
    const delivered = await sendNotification(message);
    if (!delivered) throw new Error('Discord report delivery failed');
    console.log('[MONI] Weekly report sent');
    res.json({ status: 'ok', message: 'Weekly report sent', data });
  } catch (err) {
    console.error('[MONI] Weekly report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) app.listen(PORT, '0.0.0.0', () => {
  console.log(`MAGI Monitoring v4.0 on port ${PORT}`);
  console.log(`[AKA-1] LLM: GEMINI_MODEL="${GEMINI_MODEL}" (key ${GEMINI_API_KEY ? 'set' : 'NOT set'})`);
});

module.exports = app;
