-- アラート履歴テーブル
-- Alert history table

CREATE TABLE IF NOT EXISTS `magi_monitoring.alerts_history` (
  -- タイムスタンプ
  timestamp TIMESTAMP NOT NULL OPTIONS(description="アラート発生時刻 / Alert trigger timestamp"),
  
  -- アラート識別情報
  alert_id STRING NOT NULL OPTIONS(description="アラートID（ユニーク識別子）/ Alert ID (unique identifier)"),
  alert_name STRING NOT NULL OPTIONS(description="アラート名 / Alert name"),
  alert_type STRING NOT NULL OPTIONS(description="アラートタイプ / Alert type"),
  
  -- アラート詳細
  severity STRING NOT NULL OPTIONS(description="重大度 (critical, high, medium, low, info) / Severity level"),
  status STRING NOT NULL OPTIONS(description="ステータス (firing, resolved, acknowledged) / Status"),
  description TEXT OPTIONS(description="アラート説明 / Alert description"),
  
  -- トリガー情報
  trigger_condition STRING OPTIONS(description="トリガー条件 / Trigger condition"),
  trigger_value FLOAT64 OPTIONS(description="トリガー時の値 / Trigger value"),
  threshold_value FLOAT64 OPTIONS(description="閾値 / Threshold value"),
  
  -- メトリクス情報
  metric_name STRING OPTIONS(description="関連メトリクス名 / Related metric name"),
  metric_value FLOAT64 OPTIONS(description="メトリクス値 / Metric value"),
  
  -- ソース情報
  source_service STRING OPTIONS(description="ソースサービス名 / Source service name"),
  source_instance STRING OPTIONS(description="ソースインスタンスID / Source instance ID"),
  source_region STRING OPTIONS(description="ソースリージョン / Source region"),
  
  -- 通知情報
  notification_channels ARRAY<STRING> OPTIONS(description="通知チャンネル / Notification channels"),
  notified_at TIMESTAMP OPTIONS(description="通知送信時刻 / Notification sent timestamp"),
  notification_status STRING OPTIONS(description="通知状態 (sent, failed, pending) / Notification status"),
  
  -- 対応情報
  acknowledged_at TIMESTAMP OPTIONS(description="確認時刻 / Acknowledgment timestamp"),
  acknowledged_by STRING OPTIONS(description="確認者 / Acknowledged by"),
  resolved_at TIMESTAMP OPTIONS(description="解決時刻 / Resolution timestamp"),
  resolved_by STRING OPTIONS(description="解決者 / Resolved by"),
  resolution_notes TEXT OPTIONS(description="解決メモ / Resolution notes"),
  
  -- タグ・ラベル
  tags ARRAY<STRING> OPTIONS(description="タグ / Tags"),
  labels ARRAY<STRUCT<
    key STRING,
    value STRING
  >> OPTIONS(description="ラベル / Labels"),
  
  -- 関連情報
  related_alerts ARRAY<STRING> OPTIONS(description="関連アラートID / Related alert IDs"),
  incident_id STRING OPTIONS(description="インシデントID / Incident ID"),
  runbook_url STRING OPTIONS(description="ランブックURL / Runbook URL"),
  
  -- 追加情報
  metadata JSON OPTIONS(description="追加メタデータ / Additional metadata"),
  
  -- データ管理
  ingestion_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP() OPTIONS(description="データ取り込み時刻 / Data ingestion timestamp")
)
PARTITION BY TIMESTAMP_TRUNC(timestamp, DAY)
CLUSTER BY severity, status, source_service
OPTIONS(
  description="アラート履歴データ / Alert history data",
  partition_expiration_days=365,
  require_partition_filter=true
);
