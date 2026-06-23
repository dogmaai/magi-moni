/**
 * @module lib/telegram
 * Telegram send helpers (sendTelegramTo, sendTelegram, sendTypingAction).
 */
const https = require('https');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('./config');

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

module.exports = { sendTelegramTo, sendTelegram, sendTypingAction };
