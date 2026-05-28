---
name: testing-magi-moni
description: Test AKA-1 Telegram bot tools locally against real BigQuery and MooMoo APIs. Use when verifying new AKA-1 tools, BigQuery query changes, or MooMoo proxy integration.
---

# Testing magi-moni (AKA-1)

## Overview

magi-moni is a Cloud Run **service** (not a job) running an Express server with:
- Telegram bot webhook for slash commands and natural language chat (AKA-1)
- AKA-1 uses Claude 3.5 Haiku with tool calling to query BigQuery and MooMoo
- Pub/Sub endpoint for trade result ingestion

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

## Deployment

magi-moni is deployed as a Cloud Run **service** (not job):
```bash
gcloud run services update magi-moni --region=asia-northeast1 --project=screen-share-459802 --image=<image>
```

Deploy is done by Jun manually via Cloud Shell after PR merge.

## Devin Secrets Needed

- `GOOGLE_APPLICATION_CREDENTIALS` — GCP service account key for BigQuery access
- `ANTHROPIC_API_KEY` — Only needed if testing the full AKA-1 LLM loop (not needed for individual tool testing)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — Only needed for live Telegram testing
