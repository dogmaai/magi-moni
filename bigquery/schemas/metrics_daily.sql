-- 日次集計メトリクステーブル
-- Daily aggregated metrics table

CREATE TABLE IF NOT EXISTS `magi_monitoring.metrics_daily` (
  -- 日付
  date DATE NOT NULL OPTIONS(description="集計日付 / Aggregation date"),
  
  -- メトリクス識別情報
  metric_name STRING NOT NULL OPTIONS(description="メトリクス名 / Metric name"),
  metric_type STRING NOT NULL OPTIONS(description="メトリクスタイプ / Metric type"),
  
  -- 集計値
  value_avg FLOAT64 OPTIONS(description="平均値 / Average value"),
  value_min FLOAT64 OPTIONS(description="最小値 / Minimum value"),
  value_max FLOAT64 OPTIONS(description="最大値 / Maximum value"),
  value_sum FLOAT64 OPTIONS(description="合計値 / Sum value"),
  value_count INT64 OPTIONS(description="データポイント数 / Number of data points"),
  value_stddev FLOAT64 OPTIONS(description="標準偏差 / Standard deviation"),
  
  -- パーセンタイル
  value_p50 FLOAT64 OPTIONS(description="50パーセンタイル（中央値）/ 50th percentile (median)"),
  value_p95 FLOAT64 OPTIONS(description="95パーセンタイル / 95th percentile"),
  value_p99 FLOAT64 OPTIONS(description="99パーセンタイル / 99th percentile"),
  
  -- 日次トレンド情報
  trend_direction STRING OPTIONS(description="トレンド方向 (up, down, stable) / Trend direction"),
  trend_percentage FLOAT64 OPTIONS(description="前日比変化率 / Percentage change from previous day"),
  
  -- ラベル・タグ
  labels ARRAY<STRUCT<
    key STRING,
    value STRING
  >> OPTIONS(description="メトリクスラベル / Metric labels"),
  
  -- ソース情報
  source_service STRING OPTIONS(description="ソースサービス名 / Source service name"),
  source_region STRING OPTIONS(description="ソースリージョン / Source region"),
  
  -- データ管理
  aggregated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP() OPTIONS(description="集計実行時刻 / Aggregation execution timestamp")
)
PARTITION BY date
CLUSTER BY metric_name, source_service
OPTIONS(
  description="日次集計メトリクスデータ / Daily aggregated metrics data",
  partition_expiration_days=730,
  require_partition_filter=true
);
