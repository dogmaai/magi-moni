const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = 'k-openai';
process.env.GEMINI_API_KEY = 'k-gemini';
process.env.DEEPSEEK_API_KEY = 'k-deepseek';
process.env.QWEN_API_KEY = 'k-qwen';
process.env.KIMI_API_KEY = 'k-kimi';
process.env.OLLAMA_BASE_URL = 'https://ollama.example.com';
process.env.OLLAMA_AUTH_TOKEN = 'k-ollama';
process.env.GEMINI_MODEL = 'gemini-3.8-flash';

const { PLM_WATCHLIST, DOC_WATCH, runPlmLifecycleCheck, formatNotification, htmlToText } = require('../plm-lifecycle');

const EXPECTED_IDS = {
  openai: 'gpt-5.6-luna',
  google: 'gemini-3.8-flash',
  deepseek: 'deepseek-flash',
  qwen: 'qwen-plus',
  kimi: 'kimi-k2.6',
};

// fetchImpl stub covering: provider model lists, Ollama tags/version,
// the ollama release atom, doc pages, and the Gemini doc-scan call.
function makeFetch(t, { missing = [], failing = {}, docNotices = null, docRaw = null, googlePages = null } = {}) {
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(url);
    const u = String(url);
    for (const [key, status] of Object.entries(failing)) {
      if (u.includes(key)) return { ok: false, status, json: async () => ({}), text: async () => '' };
    }
    if (u.includes('generateContent')) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: docRaw !== null ? docRaw : JSON.stringify(docNotices || []) }] } }],
        }),
      };
    }
    if (u.includes('generativelanguage.googleapis.com/v1beta/models')) {
      if (googlePages) {
        const m = u.match(/pageToken=(\d+)/);
        const page = googlePages[m ? Number(m[1]) : 0];
        return { ok: true, json: async () => (page || { models: [] }) };
      }
      const models = Object.values(EXPECTED_IDS).map((id) => ({ name: `models/${id}` }))
        .filter((m) => !missing.includes(m.name.replace('models/', '')));
      return { ok: true, json: async () => ({ models }) };
    }
    if (u.includes('releases.atom')) {
      return {
        ok: true,
        text: async () => '<feed><title>Release notes</title><entry><title>v0.40.17</title></entry></feed>',
      };
    }
    if (u.includes('ollama.example.com/api/version')) {
      return { ok: true, json: async () => ({ version: '0.40.17' }) };
    }
    if (u.includes('ollama.example.com')) {
      return {
        ok: true,
        json: async () => ({ models: [{ name: 'ministral-3:8b-ctx32k', digest: 'sha256:abc' }] }),
      };
    }
    // Doc watch pages — plain text; content is irrelevant since the Gemini
    // stub decides what notices exist.
    if (DOC_WATCH.some((d) => u === d.url)) {
      return { ok: true, text: async () => 'docs page text' };
    }
    const provider = u.includes('api.openai.com') ? 'openai'
      : u.includes('deepseek') ? 'deepseek'
      : u.includes('dashscope') ? 'qwen'
      : u.includes('moonshot') ? 'kimi'
      : null;
    const ids = Object.values(EXPECTED_IDS).filter((id) => !missing.includes(id));
    assert.ok(provider, `unexpected URL ${u}`);
    return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) };
  });
  return calls;
}

const okQuery = async () => [];

test('all providers healthy → zero findings', async (t) => {
  makeFetch(t);
  const { findings, checks } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.equal(findings.length, 0);
  assert.equal(checks.filter((c) => c.status === 'ok').length, PLM_WATCHLIST.length);
});

test('delisted model is reported as missing', async (t) => {
  makeFetch(t, { missing: ['deepseek-flash'] });
  const { findings } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.ok(findings.some((f) => f.includes('CASPER') && f.includes('deepseek-flash')));
});

test('provider HTTP failure is reported as error', async (t) => {
  makeFetch(t, { failing: { 'api.moonshot.ai': 500 } });
  const { findings } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.ok(findings.some((f) => f.includes('TYPHON') && f.includes('HTTP 500')));
});

test('served-model drift in thoughts is reported', async (t) => {
  makeFetch(t);
  const query = async () => [
    { unit_name: 'CASPER', model_version: 'deepseek-v4-flash', n: 12, last_seen: '2026-11-21' },
  ];
  const { findings, drift } = await runPlmLifecycleCheck({ queryImpl: query });
  assert.equal(drift.length, 1);
  assert.ok(findings.some((f) => f.includes('served model drift') && f.includes('deepseek-v4-flash')));
});

test('BigQuery failure degrades to an error finding, not a throw', async (t) => {
  makeFetch(t);
  const { findings } = await runPlmLifecycleCheck({
    queryImpl: async () => { throw new Error('quota exceeded'); },
  });
  assert.ok(findings.some((f) => f.includes('drift query failed')));
});

test('missing OLLAMA_BASE_URL skips BOREAS instead of failing', async (t) => {
  const saved = process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_BASE_URL;
  t.after(() => { process.env.OLLAMA_BASE_URL = saved; });
  makeFetch(t);
  const { findings, checks } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.equal(checks.find((c) => c.unit === 'BOREAS').status, 'skipped');
  assert.ok(findings.some((f) => f.includes('BOREAS') && f.includes('skipped')));
});

test('doc page deprecation notice is reported with provider and model', async (t) => {
  makeFetch(t, {
    docNotices: [{ date: '2026-11-20', model: 'deepseek-flash', kind: 'deprecation', summary: 'sunset 2027-01' }],
  });
  const { findings, docScans } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.equal(docScans.length, DOC_WATCH.length);
  assert.ok(findings.some((f) => f.includes('deprecation') && f.includes('deepseek-flash')));
});

test('doc page unreachable is reported as docs watch failure', async (t) => {
  makeFetch(t, { failing: { 'platform.openai.com': 503 } });
  const { findings } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.ok(findings.some((f) => f.includes('openai') && f.includes('docs watch failed')));
});

test('ollama behind latest release is reported', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('releases.atom')) {
      return { ok: true, text: async () => '<entry><title>v0.41.0</title></entry>' };
    }
    if (u.includes('/api/version')) return { ok: true, json: async () => ({ version: '0.40.17' }) };
    if (u.includes('ollama.example.com')) {
      return { ok: true, json: async () => ({ models: [{ name: 'ministral-3:8b-ctx32k' }] }) };
    }
    if (u.includes('generateContent')) {
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }) };
    }
    if (DOC_WATCH.some((d) => u === d.url)) return { ok: true, text: async () => 'x' };
    if (u.includes('generativelanguage')) {
      return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-3.8-flash' }] }) };
    }
    return { ok: true, json: async () => ({ data: Object.values(EXPECTED_IDS).map((id) => ({ id })) }) };
  });
  const { findings, ollamaVersion } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.equal(ollamaVersion.status, 'behind');
  assert.ok(findings.some((f) => f.includes('ollama') && f.includes('0.41.0')));
});

test('google model on a later list page is not reported missing', async (t) => {
  makeFetch(t, {
    googlePages: [
      { models: [{ name: 'models/gemini-other' }], nextPageToken: '1' },
      { models: [{ name: 'models/gemini-3.8-flash' }] },
    ],
  });
  const { findings, checks } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.equal(checks.find((c) => c.unit === 'MELCHIOR-1').status, 'ok');
  assert.ok(!findings.some((f) => f.includes('MELCHIOR-1')));
});

test('doc scan with unparseable LLM output is reported as error', async (t) => {
  makeFetch(t, { docRaw: 'Sure! Here is a summary of the page.' });
  const { findings, docScans } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.ok(docScans.every((s) => s.status === 'error'));
  assert.ok(findings.some((f) => f.includes('docs watch failed')));
});

test('ollama version-check failure is reported as a finding', async (t) => {
  makeFetch(t, { failing: { 'releases.atom': 503 } });
  const { findings, ollamaVersion } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.equal(ollamaVersion.status, 'error');
  assert.ok(findings.some((f) => f.includes('ollama') && f.includes('version check failed')));
});

test('locally ahead ollama build is not reported as behind', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('releases.atom')) {
      return { ok: true, text: async () => '<entry><title>v0.40.17</title></entry>' };
    }
    if (u.includes('/api/version')) return { ok: true, json: async () => ({ version: '0.41.0-rc1' }) };
    if (u.includes('ollama.example.com')) {
      return { ok: true, json: async () => ({ models: [{ name: 'ministral-3:8b-ctx32k' }] }) };
    }
    if (u.includes('generateContent')) {
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }) };
    }
    if (DOC_WATCH.some((d) => u === d.url)) return { ok: true, text: async () => 'x' };
    if (u.includes('generativelanguage')) {
      return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-3.8-flash' }] }) };
    }
    return { ok: true, json: async () => ({ data: Object.values(EXPECTED_IDS).map((id) => ({ id })) }) };
  });
  const { findings, ollamaVersion } = await runPlmLifecycleCheck({ queryImpl: okQuery });
  assert.equal(ollamaVersion.status, 'ok');
  assert.ok(!findings.some((f) => f.includes('ollama') && f.includes('behind')));
});

test('htmlToText strips markup, scripts, and caps length', () => {
  const out = htmlToText('<html><style>x{}</style><body><script>evil()</script><p>Hello <b>world</b></p></body></html>');
  assert.equal(out, 'Hello world');
  assert.ok(htmlToText('a'.repeat(100000)).length <= 60000);
});

test('formatNotification summarises findings and health count', async (t) => {
  makeFetch(t);
  const result = await runPlmLifecycleCheck({ queryImpl: okQuery });
  const msg = formatNotification({ findings: ['x'], checks: result.checks });
  assert.ok(msg.includes('1 finding(s)'));
  assert.ok(msg.includes(`${PLM_WATCHLIST.length}/${PLM_WATCHLIST.length}`));
});
