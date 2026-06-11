---
name: testing-magi-moni
description: Test AKA-1 Telegram bot tools locally against real BigQuery and MooMoo APIs. Use when verifying new AKA-1 tools, BigQuery query changes, or MooMoo proxy integration.
---

# Testing magi-moni (AKA-1)

## Overview

magi-moni is a Cloud Run **service** (not a job) running an Express server with:
- Telegram bot webhook for slash commands and natural language chat (AKA-1)
- AKA-1 uses Claude Fable 5 (default, configurable via `AKA1_MODEL` env var) with tool calling to query BigQuery and MooMoo
- Gemini fallback when Claude is unavailable (non-sticky: always tries Claude first)
- Pub/Sub endpoint for trade result ingestion

## Claude Fable 5 — Mythos-class Model (超高額注意)

AKA-1 のデフォルト LLM は `claude-fable-5` で、Anthropic の最上位クラス「Mythos」に属する。

### 料金比較 (2026年6月時点)

| モデル | クラス | Input $/MTok | Output $/MTok | 備考 |
|---|---|---|---|---|
| **Claude Fable 5** | **Mythos** | **$10** | **$50** | AKA-1 デフォルト。最高性能・最高額 |
| Claude Opus 4.8 | Opus | $5 | $25 | Fable の半額。セーフガード発動時のフォールバック先 |
| Claude Sonnet 4.6 | Sonnet | $3 | $15 | バランス型 |
| Claude Haiku 4.5 | Haiku | $1 | $5 | 最安。Fable の1/10 |
| Gemini 2.5 Flash | — | 低コスト | 低コスト | AKA-1 の Claude 失敗時フォールバック |

### Fable 5 の機能・特性

- **Fable 5 = Mythos 5 と同じ基盤モデル** + 安全ガードレール（サイバーセキュリティ/バイオ領域は Opus 4.8 にフォールバック）
- 長時間・複雑タスクほど他モデルとの差が拡大（短い質問では差が少ない）
- SWE-Bench Pro 80.3%（+11pt）、FrontierCode 全モデルトップ
- 金融分析: Hebbia Finance Benchmark 最高スコア、IMC トレーディング分析評価ほぼ全項目トップ
- Vision SOTA、1M トークンコンテキスト
- トークン効率が高く、少ないターンでタスク完了 → 単価2倍でも実コストは近づく場合あり
- Prompt caching で input 90% 割引可能

### コスト管理の注意

- **Fable はチャット応答専用** — ユーザーが AKA-1 に自然言語で話しかけた時だけ課金
- スラッシュコマンド (`/status`, `/wr`, `/jobs`, `/today`, `/llm`, `/help`) は Claude を呼ばない
- Cloud Scheduler 定期実行 (`/report/daily`, `/report/weekly`) でも Fable を呼ばない
- 他の Cloud Run サービス/ジョブ (magi-core, magi-stg, magi-ac 等) では Fable 未使用
- **テスト時に実 ANTHROPIC_API_KEY で自然言語チャットを何度も送ると課金が発生するため注意**
- `AKA1_MODEL` を変更する際は料金差を必ず確認すること

## Environment Setup

```bash
cd ~/repos/magi-moni
npm install
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcp-key.json
```

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

### Webhook Simulation Testing (Model Config / LLM Path)

To verify model configuration changes or LLM routing without needing real API keys:

```bash
# Start server with dummy keys
PORT=8090 ANTHROPIC_API_KEY=dummy_test_key TELEGRAM_CHAT_ID=12345 \
  TELEGRAM_BOT_TOKEN=dummy_bot_token \
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcp-key.json \
  node server.js

# Test /llm command — verify model name in output
curl -s -X POST http://localhost:8090/webhook/telegram \
  -H 'Content-Type: application/json' \
  -d '{"message":{"chat":{"id":12345},"text":"/llm"}}'
# Server log should show: [BOT] Command: /llm

# Test natural language — verify Claude path is attempted
curl -s -X POST http://localhost:8090/webhook/telegram \
  -H 'Content-Type: application/json' \
  -d '{"message":{"chat":{"id":12345},"text":"今日の取引は？"}}'
# Server log should show the Anthropic API call attempt with the configured model
# Expected: "invalid x-api-key" error (dummy key), confirming Claude path was taken
```

Telegram message content won't be visible with dummy bot tokens (status 404). Verify message text via source code analysis or temporary `console.log` instrumentation.

Note: model names may include provider prefixes (e.g. `anthropic/claude-haiku-4-5-20251001`); server.js strips `anthropic/` and `google/` prefixes at startup. Verify the startup log line `[AKA-1] Primary model: ... | Fallback: ...` shows the bare model names.

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
1. Verify `/llm` command output shows correct model ID
2. Verify `/help` text references correct model name
3. Verify natural language path attempts the correct model via server logs
4. Check function names and comments are consistent with model name

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
- `ANTHROPIC_API_KEY` — Only needed if testing the full AKA-1 LLM loop (not needed for individual tool testing or webhook simulation). **注意: Fable 5 は超高額 ($10/$50 per MTok) のため、テスト回数を最小限に**
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — Only needed for live Telegram testing
