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

## 📈 SLA 目標

- 可用性: 99.9%
- レスポンス時間 (P99): < 3秒
- エラー率: < 0.1%

## 🔗 リンク

- [magi-core](https://github.com/miroqu369/magi-core)
- [magi-stg](https://github.com/miroqu369/magi-stg)
- [magi-ac](https://github.com/miroqu369/magi-ac)
- [magi-ui](https://github.com/miroqu369/magi-ui)

