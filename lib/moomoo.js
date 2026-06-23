/**
 * @module lib/moomoo
 * magi-moomoo Cloud Run proxy client (service discovery via BigQuery).
 */
const { GoogleAuth } = require('google-auth-library');
const { bq } = require('./bigquery');
const { PROJECT_ID } = require('./config');

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

module.exports = { callMoomoo };
