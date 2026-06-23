# Magi-Moni - MAGI System 監視・ログ管理

MAGI System 全体の監視、ログ、アラート管理を行う Infrastructure as Code リポジトリ。

## 🎯 機能

- ✅ Cloud Run (magi-core) 監視
- ✅ BigQuery (magi-stg) 監視
- ✅ Cloud Functions (magi-ac) 監視
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

3. **magi-ac** (Analytics)
   - 実行時間、エラー、メモリ
   - 間隔: 1分

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

## 🤖 Telegram bot エージェント

Telegram webhook (`POST /webhook/telegram`) は 2 種類のメッセージを受け付ける:

1. **Slash コマンド** (`/status` `/wr` `/jobs` `/today` `/help`)
   - 固定 BigQuery クエリを叩いて整形済みテキストを返す（従来機能）

2. **自然文** → **AKA-1 (Sakana AI fugu-ultra primary, Ollama/Gemini fallback) + tool calling**
   - 認可: `TELEGRAM_CHAT_ID` と一致する chat のみ応答
   - 利用ツール (読み取り専用):
     - `get_today_trades` — 本日の取引一覧
     - `get_winrate_by_llm` — LLM × 方向別勝率（過去 N 日）
     - `get_daily_summary` — 指定日のサマリー
     - `get_l4_probation` — L4 プロベーション状態
   - 任意 SQL は意図的に未公開（事前定義クエリのみ）
   - 仕様参照: [`dogmaai/magi-stg`](https://github.com/dogmaai/magi-stg) の `MEMORY.md` / `specifications/system/overview.md`

### 必要な環境変数

| 名前 | 用途 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot 認証 |
| `TELEGRAM_CHAT_ID` | 応答先・認可元の Telegram chat ID |
| `SAKANA_API_KEY` | AKA-1 プライマリ LLM (Sakana AI fugu-ultra) |
| `SAKANA_MODEL` | 任意。デフォルト `fugu-ultra` |
| `OLLAMA_BASE_URL` | Fallback 1: Ollama (TIALA local Qwen) エンドポイント |
| `OLLAMA_MODEL` | 任意。デフォルト `qwen2.5:14b` |
| `GEMINI_API_KEY` | Fallback 2: Gemini |
| `PROJECT_ID` | GCP project (default: `screen-share-459802`) |

## 📈 SLA 目標

- 可用性: 99.9%
- レスポンス時間 (P99): < 3秒
- エラー率: < 0.1%

## 🔗 リンク

- [magi-core](https://github.com/miroqu369/magi-core)
- [magi-stg](https://github.com/miroqu369/magi-stg)
- [magi-ac](https://github.com/miroqu369/magi-ac)
- [magi-ui](https://github.com/miroqu369/magi-ui)

