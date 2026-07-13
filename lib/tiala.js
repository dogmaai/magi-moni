/**
 * @module lib/tiala
 * central-dogma (TIALA) REST client — service discovery via BigQuery.
 * Same pattern as lib/moomoo.js but for TIALA operations.
 */
const { GoogleAuth } = require('google-auth-library');
const { bq } = require('./bigquery');
const { PROJECT_ID } = require('./config');

let _cachedUrl = null;
let _cachedAt = 0;
const URL_CACHE_TTL_MS = 60_000; // 1 minute

let _tialaIdTokenClient = null;

async function getCentralDogmaUrl() {
  const now = Date.now();
  if (_cachedUrl && now - _cachedAt < URL_CACHE_TTL_MS) return _cachedUrl;

  const [rows] = await bq.query({
    query: `SELECT url FROM \`${PROJECT_ID}.magi_core.service_endpoints\`
            WHERE service = 'central-dogma'
            ORDER BY updated_at DESC LIMIT 1`,
    location: 'US'
  });
  if (!rows || rows.length === 0) throw new Error('central-dogma URL not found in service_endpoints');
  _cachedUrl = rows[0].url;
  _cachedAt = now;
  return _cachedUrl;
}

async function getCentralDogmaIdToken(targetUrl) {
  if (!_tialaIdTokenClient) {
    const auth = new GoogleAuth();
    _tialaIdTokenClient = await auth.getIdTokenClient(targetUrl);
  }
  const headers = await _tialaIdTokenClient.getRequestHeaders();
  return typeof headers.get === 'function'
    ? headers.get('Authorization')
    : headers.Authorization;
}

async function callTiala(path, options = {}) {
  const baseUrl = await getCentralDogmaUrl();
  const authHeader = await getCentralDogmaIdToken(baseUrl);
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      ...options.headers,
    },
    signal: AbortSignal.timeout(35000) // slightly above TIALA's 30s exec timeout
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`TIALA HTTP ${res.status}: ${errBody}`);
  }
  return res.json();
}

module.exports = { callTiala };
