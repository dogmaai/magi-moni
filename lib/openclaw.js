/**
 * @module lib/openclaw
 * OpenClaw Gateway client for TIALA remote operations.
 * Discovers the gateway URL from BigQuery service_endpoints and invokes
 * tools exposed by the OpenClaw Gateway HTTP API.
 */
const { GoogleAuth } = require('google-auth-library');
const { bq } = require('./bigquery');
const { PROJECT_ID, OPENCLAW_SERVICE_NAME, OPENCLAW_GATEWAY_TOKEN } = require('./config');

let _cachedUrl = null;
let _cachedAt = 0;
const URL_CACHE_TTL_MS = 60_000;

let _idTokenClient = null;

async function getOpenClawUrl() {
  const now = Date.now();
  if (_cachedUrl && now - _cachedAt < URL_CACHE_TTL_MS) return _cachedUrl;

  const [rows] = await bq.query({
    query: `SELECT url FROM \`${PROJECT_ID}.magi_core.service_endpoints\`
            WHERE service = @service
            ORDER BY updated_at DESC LIMIT 1`,
    location: 'US',
    params: { service: OPENCLAW_SERVICE_NAME }
  });
  if (!rows || rows.length === 0) {
    throw new Error(`OpenClaw URL not found in service_endpoints (service=${OPENCLAW_SERVICE_NAME})`);
  }
  _cachedUrl = rows[0].url;
  _cachedAt = now;
  return _cachedUrl;
}

async function getAuthHeader(baseUrl) {
  // Cloud Run URLs use Google ID tokens. Public / tunnel URLs use a static bearer token.
  if (baseUrl.includes('.run.app')) {
    if (!_idTokenClient) {
      _idTokenClient = await new GoogleAuth().getIdTokenClient(baseUrl);
    }
    const headers = await _idTokenClient.getRequestHeaders();
    return typeof headers.get === 'function'
      ? headers.get('Authorization')
      : headers.Authorization;
  }
  if (!OPENCLAW_GATEWAY_TOKEN) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not configured');
  }
  return `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
}

/**
 * Invoke an OpenClaw tool on the remote Gateway.
 * @param {string} tool - Tool name (e.g. 'exec', 'computer', 'browser').
 * @param {object} args - Tool arguments.
 * @param {object} [options]
 * @param {string} [options.sessionKey='main']
 * @param {number} [options.timeout=35000]
 * @returns {Promise<object>}
 */
async function callOpenClaw(tool, args, options = {}) {
  const baseUrl = await getOpenClawUrl();
  const authHeader = await getAuthHeader(baseUrl);
  const url = `${baseUrl}/tools/invoke`;

  const body = {
    tool,
    args,
    sessionKey: options.sessionKey || 'main'
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout || 35000)
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenClaw HTTP ${res.status}: ${errBody}`);
  }
  return res.json();
}

/**
 * Run an agentic task through the OpenClaw Gateway Chat Completions surface.
 * The remote agent uses its own configured model (Sonnet 5 by default) and can
 * invoke browser/exec tools. Note: the `computer` tool requires a paired
 * OpenClaw node; for TIALA screen control see lib/tiala.js (screencapture/osascript).
 * Requires `gateway.http.endpoints.chatCompletions.enabled: true` in OpenClaw config.
 */
async function callOpenClawAgent(instruction, options = {}) {
  const baseUrl = await getOpenClawUrl();
  const authHeader = await getAuthHeader(baseUrl);
  const url = `${baseUrl}/v1/chat/completions`;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': authHeader
  };
  if (options.sessionKey) {
    // OpenClaw routes the request to the named session.
    headers['x-openclaw-session-key'] = options.sessionKey;
  }

  const body = {
    model: options.model || 'openclaw/default',
    messages: [{ role: 'user', content: instruction }],
    stream: false,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout || 120000)
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenClaw chat HTTP ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return {
    status: 'ok',
    model: data.model,
    content: content || JSON.stringify(data),
    raw: data
  };
}

module.exports = { callOpenClaw, callOpenClawAgent };
