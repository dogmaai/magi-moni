# BigQuery Monitoring Schema

このディレクトリには、magi-moniモニタリングシステムのBigQueryスキーマ定義が含まれています。

This directory contains the BigQuery schema definitions for the magi-moni monitoring system.

## スキーマ概要 / Schema Overview

### データセット名 / Dataset Name
`magi_monitoring`

### テーブル構成 / Table Structure

```
BigQuery: magi_monitoring
├── metrics_realtime     # リアルタイムメトリクス（1分粒度）
├── metrics_hourly       # 時間別集計
├── metrics_daily        # 日次集計
├── errors               # エラーログ
├── api_costs            # APIコスト
└── alerts_history       # アラート履歴
```

## テーブル詳細 / Table Details

### 1. metrics_realtime
**リアルタイムメトリクステーブル（1分粒度）**

リアルタイムで収集されるメトリクスデータを格納します。

- **パーティション**: 日次（`timestamp`フィールド）
- **クラスター**: `metric_name`, `source_service`
- **保持期間**: 7日間
- **主要フィールド**:
  - `timestamp`: メトリクス収集時刻
  - `metric_name`: メトリクス名
  - `metric_type`: メトリクスタイプ (counter, gauge, histogram)
  - `value`: メトリクス値
  - `labels`: メトリクスラベル（構造化配列）
  - `source_service`: ソースサービス名

### 2. metrics_hourly
**時間別集計メトリクステーブル**

時間単位で集計されたメトリクスデータを格納します。

- **パーティション**: 月次（`hour`フィールド）
- **クラスター**: `metric_name`, `source_service`
- **保持期間**: 365日間
- **主要フィールド**:
  - `hour`: 集計時刻（時間単位）
  - `value_avg`, `value_min`, `value_max`: 統計値
  - `value_p50`, `value_p95`, `value_p99`: パーセンタイル値

### 3. metrics_daily
**日次集計メトリクステーブル**

日単位で集計されたメトリクスデータを格納します。

- **パーティション**: 日次（`date`フィールド）
- **クラスター**: `metric_name`, `source_service`
- **保持期間**: 730日間（2年）
- **主要フィールド**:
  - `date`: 集計日付
  - `trend_direction`: トレンド方向
  - `trend_percentage`: 前日比変化率

### 4. errors
**エラーログテーブル**

アプリケーションエラーとログを格納します。

- **パーティション**: 日次（`timestamp`フィールド）
- **クラスター**: `severity`, `source_service`, `error_type`
- **保持期間**: 90日間
- **主要フィールド**:
  - `timestamp`: エラー発生時刻
  - `error_type`: エラータイプ
  - `error_message`: エラーメッセージ
  - `severity`: 重大度 (critical, error, warning)
  - `error_stack_trace`: スタックトレース
  - `is_resolved`: 解決済みフラグ

### 5. api_costs
**APIコストテーブル**

API使用量とコストを追跡します。

- **パーティション**: 日次（`timestamp`フィールド）
- **クラスター**: `api_provider`, `api_name`, `source_service`
- **保持期間**: 730日間（2年）
- **主要フィールド**:
  - `timestamp`: コスト記録時刻
  - `api_name`: API名
  - `api_provider`: APIプロバイダー (OpenAI, Anthropic, Google, AWS, etc.)
  - `cost_amount`: コスト金額
  - `tokens_input`, `tokens_output`: トークン数（LLM API用）
  - `model_name`: モデル名

### 6. alerts_history
**アラート履歴テーブル**

アラートの発生と解決履歴を格納します。

- **パーティション**: 日次（`timestamp`フィールド）
- **クラスター**: `severity`, `status`, `source_service`
- **保持期間**: 365日間
- **主要フィールド**:
  - `timestamp`: アラート発生時刻
  - `alert_name`: アラート名
  - `severity`: 重大度
  - `status`: ステータス (firing, resolved, acknowledged)
  - `trigger_condition`: トリガー条件
  - `notification_channels`: 通知チャンネル

## セットアップ / Setup

### 1. データセットの作成 / Create Dataset

```bash
bq mk --dataset --location=us \
  --description="Magi Monitoring Dataset" \
  magi_monitoring
```

### 2. テーブルの作成 / Create Tables

各スキーマファイルを実行してテーブルを作成します：

```bash
# リアルタイムメトリクス
bq query --use_legacy_sql=false < schemas/metrics_realtime.sql

# 時間別集計
bq query --use_legacy_sql=false < schemas/metrics_hourly.sql

# 日次集計
bq query --use_legacy_sql=false < schemas/metrics_daily.sql

# エラーログ
bq query --use_legacy_sql=false < schemas/errors.sql

# APIコスト
bq query --use_legacy_sql=false < schemas/api_costs.sql

# アラート履歴
bq query --use_legacy_sql=false < schemas/alerts_history.sql
```

または、一括で実行：

```bash
for schema in schemas/*.sql; do
  echo "Creating table from $schema"
  bq query --use_legacy_sql=false < "$schema"
done
```

## クエリ例 / Example Queries

### リアルタイムメトリクスの取得
```sql
SELECT 
  timestamp,
  metric_name,
  value,
  source_service
FROM `magi_monitoring.metrics_realtime`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND metric_name = 'cpu_usage'
ORDER BY timestamp DESC
LIMIT 100;
```

### エラーの集計
```sql
SELECT 
  DATE(timestamp) as date,
  severity,
  source_service,
  COUNT(*) as error_count
FROM `magi_monitoring.errors`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY date, severity, source_service
ORDER BY date DESC, error_count DESC;
```

### APIコストの日次サマリー
```sql
SELECT 
  DATE(timestamp) as date,
  api_provider,
  api_name,
  SUM(cost_amount) as total_cost,
  SUM(tokens_total) as total_tokens,
  COUNT(*) as request_count
FROM `magi_monitoring.api_costs`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY date, api_provider, api_name
ORDER BY date DESC, total_cost DESC;
```

### アクティブなアラート
```sql
SELECT 
  alert_name,
  severity,
  status,
  source_service,
  timestamp,
  description
FROM `magi_monitoring.alerts_history`
WHERE status = 'firing'
  AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
ORDER BY severity, timestamp DESC;
```

## データ保持ポリシー / Data Retention Policy

| テーブル | 保持期間 | 理由 |
|---------|---------|------|
| metrics_realtime | 7日 | リアルタイムデータは短期間のみ必要 |
| metrics_hourly | 365日 | 中期的なトレンド分析用 |
| metrics_daily | 730日（2年） | 長期的なトレンド分析用 |
| errors | 90日 | デバッグとトラブルシューティング用 |
| api_costs | 730日（2年） | コスト分析とレポート用 |
| alerts_history | 365日 | 履歴分析とパターン認識用 |

## ベストプラクティス / Best Practices

1. **パーティションフィルタの使用**: すべてのクエリでパーティションフィルタを使用してコストを削減
2. **クラスタリングの活用**: フィルタリングとグループ化でクラスタリングキーを使用
3. **ストリーミング挿入**: リアルタイムデータにはBigQuery Streaming APIを使用
4. **バッチ集計**: 時間別・日次集計はスケジュールされたクエリで実行
5. **コスト最適化**: 不要な列を選択せず、必要な列のみをSELECT

## モニタリングとメンテナンス / Monitoring and Maintenance

- BigQueryのコストとクエリパフォーマンスを定期的に監視
- パーティションの有効期限を確認
- 使用されていないテーブルやパーティションをクリーンアップ
- スキーマの進化に対応するため、後方互換性を維持

## ライセンス / License

このスキーマはmagi-moniプロジェクトの一部です。
