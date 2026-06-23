---
name: testing-magi-moni
description: Test AKA-1 Telegram bot tools locally against real BigQuery and MooMoo APIs. Use when verifying new AKA-1 tools, BigQuery query changes, MooMoo proxy integration, or LLM routing changes.
---

# Testing magi-moni (AKA-1)

## Overview

magi-moni is a Cloud Run **service** (not a job) running an Express server with:
- Telegram bot webhook for slash commands and natural language chat (AKA-1)
- AKA-1 uses Ollama (TIALA local qwen2.5:14b) as primary LLM with tool calling
- 3-tier fallback chain: Ollama → Claude Fable 5 → Gemini 2.5 Flash (non-sticky: always tries Ollama first)
- Pub/Sub endpoint for trade result ingestion

## LLM Provider Architecture

| Priority | Provider | Model | Env Var | Cost |
|---|---|---|---|---|
| Primary | Ollama (TIALA) | qwen2.5:14b | `OLLAMA_BASE_URL` | Zero (local) |
| Fallback 1 | Claude | claude-fable-5 (Mythos) | `ANTHROPIC_API_KEY` | $10/$50 per MTok |
| Fallback 2 | Gemini | gemini-2.5-flash | `GEMINI_API_KEY` | Low cost |

### Cost Notes
- Ollama is zero-cost (local inference on TIALA hardware via Cloudflare Tunnel)
- **Claude Fable 5 is extremely expensive** — only invoked when Ollama fails
- Slash commands (`/status`, `/wr`, `/jobs`, `/today`, `/llm`, `/help`) never invoke any LLM
- **テスト時に実 ANTHROPIC_API_KEY で自然言語チャットを送ると課金が発生するため注意**

## Environment Setup

```bash
cd ~/repos/magi-moni
npm install
# Write GCP_SERVICE_ACCOUNT_KEY env var to a file
echo "$GCP_SERVICE_ACCOUNT_KEY" > /tmp/gcp-key.json
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json
```

## Webhook Simulation Testing

### Important: Webhook Secret Header

The server validates a secret token on all webhook requests. You MUST include the `X-Telegram-Bot-Api-Secret-Token` header, computed as the first 32 chars of the SHA-256 hash of the bot token:

```bash
SECRET=$(echo -n "$TELEGRAM_BOT_TOKEN" | sha256sum | head -c 32)
# For dummy token:
SECRET=$(echo -n "dummy_bot_token" | sha256sum | head -c 32)
```

Without this header, requests will be rejected with `[BOT] Rejected webhook: invalid secret token`.

### Capturing Telegram Message Text

With dummy bot tokens, Telegram API returns 404 and you can't see the message content in server logs. Create a CJS wrapper that intercepts `https.request` to capture sendMessage payloads:

```javascript
// test-server.js (place in repo root, don't commit)
const https = require('https');
const origRequest = https.request;
https.request = function(options, cb) {
  if (options.hostname === 'api.telegram.org' && options.path?.includes('/sendMessage')) {
    const req = origRequest.call(this, options, cb);
    const origReqWrite = req.write.bind(req);
    req.write = function(data) {
      try {
        const parsed = JSON.parse(data);
        console.log(`[TEST-CAPTURE] sendMessage text: ${parsed.text}`);
      } catch(_) {}
      return origReqWrite(data);
    };
    return req;
  }
  return origRequest.call(this, options, cb);
};
require('./server.js');
```

Then start with `node test-server.js` instead of `node server.js`. Remember to delete this file before committing.

### LLM Routing Tests

Test different fallback scenarios by varying which env vars are set:

```bash
# Test 1: Full 3-tier config (Ollama primary)
PORT=8090 OLLAMA_BASE_URL=http://localhost:19999 \
  ANTHROPIC_API_KEY=dummy GEMINI_API_KEY=dummy \
  TELEGRAM_CHAT_ID=12345 TELEGRAM_BOT_TOKEN=dummy_bot_token \
  GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json \
  node test-server.js

# Test 2: Ollama-only (no Claude/Gemini)
PORT=8091 OLLAMA_BASE_URL=http://localhost:19999 \
  TELEGRAM_CHAT_ID=12345 TELEGRAM_BOT_TOKEN=dummy_bot_token \
  GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json \
  node test-server.js

# Test 3: No LLM keys at all
PORT=8092 TELEGRAM_CHAT_ID=12345 TELEGRAM_BOT_TOKEN=dummy_bot_token \
  GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json \
  node test-server.js
```

Send webhook requests:
```bash
SECRET=$(echo -n "dummy_bot_token" | sha256sum | head -c 32)

# Slash command (no LLM needed)
curl -s -X POST http://localhost:8090/webhook/telegram \
  -H 'Content-Type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: $SECRET" \
  -d '{"message":{"chat":{"id":12345},"text":"/llm"}}'

# Natural language (triggers LLM chain)
curl -s -X POST http://localhost:8090/webhook/telegram \
  -H 'Content-Type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: $SECRET" \
  -d '{"message":{"chat":{"id":12345},"text":"今日の取引は？"}}'
```

### Key Log Patterns to Verify

| Scenario | Expected Log Pattern |
|---|---|
| Ollama attempted | `[AKA-1] Ollama (qwen2.5:14b) error, trying Claude fallback:` |
| Claude skipped (no key) | `[AKA-1] ANTHROPIC_API_KEY not set, skipping Claude` |
| Claude attempted (dummy key) | `Anthropic API: invalid x-api-key` |
| Gemini attempted (dummy key) | `Gemini API: API key not valid` |
| All LLMs failed | `[AKA-1 エラー] 全 LLM 失敗:` |
| No LLM keys set | `[BOT] Natural language received but no LLM API key set, ignoring` |
| Startup (Ollama configured) | `[AKA-1] Primary: Ollama qwen2.5:14b (configured)` |
| Startup (Ollama NOT configured) | `[AKA-1] Primary: Ollama qwen2.5:14b (NOT configured)` |

## Testing AKA-1 Tools Locally

AKA-1 tools are plain async functions that query BigQuery or call MooMoo APIs. You can test them directly without running the full Express server or Telegram webhook.

### Pattern: Copy function from server.js and run via Node.js

```bash
node --input-type=module -e "
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { BigQuery } = require('@google-cloud/bigquery');
// ... copy the tool function from server.js ...
// ... call it and verify output ...
"
```

Note: magi-moni uses CommonJS (`require`), but when running inline scripts with `--input-type=module`, use `createRequire` to load CJS packages.

### BigQuery Tools

| Tool | What it queries | Key table |
|---|---|---|
| `get_today_trades` | Today's trades | `magi_core.trades_active` |
| `get_winrate_by_llm` | LLM win rates | `magi_core.trades_active` |
| `get_daily_summary` | Daily summary | `magi_core.trades_active` |
| `get_l4_probation` | L4 blocks | `magi_core.l4_probation` |
| `get_constitution` | MAGI Constitution | `magi_core.constitution` |

All BigQuery queries use `location: 'US'` (magi_core dataset is in US region).

### MooMoo Tools

| Tool | Endpoint | Notes |
|---|---|---|
| `moomoo_account_info` | `/trade/account_info` | SIMULATE only |
| `moomoo_positions` | `/trade/positions` | Returns open positions |
| `moomoo_quote` | `/trade/quote?symbol=X` | Current price |
| `moomoo_place_order` | `/trade/place_order` | POST, MARKET order |
| `moomoo_connectivity` | `/connectivity` | Chain health check |

MooMoo tools require the magi-moomoo bridge to be running. The proxy URL is discovered via `magi_core.service_endpoints` BigQuery table.

### Constitution Tool Specifics

The `get_constitution` tool retrieves from `magi_core.constitution` table:
- Full text retrieval: call with `{}` (no section param)
- Section retrieval: call with `{ section: 'FORBIDDEN ACTIONS' }` (case-insensitive)
- Invalid section: returns `available_sections` array with all 13 section names
- SHA-256 integrity hash is stored for each version

## Key Testing Assertions

When testing BigQuery tools:
1. Verify the query returns expected row structure
2. Check for correct data types (BigQuery DATE returns as `{ value: 'YYYY-MM-DD' }` in some contexts)
3. Verify error handling (empty results, invalid params)

When testing MooMoo tools:
1. Verify bridge connectivity first via `moomoo_connectivity`
2. All trades are SIMULATE mode — never real money
3. Bridge may be offline (TIALA local machine) — test error handling path too

When testing model/LLM config changes:
1. Verify startup logs show correct provider priorities
2. Verify `/llm` command output shows correct 3-tier config
3. Verify `/help` text references correct primary model name
4. Verify natural language triggers correct fallback order via server logs
5. Verify `aka1LastResponseModel` is updated by all LLM handlers (not just Claude)

When testing tool schema changes:
1. Verify `toOllamaTools()` produces `{ type: 'function', function: { name, description, parameters } }` for all tools
2. Verify `toGeminiFunctionDeclarations()` produces correct Gemini format
3. Verify tool count matches `AKA1_TOOLS` array length

## Telegram Webhook Gotchas

- Telegram `getUpdates` (polling mode) が active だと webhook URL が自動削除される
- TIALA 等で `bot.js` などのポーリングプロセスが動いていないか確認すること
- Webhook 登録後は `getWebhookInfo` で URL が残っているか確認
- `/setup/webhook` は OIDC 認証が必要 — Cloud Shell のユーザートークンでは認証失敗する場合がある。Telegram API を直接呼ぶか、サービスアカウントトークンを使用
- `setMyCommands` はキャッシュされるため、Telegram アプリの再起動が必要な場合がある

## Deployment

magi-moni is deployed as a Cloud Run **service** (not job):
```bash
gcloud run services update magi-moni --region=asia-northeast1 --project=screen-share-459802 --image=<image>
```

Deploy is done by Jun manually via Cloud Shell after PR merge.

## Devin Secrets Needed

- `GCP_SERVICE_ACCOUNT_KEY` — GCP service account key for BigQuery access (available as org secret)
- `ANTHROPIC_API_KEY` — Only needed if testing the full AKA-1 Claude loop (not needed for routing tests or tool testing). **注意: Fable 5 は超高額 ($10/$50 per MTok) のため、テスト回数を最小限に**
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — Only needed for live Telegram testing
