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
const SAKANA_API_KEY = process.env.SAKANA_API_KEY;
const SAKANA_MODEL = process.env.SAKANA_MODEL || 'fugu-ultra';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

const GEMINI_FALLBACK_MODEL = (process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash').replace(/^google\//, '');
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
  SAKANA_API_KEY,
  SAKANA_MODEL,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  GEMINI_FALLBACK_MODEL,
  AKA1_MAX_TOOL_ITERATIONS,
  WEBHOOK_SECRET,
  nyDateString,
};
