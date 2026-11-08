# Magi-Moni - MAGI System 監視・ログ管理

MAGI System 全体の監視、ログ、アラート管理を行う Infrastructure as Code リポジトリ。

## Discord staged migration

The MAGI operations application is separate from OpenClaw's `aka` Bot. The new
`POST /webhook/discord` endpoint validates Ed25519 signatures over the raw request
body plus timestamp (five-minute freshness limit), then requires the configured
application, Jun user, private guild and private operations channel.

Jun must configure `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`,
`DISCORD_OWNER_ID`, `DISCORD_GUILD_ID`, `DISCORD_OPS_CHANNEL_ID`. Missing values
fail closed. Bot message content intent and Administrator permissions are not
required for these slash commands. `node scripts/register-discord-commands.js`
is dry-run by default; Jun can register commands with `--apply` and a securely
bound `MAGI_DISCORD_BOT_TOKEN` (never the OpenClaw `DISCORD_BOT_TOKEN`). Set the application's
Interactions Endpoint URL to this service's `/webhook/discord` after deployment.

`/ask` preserves AKA-1 read-only tools. Mutating model tool calls can only propose
an immutable operation. Neither an LLM's `confirmed=true` nor a chat reply issues
an approval. Jun must click the matching ephemeral confirmation button within
60 seconds. The approval is actor/guild/channel-bound, consumed before execution,
and never auto-retried. `/kill` directly engages the existing kill switch for
the authenticated operator; `/resume` always requires confirmation. Existing
BigQuery order approval TTL, broker order gate and L0 fail-closed logic are unchanged.

Pending confirmations are intentionally process-local and short-lived: restarts,
deployment, expiry or routing a click to another Cloud Run instance invalidates
them. Discord's one-shot initial callback must succeed before any work or proposal
is created, so duplicate delivery cannot create approvals on another instance.
This favors safety over availability; it is not durable or broker exactly-once
execution. Check the state before proposing a replacement operation after an
uncertain response. Legacy Telegram model mutations now fail closed; explicit
legacy slash commands remain during rollback.

Daily/weekly reports select `NOTIFICATION_TRANSPORT=discord` with a Secret Manager
`DISCORD_WEBHOOK_URL` binding. Missing/invalid Discord configuration does not
fall back to Telegram. Messages are chunked, mentions suppressed, and send failures
fail the report endpoint. The deploy workflow uses `--update-env-vars` so Jun's
Discord configuration is preserved. Disable incoming Telegram and setup routes
with `TELEGRAM_ENABLED=false` **only after live Discord acceptance**; remove
Telegram credentials and code in the retirement phase, not during this PR. The
legacy webhook rejects requests if its token, chat allowlist or webhook secret
is missing, even when the disable flag has not yet been set.
See the authoritative `magi-knowledge/system/services/discord-migration.md`
companion change for acceptance, rollback and teardown gates. Production has
not been switched by this change.

## 🎯 機能

- ✅ Cloud Run (magi-core) 監視
- ✅ BigQuery (magi-stg) 監視
- ⚠️ Cloud Functions (magi-ac) 監視 — アーカイブ済み・監視停止
- ✅ Cloud Logging 集約
- ✅ SLA 追跡
- ✅ アラート通知 (Email/Slack)
- ✅ Terraform IaC

## 📊 監視対象

1. **magi-core** (AI Consensus Engine)
   - レスポンス時間、エラー率、CPU/メモリ
   - 間隔: 30秒

2. **magi-stg** (BigQuery)
   - テーブルヘルス、クエリ性能
   - 間隔: 5分

3. **magi-ac** (Analytics) — ⚠️ アーカイブ済み（`miroqu369/magi-ac` public archive）・監視停止
   - `enabled: false` に設定済み（旧: 実行時間・エラー・メモリ、間隔 1分）

4. **magi-ui** (UI)
   - レスポンス時間、可用性
   - 間隔: 1分

5. **Cloud Logging**
   - エラー/警告ログ集約
   - 間隔: 5分

## 🚀 クイックスタート
```bash
# 設定確認
cat monitoring/config.yaml

# Terraform 初期化
cd terraform
terraform init
terraform plan
terraform apply
```

## 📁 ファイル構成
```
magi-moni/
├── monitoring/
│   └── config.yaml          # 監視設定
├── terraform/               # IaC
├── scripts/                 # ユーティリティ
└── docs/                    # ドキュメント
```

## 🔔 通知チャネル

- **Email**: devops@example.com
- **Slack**: #magi-alerts, #magi-critical
- **SMS**: CRITICAL アラートのみ (オプション)
- **Telegram**: `@magi_claw_bot` 経由 (`POST /webhook/telegram`)
  - `@magi_trading_bot` は現在未使用

## 🤖 Telegram bot エージェント

Telegram webhook (`POST /webhook/telegram`) は 2 種類のメッセージを受け付ける:

1. **Slash コマンド** (`/status` `/wr` `/jobs` `/today` `/help`)
   - 固定 BigQuery クエリを叩いて整形済みテキストを返す（従来機能）

2. **自然文** → **AKA-1 (Gemini `gemini-3.8-flash`) + tool calling**
   - 認可: `TELEGRAM_CHAT_ID` と一致する chat のみ応答
   - 利用ツール (読み取り専用):
     - `get_today_trades` — 本日の取引一覧
     - `get_winrate_by_llm` — LLM × 方向別勝率（過去 N 日）
     - `get_daily_summary` — 指定日のサマリー
     - `get_l4_status` — L4（方向適性層, warn-only）の警告状況
   - 任意 SQL は意図的に未公開（事前定義クエリのみ）
   - 仕様参照: [`dogmaai/magi-knowledge`](https://github.com/dogmaai/magi-knowledge) の `index.md` / `system/services/magi-moni.md`（`dogmaai/magi-stg` はアーカイブ済み・仕様参照禁止。BigQuery `magi-stg` データセット監視は稼働対象として継続）

### 必要な環境変数

| 名前 | 用途 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot 認証 |
| `TELEGRAM_CHAT_ID` | 応答先・認可元の Telegram chat ID |
| `GEMINI_API_KEY` | AKA-1 LLM (Gemini) |
| `GEMINI_MODEL` | 任意。デフォルト `gemini-3.8-flash` |
| `PROJECT_ID` | GCP project (default: `screen-share-459802`) |

## 📈 SLA 目標

- 可用性: 99.9%
- レスポンス時間 (P99): < 3秒
- エラー率: < 0.1%

## 🔗 リンク

- [magi-core](https://github.com/miroqu369/magi-core)
- [magi-stg](https://github.com/miroqu369/magi-stg)
- [magi-ac](https://github.com/miroqu369/magi-ac) — ⚠️ アーカイブ済み・監視停止
- [magi-ui](https://github.com/miroqu369/magi-ui)
