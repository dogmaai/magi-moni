---
name: testing-magi-moni
description: Test AKA-1 Telegram bot tools locally against real BigQuery and MooMoo APIs. Use when verifying new AKA-1 tools, BigQuery query changes, MooMoo proxy integration, or LLM routing changes.
---

# Testing magi-moni (AKA-1)

## BigQuery DDL / DML tips

- To create tables from magi-core `sql/*.sql` DDL files, pipe the file via stdin:
  `bq query --project_id=screen-share-459802 --location=US --use_legacy_sql=false < sql/create_xxx.sql`.
  Do NOT use `"$(cat file.sql)"` — the backticks in BigQuery identifiers get executed by the shell and mangle the query.
- The HERMES focus tables (`magi_core.focus_symbols`, `magi_core.manual_focus_symbols`) may not exist in a fresh environment; both DDLs live in magi-core `sql/` and are `CREATE TABLE IF NOT EXISTS` (idempotent, safe to run).
- When testing focus-symbol tools, use fake tickers (e.g. ZZTA) and clean up with
  `DELETE FROM magi_core.manual_focus_symbols WHERE symbol IN (...)` afterwards — production HERMES reads active rows from this table.
- `export` of env vars may not persist across separate exec calls even in the same shell session; pass `GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json` inline on each command to be safe.

## Overview

magi-moni is a Cloud Run **service** (not a job) running an Express server with:
- Telegram bot webhook for slash commands and natural language chat (AKA-1)
- Modular architecture: `lib/config.js`, `lib/tools.js`, `lib/llm.js`, `lib/commands.js`, `lib/reports.js`, etc.
- AKA-1 uses Sakana AI (fugu-ultra) as primary LLM with tool calling
- 3-tier fallback chain: Sakana AI → Ollama (TIALA local qwen3.5:9b) → Gemini 2.5 Flash (non-sticky: always tries Sakana first)
- 21 tools total: 6 BQ read + 5 MooMoo + 6 TIALA ops + 1 OpenClaw agent + 3 system ops
- Pub/Sub endpoint for trade result ingestion

## LLM Provider Architecture

| Priority | Provider | Model | Env Var | Cost |
|---|---|---|---|---|
| Primary | Sakana AI | fugu-ultra | `SAKANA_API_KEY` | Moderate |
| Fallback 1 | Ollama (TIALA) | qwen3.5:9b | `OLLAMA_BASE_URL` | Zero (local) |
| Fallback 2 | Gemini | gemini-2.5-flash | `GEMINI_API_KEY` | Low cost |

### Cost Notes
- Ollama is zero-cost (local inference on TIALA hardware via Cloudflare Tunnel)
- Slash commands (`/status`, `/wr`, `/jobs`, `/today`, `/llm`, `/help`) never invoke any LLM
- テスト時に実 SAKANA_API_KEY で自然言語チャットを送ると課金が発生するため注意

## Modular Architecture (v4.0+)

The codebase is split into focused modules under `lib/`:

| Module | Purpose |
|---|---|
| `lib/config.js` | Environment variables, constants |
| `lib/telegram.js` | `sendTelegram`, `sendTypingAction` helpers |
| `lib/bigquery.js` | BQ client + `runQuery` helper |
| `lib/moomoo.js` | magi-moomoo Cloud Run proxy client (OIDC) |
| `lib/tiala.js` | TIALA operation handlers via OpenClaw Gateway tool invocation |
| `lib/policy-engine.js` | `checkPolicy()` for system operations |
| `lib/tools.js` | `AKA1_TOOLS[21]` + `executeAka1Tool` + format converters |
| `lib/llm.js` | `callSakana/Ollama/GeminiWithTools` + `handleAka1Chat` |
| `lib/commands.js` | Slash command handler (`handleBotCommand`) |
| `lib/reports.js` | Daily/weekly report generators |
| `server.js` | ~200 line Express entry point |

You can test individual tools directly without running the full server:
```javascript
const { executeAka1Tool } = require('./lib/tools');
const result = await executeAka1Tool('get_winrate_by_llm', { days: 7 });
```

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
# Test 1: Full 3-tier config (Sakana primary, Ollama fallback)
PORT=8090 SAKANA_API_KEY=dummy OLLAMA_BASE_URL=http://localhost:19999 \
  GEMINI_API_KEY=dummy \
  TELEGRAM_CHAT_ID=12345 TELEGRAM_BOT_TOKEN=dummy_bot_token \
  GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json \
  node test-server.js

# Test 2: Ollama-only (no Sakana/Gemini)
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
| Sakana attempted (dummy key) | `Sakana API:` error |
| Ollama attempted | `[AKA-1] Sakana ... error, trying Ollama fallback:` |
| Ollama skipped (no URL) | `[AKA-1] OLLAMA_BASE_URL not set, skipping Ollama` |
| Gemini attempted (dummy key) | `Gemini API: API key not valid` |
| All LLMs failed | `[AKA-1 エラー] 全 LLM 失敗:` |
| No LLM keys set | `[BOT] Natural language received but no LLM API key set, ignoring` |
| Startup (Ollama configured) | `Fallback 1: Ollama qwen3.5:9b (configured)` |
| Startup (Ollama NOT configured) | `Fallback 1: Ollama qwen3.5:9b (NOT configured)` |

## Testing AKA-1 Tools Locally

AKA-1 tools are plain async functions accessible via `executeAka1Tool(name, input)`. You can test them directly without running the full Express server:

```bash
cd ~/repos/magi-moni
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json

node -e "
const { executeAka1Tool } = require('./lib/tools');
executeAka1Tool('get_winrate_by_llm', { days: 7 })
  .then(r => console.log(JSON.stringify(r, null, 2)))
  .catch(e => console.error(e.message));
"
```

### BigQuery Tools

| Tool | What it queries | Key table |
|---|---|---|
| `get_today_trades` | Today's trades | `magi_core.trades_active` |
| `get_winrate_by_llm` | LLM win rates | `magi_core.trades_active` |
| `get_daily_summary` | Daily summary | `magi_core.trades_active` |
| `get_l4_probation` | L4 blocks | `magi_core.l4_probation` |
| `get_constitution` | MAGI Constitution | `magi_core.constitution` |
| `query_thoughts` | PLM thought logs | `magi_core.thoughts_active` |

All BigQuery queries use `location: 'US'` (magi_core dataset is in US region).

**Note on `thoughts_active` schema**: Columns are `session_id, timestamp, content, trade_mode, llm_provider, unit_name, symbol, action, reasoning, hypothesis, confidence, concerns, prompt_version`. There is NO `result` column — use `trade_mode` for filtering (values: NORMAL, BLOCKED, etc.).

### System Operation Tools

| Tool | Operation | Policy |
|---|---|---|
| `unblock_l4` | Delete from `l4_probation` table | confirm_required |
| `trigger_job` | Run Cloud Scheduler job via API | confirm_required |
| `trigger_optuna` | Shortcut for `trigger_job('magi-optuna-optimizer')` | confirm_required |

System ops use a 2-step confirmation flow:
1. Call without `confirmed` → returns `{status: 'confirmation_required', message: '...'}`
2. Call with `confirmed: true` → executes the operation

**Important**: `trigger_optuna` must use Scheduler job name `magi-optuna-optimizer` (NOT Cloud Run Job name `magi-optuna-job`).

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
1. Verify startup logs show correct provider priorities (Sakana → Ollama → Gemini)
2. Verify `/llm` command output shows Ollama tier (NOT Claude)
3. Verify `/help` text references correct primary model name
4. Verify natural language triggers correct fallback order via server logs
5. Verify `aka1LastResponseModel` is updated by all LLM handlers

When testing tool schema changes:
1. Verify `toOpenAiFunctionTools()` produces `{ type: 'function', function: { name, description, parameters } }` for all tools
2. Verify `toGeminiFunctionDeclarations()` produces correct Gemini format
3. Verify tool count matches `AKA1_TOOLS` array length (currently 21)

When testing system operation tools:
1. Verify `checkPolicy()` returns correct result for each command type
2. Verify 2-step confirmation flow (no confirmed → confirmation_required, confirmed=true → executed)
3. **Never call `trigger_job` or `trigger_optuna` with `confirmed=true` in testing** — this would execute real Cloud Scheduler jobs

### TIALA Operation Tools

| Tool | Operation | Policy |
|---|---|---|
| `tiala_services` | Query TIALA service statuses (Ollama, OpenD, bridge, etc.) | safe |
| `tiala_system` | Get CPU/memory/disk/uptime info | safe |
| `tiala_screenshot` | Capture TIALA screen via `screencapture` and send it to Telegram as a JPEG | safe |
| `tiala_restart` | Restart a TIALA service | confirm_required |
| `tiala_exec` | Execute allowlisted command on TIALA | confirm_required |
| `tiala_action` | Perform a GUI action on TIALA (click/type/key/scroll/etc.) | confirm_required |
| `openclaw_agent` | Delegate a task to the OpenClaw agent (Sonnet 5) using exec/browser tools | confirm_required |

TIALA tools use the same 2-step confirmation flow as system ops. They call the OpenClaw Gateway on TIALA (port 18789) via `lib/openclaw.js`, which discovers the URL from BQ `service_endpoints` (service='openclaw').

`openclaw_agent` uses the OpenClaw Gateway `/v1/chat/completions` endpoint. It requires `gateway.http.endpoints.chatCompletions.enabled: true` in `~/.openclaw/openclaw.json`. The docs warn against exposing this endpoint to the public internet; prefer Tailscale/private ingress when possible. Note: screen viewing through this agent requires an OpenClaw `computer` node; for TIALA screen control use `tiala_screenshot` + `tiala_action`.

`tiala_screenshot` and `tiala_action` no longer require a paired OpenClaw `computer` node. They use `exec` on the gateway host to run macOS `screencapture` and `osascript` / `cliclick`. The full screenshot base64 is cached in `lib/tiala.js` and sent to the Telegram chat by `handleAka1Chat` after the LLM response.

When testing TIALA tools:
1. Without `openclaw` in BQ, `tiala_services`/`tiala_system`/`tiala_screenshot` throw "OpenClaw URL not found in service_endpoints" — test this error path
2. `tiala_restart`/`tiala_exec`/`tiala_action`/`openclaw_agent` without `confirmed` return `{status: 'confirmation_required'}` — this works without network access
3. Policy engine: `tiala_restart(opend)` is HIGH RISK (danger message about trade connection), `tiala_exec(git pull)` and `tiala_exec(ollama pull ...)` are HIGH RISK
4. **Never call `tiala_restart`, `tiala_exec`, `tiala_action`, or `openclaw_agent` with `confirmed=true` against real TIALA** — this would restart services, execute commands, control the GUI, or run an autonomous agent on the production Mac mini
5. `/help` should show a TIALA操作 section with examples
6. URL cache TTL is 1 minute in `lib/openclaw.js` — if testing repeated calls, be aware of caching

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
- `OPENCLAW_GATEWAY_TOKEN` — Bearer token for the OpenClaw Gateway on TIALA (only needed for live OpenClaw tool tests)
- `SAKANA_API_KEY` — Only needed if testing the full AKA-1 Sakana loop (not needed for routing tests or tool testing)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — Only needed for live Telegram testing
