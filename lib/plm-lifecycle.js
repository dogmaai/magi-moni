/**
 * @module lib/plm-lifecycle
 * PLM provider API lifecycle monitoring.
 *
 * Detects four failure modes per active PLM unit:
 *   1. The configured model id is gone from the provider's model list
 *      (delisting / forced migration).
 *   2. The served model reported in `thoughts.model_version` drifted from the
 *      configured id (silent alias re-pointing, e.g. deepseek-flash — see
 *      magi-knowledge system/plm-units/casper.md#provider-model-lifecycle).
 *   3. The provider endpoint itself is unreachable (outage / auth failure).
 *   4. A deprecation notice, breaking-change entry, or model release note
 *      mentioning a watched model appeared on the provider's docs
 *      (advance warning — complements magi-core's magi-llm-health-monitor,
 *      which only sees a probe that has already started failing).
 *
 * The watchlist mirrors `getLLMModel()` / `BUDGET_WEIGHTS` in
 * magi-core/lib/config.js and the OKF registry at
 * magi-knowledge system/plm-units/index.md. Update it when the roster
 * changes. DEPRECATED_PROVIDERS (together, groq, xai, sakana, lilith,
 * mistral) have no live consumer and are intentionally not watched.
 */
const { runQuery } = require('./bigquery');
const { PROJECT_ID, GEMINI_API_KEY, GEMINI_MODEL } = require('./config');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DRIFT_WINDOW_DAYS = 7;
const FETCH_TIMEOUT_MS = 30000;
const DOC_MAX_CHARS = 60000;
const MAX_LIST_PAGES = 10;

// Bearer header only on HTTPS or loopback HTTP, same rule as
// magi-core/lib/ollama-auth.js — a remote http:// target gets no credential.
function bearerHeaders(url, token) {
  if (!token) return {};
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  const secure = parsed.protocol === 'https:'
    || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  return secure ? { Authorization: `Bearer ${token}` } : {};
}

function openAiModelIds(json) {
  return (json.data || []).map((m) => m.id);
}

const PLM_WATCHLIST = [
  {
    unit: 'PROMETHEUS', provider: 'openai', model: 'gpt-5.6-luna',
    listUrl: () => 'https://api.openai.com/v1/models',
    headers: () => bearerHeaders('https://api.openai.com/v1/models', process.env.OPENAI_API_KEY),
    modelIds: openAiModelIds,
  },
  {
    unit: 'MELCHIOR-1', provider: 'google', model: 'gemini-3.8-flash',
    listUrl: () => `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY || ''}`,
    headers: () => ({}),
    modelIds: (json) => (json.models || []).map((m) => String(m.name || '').replace(/^models\//, '')),
    // ListModels is paginated (default 50/page, nextPageToken for the rest).
    nextPage: (json, baseUrl) => (json.nextPageToken
      ? `${baseUrl}&pageToken=${encodeURIComponent(json.nextPageToken)}`
      : null),
  },
  {
    unit: 'CASPER', provider: 'deepseek', model: 'deepseek-flash',
    listUrl: () => 'https://api.deepseek.com/models',
    headers: () => bearerHeaders('https://api.deepseek.com/models', process.env.DEEPSEEK_API_KEY),
    modelIds: openAiModelIds,
  },
  {
    unit: 'QWEN', provider: 'qwen', model: 'qwen-plus',
    listUrl: () => 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
    headers: () => bearerHeaders('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', process.env.QWEN_API_KEY),
    modelIds: openAiModelIds,
  },
  {
    unit: 'TYPHON', provider: 'kimi', model: 'kimi-k2.6',
    listUrl: () => 'https://api.moonshot.ai/v1/models',
    headers: () => bearerHeaders('https://api.moonshot.ai/v1/models', process.env.KIMI_API_KEY),
    modelIds: openAiModelIds,
  },
  {
    // Self-hosted on TIALA. Read-only checks only: model tag presence +
    // digest + server version. Requires OLLAMA_BASE_URL / OLLAMA_AUTH_TOKEN.
    unit: 'BOREAS', provider: 'ollama', model: 'ministral-3:8b-ctx32k',
    listUrl: () => (process.env.OLLAMA_BASE_URL ? `${process.env.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/tags` : null),
    versionUrl: () => (process.env.OLLAMA_BASE_URL ? `${process.env.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/version` : null),
    headers: () => bearerHeaders(process.env.OLLAMA_BASE_URL || '', process.env.OLLAMA_AUTH_TOKEN),
    modelIds: (json) => (json.models || []).map((m) => m.name || m.model),
    digestOf: (json) => {
      const hit = (json.models || []).find((m) => (m.name || m.model) === 'ministral-3:8b-ctx32k');
      return hit ? hit.digest : null;
    },
  },
];

// Docs pages fetched for LLM-extracted deprecation/update notices.
// Chosen for stability: dedicated deprecations/changelog pages, or a docs
// index file (kimi llms.txt), not landing pages whose markup churns.
const DOC_WATCH = [
  {
    provider: 'openai',
    url: 'https://platform.openai.com/docs/deprecations',
    models: ['gpt-5.6-luna'],
  },
  {
    provider: 'google',
    url: 'https://ai.google.dev/gemini-api/docs/deprecations',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  },
  {
    provider: 'deepseek',
    url: 'https://api-docs.deepseek.com/updates',
    models: ['deepseek-flash'],
  },
  {
    provider: 'qwen',
    url: 'https://www.alibabacloud.com/help/en/model-studio/models',
    models: ['qwen-plus'],
  },
  {
    provider: 'kimi',
    // llms.txt is the provider's own LLM-readable docs index — one file,
    // text only, no nav chrome.
    url: 'https://platform.kimi.ai/docs/llms.txt',
    models: ['kimi-k2.6'],
  },
];

// fetch() resolves as soon as headers arrive; clearing the timer there
// would leave a stalled body unbounded, so keep the abort timer armed
// until the response body has actually been read.
function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // unref so an unread/skipped body never keeps the process alive for the
  // full timeout; abort still fires for genuinely stalled reads.
  timer.unref?.();
  return fetch(url, { ...options, signal: controller.signal }).then((res) => {
    const done = () => clearTimeout(timer);
    for (const method of ['json', 'text']) {
      if (typeof res[method] !== 'function') continue;
      const read = res[method].bind(res);
      res[method] = () => read().finally(done);
    }
    return res;
  }, (err) => {
    clearTimeout(timer);
    throw err;
  });
}

async function checkModelPresence(entry, fetchImpl) {
  const url = entry.listUrl();
  if (!url) {
    return { ...entry, status: 'skipped', reason: 'endpoint env not bound' };
  }
  try {
    const ids = new Set();
    let json = null;
    let pageUrl = url;
    for (let pages = 0; pageUrl && pages < MAX_LIST_PAGES; pages++) {
      const res = await fetchImpl(pageUrl, { headers: entry.headers() });
      if (!res.ok) {
        return { ...entry, status: 'error', reason: `HTTP ${res.status}` };
      }
      json = await res.json();
      for (const id of entry.modelIds(json)) ids.add(id);
      pageUrl = entry.nextPage ? entry.nextPage(json, url) : null;
    }
    const present = ids.has(entry.model);
    return {
      ...entry,
      status: present ? 'ok' : 'missing',
      reason: present ? undefined : `model ${entry.model} not in ${ids.size} listed models`,
      digest: entry.digestOf ? entry.digestOf(json) : undefined,
    };
  } catch (err) {
    return { ...entry, status: 'error', reason: err.message };
  }
}

// Numeric semver compare on [major, minor, patch]; suffixes like
// "-rc1" are stripped, so a locally ahead build does not read as behind.
function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/, '').split('.').map((s) => parseInt(s, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// Installed Ollama server version on TIALA vs latest GitHub release tag.
async function checkOllamaVersion(fetchImpl) {
  const entry = PLM_WATCHLIST.find((e) => e.provider === 'ollama');
  const versionUrl = entry.versionUrl();
  if (!versionUrl) return { status: 'skipped', reason: 'OLLAMA_BASE_URL not bound' };
  try {
    const [localRes, releaseRes] = await Promise.all([
      fetchImpl(versionUrl, { headers: entry.headers() }),
      fetchImpl('https://github.com/ollama/ollama/releases.atom'),
    ]);
    if (!localRes.ok) return { status: 'error', reason: `/api/version HTTP ${localRes.status}` };
    if (!releaseRes.ok) return { status: 'error', reason: `releases.atom HTTP ${releaseRes.status}` };
    const local = (await localRes.json()).version;
    const atom = await releaseRes.text();
    // First stable release tag in the feed; a leading "-rcN" prerelease is
    // skipped so it cannot be reported as a released version.
    const latest = [...atom.matchAll(/<entry>[\s\S]*?<title>(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)<\/title>/g)]
      .map((m) => m[1])
      .find((tag) => !tag.includes('-'));
    if (!latest) return { status: 'error', reason: 'no stable release tag in feed' };
    const behind = compareVersions(local, latest) < 0;
    return {
      status: behind ? 'behind' : 'ok',
      installed: local,
      latest,
      reason: behind ? `ollama ${local} installed; ${latest} released` : undefined,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

// Served-model drift: recent model_version values in thoughts vs configured.
async function checkModelVersionDrift(queryImpl) {
  const query = `
    SELECT unit_name, model_version, COUNT(*) AS n, MAX(timestamp) AS last_seen
    FROM \`${PROJECT_ID}.magi_core.thoughts\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @d DAY)
      AND model_version IS NOT NULL
      AND llm_provider != 'system'
    GROUP BY unit_name, model_version
  `;
  const rows = await queryImpl(query, { d: DRIFT_WINDOW_DAYS }, { d: 'INT64' });
  const expected = new Map(PLM_WATCHLIST.map((e) => [e.unit, e.model]));
  const drift = [];
  for (const row of rows) {
    const want = expected.get(row.unit_name);
    if (want && row.model_version !== want) {
      drift.push({
        unit: row.unit_name,
        configured: want,
        served: row.model_version,
        rows: row.n,
        last_seen: row.last_seen,
      });
    }
  }
  return drift;
}

// Strip an HTML docs page down to plain text for the LLM pass.
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DOC_MAX_CHARS);
}

// Ask Gemini to extract deprecation / breaking-change / release notices
// that mention the watched model ids. Stateless: the pages carry their own
// dates, so no hash-diff table is needed. Never throws.
async function scanDocPage(doc, fetchImpl) {
  try {
    const res = await fetchImpl(doc.url);
    if (!res.ok) return { provider: doc.provider, url: doc.url, status: 'error', reason: `HTTP ${res.status}` };
    const text = htmlToText(await res.text());
    const prompt = [
      'You are auditing an LLM provider documentation page for lifecycle notices.',
      `Watched models: ${doc.models.join(', ')}.`,
      'From the page text below, extract every item that is (a) a deprecation / sunset / retirement notice,',
      '(b) a breaking API change, or (c) a model release/rename note, and that mentions a watched model',
      'or a model family it belongs to. Reply with ONLY a JSON array:',
      '[{"date": "YYYY-MM-DD or null", "model": "<id>", "kind": "deprecation|breaking|release", "summary": "one line"}].',
      'Return [] when nothing matches. Page text:',
      text,
    ].join('\n');
    const llmRes = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 2048, temperature: 0 },
        }),
      },
    );
    if (!llmRes.ok) return { provider: doc.provider, url: doc.url, status: 'error', reason: `LLM HTTP ${llmRes.status}` };
    const body = await llmRes.json();
    const raw = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      return { provider: doc.provider, url: doc.url, status: 'error', reason: `no JSON array in LLM response (${raw.slice(0, 80) || 'empty'})` };
    }
    let notices;
    try {
      notices = JSON.parse(match[0]);
    } catch {
      return { provider: doc.provider, url: doc.url, status: 'error', reason: `unparseable LLM JSON (${match[0].slice(0, 80)})` };
    }
    if (!Array.isArray(notices)) notices = [notices];
    return { provider: doc.provider, url: doc.url, status: 'ok', notices };
  } catch (err) {
    return { provider: doc.provider, url: doc.url, status: 'error', reason: err.message };
  }
}

function buildReport({ checks, drift, docScans, ollamaVersion }) {
  const findings = [];
  for (const c of checks) {
    if (c.status === 'missing') {
      findings.push(`**${c.unit}** (${c.provider}): configured model \`${c.model}\` is NOT in the provider model list — delisted or renamed`);
    } else if (c.status === 'error') {
      findings.push(`**${c.unit}** (${c.provider}): model list check failed — ${c.reason}`);
    } else if (c.status === 'skipped') {
      findings.push(`**${c.unit}** (${c.provider}): check skipped — ${c.reason}`);
    }
  }
  for (const d of drift) {
    findings.push(`**${d.unit}**: served model drift — configured \`${d.configured}\` but thoughts report \`${d.served}\` (${d.rows} rows in ${DRIFT_WINDOW_DAYS}d)`);
  }
  for (const s of docScans) {
    if (s.status === 'error') {
      findings.push(`**${s.provider}**: docs watch failed — ${s.reason} (<${s.url}>)`);
      continue;
    }
    for (const n of s.notices || []) {
      findings.push(`**${s.provider}** docs: ${n.kind || 'notice'} ${n.date || ''} — \`${n.model}\` ${n.summary} (<${s.url}>)`);
    }
  }
  if (ollamaVersion && ollamaVersion.status === 'behind') {
    findings.push(`**BOREAS** (ollama): server ${ollamaVersion.installed} installed on TIALA; latest release is ${ollamaVersion.latest}`);
  } else if (ollamaVersion && ollamaVersion.status === 'error') {
    findings.push(`**BOREAS** (ollama): version check failed — ${ollamaVersion.reason}`);
  }
  return findings;
}

/**
 * Run all PLM lifecycle checks. Returns { findings, checks, drift, docScans }.
 * fetchImpl / queryImpl are injectable for tests.
 */
async function runPlmLifecycleCheck({ fetchImpl = fetchWithTimeout, queryImpl = runQuery } = {}) {
  const [checks, docScans, ollamaVersion] = await Promise.all([
    Promise.all(PLM_WATCHLIST.map((e) => checkModelPresence(e, fetchImpl))),
    Promise.all(DOC_WATCH.map((d) => scanDocPage(d, fetchImpl))),
    checkOllamaVersion(fetchImpl),
  ]);
  let drift = [];
  try {
    drift = await checkModelVersionDrift(queryImpl);
  } catch (err) {
    checks.push({ unit: '(BigQuery)', provider: 'bigquery', model: 'thoughts.model_version', status: 'error', reason: `drift query failed: ${err.message}` });
  }
  const findings = buildReport({ checks, drift, docScans, ollamaVersion });
  return { findings, checks, drift, docScans, ollamaVersion };
}

function formatNotification({ findings, checks }) {
  const okCount = checks.filter((c) => c.status === 'ok').length;
  const lines = [
    `**[PLM Lifecycle] ${findings.length} finding(s)** — ${okCount}/${PLM_WATCHLIST.length} providers healthy`,
    ...findings,
  ];
  return lines.join('\n');
}

module.exports = {
  PLM_WATCHLIST,
  DOC_WATCH,
  runPlmLifecycleCheck,
  formatNotification,
  buildReport,
  htmlToText,
};
