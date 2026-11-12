/**
 * @module lib/config
 * Centralized configuration: environment variables, constants.
 */
const PROJECT_ID = process.env.PROJECT_ID || 'screen-share-459802';
const REGION = process.env.REGION || 'asia-northeast1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').replace(/^google\//, '');
const OPENCLAW_SERVICE_NAME = process.env.OPENCLAW_SERVICE_NAME || 'openclaw';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const AKA1_MAX_TOOL_ITERATIONS = 5;

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
  GEMINI_API_KEY,
  GEMINI_MODEL,
  OPENCLAW_SERVICE_NAME,
  OPENCLAW_GATEWAY_TOKEN,
  AKA1_MAX_TOOL_ITERATIONS,
  nyDateString,
};
