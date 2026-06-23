/**
 * @module lib/config
 * Centralized configuration: environment variables, constants, model normalization.
 */
const crypto = require('crypto');

const PROJECT_ID = process.env.PROJECT_ID || 'screen-share-459802';
const REGION = process.env.REGION || 'asia-northeast1';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SAKANA_API_KEY = process.env.SAKANA_API_KEY;
const AKA1_MODEL_RAW = process.env.AKA1_MODEL || 'claude-fable-5';
const SAKANA_MODEL = process.env.SAKANA_MODEL || 'fugu-ultra';

const ANTHROPIC_MODEL_ALIASES = {
  'claude-haiku': 'claude-haiku-4-5-20251001',
  'claude-sonnet': 'claude-sonnet-4-20250514',
  'haiku': 'claude-haiku-4-5-20251001',
  'sonnet': 'claude-sonnet-4-20250514',
  'fable': 'claude-fable-5',
};

function normalizeAnthropicModel(raw) {
  let model = raw.trim();
  if (model.includes('/')) {
    const stripped = model.split('/').pop();
    console.log(`[AKA-1] Stripped provider prefix from model: "${model}" → "${stripped}"`);
    model = stripped;
  }
  if (ANTHROPIC_MODEL_ALIASES[model]) {
    console.log(`[AKA-1] Resolved model alias: "${model}" → "${ANTHROPIC_MODEL_ALIASES[model]}"`);
    model = ANTHROPIC_MODEL_ALIASES[model];
  }
  return model;
}

const AKA1_MODEL = normalizeAnthropicModel(AKA1_MODEL_RAW);
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
  ANTHROPIC_API_KEY,
  SAKANA_API_KEY,
  AKA1_MODEL_RAW,
  AKA1_MODEL,
  SAKANA_MODEL,
  GEMINI_FALLBACK_MODEL,
  AKA1_MAX_TOOL_ITERATIONS,
  WEBHOOK_SECRET,
  nyDateString,
};
