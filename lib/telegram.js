/**
 * @module lib/telegram
 * Telegram send helpers (sendTelegramTo, sendTelegram, sendTelegramPhotoTo, sendTypingAction).
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

/**
 * Send a JPEG photo to a Telegram chat using the Bot API sendPhoto endpoint.
 * @param {string|number} chatId
 * @param {string} base64Jpeg - Raw base64 JPEG data (data: URI prefix is stripped).
 * @param {string} [caption]
 */
async function sendTelegramPhotoTo(chatId, base64Jpeg, caption = '') {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.log('[MONI] Telegram not configured, skipping photo');
    return;
  }

  const b64 = base64Jpeg.replace(/^data:image\/[^;]+;base64,/, '');
  const imageBuffer = Buffer.from(b64, 'base64');
  if (imageBuffer.length === 0) {
    console.error('[MONI] Telegram photo error: empty image buffer');
    return;
  }

  const boundary = `----magiBoundary${Date.now()}`;
  const eol = '\r\n';
  const chunks = [];

  function addField(name, value) {
    chunks.push(Buffer.from(`--${boundary}${eol}Content-Disposition: form-data; name="${name}"${eol}${eol}${value}${eol}`, 'utf8'));
  }

  addField('chat_id', String(chatId));
  if (caption) addField('caption', caption);

  chunks.push(Buffer.from(
    `--${boundary}${eol}Content-Disposition: form-data; name="photo"; filename="screenshot.jpg"${eol}Content-Type: image/jpeg${eol}${eol}`,
    'utf8'
  ));
  chunks.push(imageBuffer);
  chunks.push(Buffer.from(`${eol}--${boundary}--${eol}`, 'utf8'));

  const body = Buffer.concat(chunks);
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        console.log(`[MONI] Telegram photo sent to ${chatId} (status ${res.statusCode})`);
        resolve();
      });
    });
    req.on('error', (e) => {
      console.error('[MONI] Telegram photo error:', e.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
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

module.exports = { sendTelegramTo, sendTelegram, sendTelegramPhotoTo, sendTypingAction };
