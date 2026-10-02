/**
 * @module lib/config
 * Centralized configuration: environment variables, constants.
 */
const crypto = require('crypto');

const PROJECT_ID = process.env.PROJECT_ID || 'screen-share-459802';
const REGION = process.env.REGION || 'asia-northeast1';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').replace(/^google\//, '');
const OPENCLAW_SERVICE_NAME = process.env.OPENCLAW_SERVICE_NAME || 'openclaw';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const AKA1_MAX_TOOL_ITERATIONS = 5;

const WEBHOOK_SECRET = TELEGRAM_BOT_TOKEN
  ? crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest('hex').slice(0, 32)
  : null;

// America/New_York date helper (matches magi-core/lib/et-date.js)
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function nyDateString(at = new Date()) {
  return ET_DATE_FMT.format(at);
}

module.exports = {
  PROJECT_ID,
  REGION,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  OPENCLAW_SERVICE_NAME,
  OPENCLAW_GATEWAY_TOKEN,
  AKA1_MAX_TOOL_ITERATIONS,
  WEBHOOK_SECRET,
  nyDateString,
};
