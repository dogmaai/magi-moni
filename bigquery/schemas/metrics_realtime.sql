-- リアルタイムメトリクステーブル（1分粒度）
-- Real-time metrics table with 1-minute granularity

CREATE TABLE IF NOT EXISTS `magi_monitoring.metrics_realtime` (
  -- タイムスタンプ
  timestamp TIMESTAMP NOT NULL OPTIONS(description="メトリクス収集時刻 / Metric collection timestamp"),
  
  -- メトリクス識別情報
  metric_name STRING NOT NULL OPTIONS(description="メトリクス名 / Metric name"),
  metric_type STRING NOT NULL OPTIONS(description="メトリクスタイプ (counter, gauge, histogram) / Metric type"),
  
  -- メトリクス値
  value FLOAT64 OPTIONS(description="メトリクス値 / Metric value"),
  
  -- ラベル・タグ
  labels ARRAY<STRUCT<
    key STRING,
    value STRING
  >> OPTIONS(description="メトリクスラベル / Metric labels"),
  
  -- ソース情報
  source_service STRING OPTIONS(description="ソースサービス名 / Source service name"),
  source_instance STRING OPTIONS(description="ソースインスタンスID / Source instance ID"),
  source_region STRING OPTIONS(description="ソースリージョン / Source region"),
  
  -- 追加情報
  unit STRING OPTIONS(description="メトリクス単位 / Metric unit"),
  metadata JSON OPTIONS(description="追加メタデータ / Additional metadata"),
  
  -- データ管理
  ingestion_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP() OPTIONS(description="データ取り込み時刻 / Data ingestion timestamp")
)
PARTITION BY TIMESTAMP_TRUNC(timestamp, DAY)
CLUSTER BY metric_name, source_service
OPTIONS(
  description="リアルタイムメトリクスデータ（1分粒度）/ Real-time metrics data with 1-minute granularity",
  partition_expiration_days=7,
  require_partition_filter=true
);
