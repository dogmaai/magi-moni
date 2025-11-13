-- BigQuery サンプルクエリ集
-- Example Queries for magi_monitoring

-- ===================================================================
-- 1. リアルタイムメトリクス関連クエリ
-- Real-time Metrics Queries
-- ===================================================================

-- 最新のCPU使用率（直近1時間）
SELECT 
  timestamp,
  metric_name,
  value,
  source_service,
  source_instance
FROM `magi_monitoring.metrics_realtime`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND metric_name = 'cpu_usage'
ORDER BY timestamp DESC
LIMIT 100;

-- サービス別の平均メトリクス値
SELECT 
  source_service,
  metric_name,
  AVG(value) as avg_value,
  MIN(value) as min_value,
  MAX(value) as max_value,
  COUNT(*) as data_points
FROM `magi_monitoring.metrics_realtime`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
GROUP BY source_service, metric_name
ORDER BY source_service, metric_name;

-- ===================================================================
-- 2. 時間別集計メトリクス関連クエリ
-- Hourly Metrics Queries
-- ===================================================================

-- 過去7日間の時間別CPU使用率トレンド
SELECT 
  hour,
  source_service,
  value_avg,
  value_p95,
  value_p99
FROM `magi_monitoring.metrics_hourly`
WHERE hour >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND metric_name = 'cpu_usage'
ORDER BY hour DESC;

-- サービス別の時間帯別負荷パターン
SELECT 
  EXTRACT(HOUR FROM hour) as hour_of_day,
  source_service,
  AVG(value_avg) as avg_value,
  AVG(value_max) as avg_max
FROM `magi_monitoring.metrics_hourly`
WHERE hour >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND metric_name = 'request_count'
GROUP BY hour_of_day, source_service
ORDER BY hour_of_day, source_service;

-- ===================================================================
-- 3. 日次集計メトリクス関連クエリ
-- Daily Metrics Queries
-- ===================================================================

-- 過去30日間の日次トレンド
SELECT 
  date,
  metric_name,
  source_service,
  value_avg,
  trend_direction,
  trend_percentage
FROM `magi_monitoring.metrics_daily`
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
ORDER BY date DESC, metric_name;

-- 急激な変化があったメトリクス
SELECT 
  date,
  metric_name,
  source_service,
  value_avg,
  trend_percentage
FROM `magi_monitoring.metrics_daily`
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  AND ABS(trend_percentage) > 20  -- 20%以上の変化
ORDER BY ABS(trend_percentage) DESC;

-- ===================================================================
-- 4. エラーログ関連クエリ
-- Error Log Queries
-- ===================================================================

-- 最新のエラー一覧
SELECT 
  timestamp,
  severity,
  error_type,
  error_message,
  source_service,
  source_function
FROM `magi_monitoring.errors`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
ORDER BY timestamp DESC
LIMIT 50;

-- エラー種別の集計（過去7日間）
SELECT 
  DATE(timestamp) as date,
  severity,
  error_type,
  source_service,
  COUNT(*) as error_count,
  COUNT(DISTINCT error_id) as unique_errors
FROM `magi_monitoring.errors`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY date, severity, error_type, source_service
ORDER BY date DESC, error_count DESC;

-- 未解決のクリティカルエラー
SELECT 
  error_id,
  timestamp,
  error_type,
  error_message,
  source_service,
  TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), timestamp, MINUTE) as minutes_ago
FROM `magi_monitoring.errors`
WHERE is_resolved = FALSE
  AND severity = 'critical'
ORDER BY timestamp DESC;

-- エラー発生頻度の時系列
SELECT 
  TIMESTAMP_TRUNC(timestamp, HOUR) as hour,
  severity,
  COUNT(*) as error_count
FROM `magi_monitoring.errors`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
GROUP BY hour, severity
ORDER BY hour DESC;

-- ===================================================================
-- 5. APIコスト関連クエリ
-- API Cost Queries
-- ===================================================================

-- 日次コストサマリー
SELECT 
  DATE(timestamp) as date,
  api_provider,
  api_name,
  SUM(cost_amount) as total_cost,
  SUM(tokens_total) as total_tokens,
  COUNT(*) as request_count,
  AVG(request_duration_ms) as avg_duration_ms
FROM `magi_monitoring.api_costs`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY date, api_provider, api_name
ORDER BY date DESC, total_cost DESC;

-- 月次コストトレンド
SELECT 
  FORMAT_TIMESTAMP('%Y-%m', timestamp) as month,
  api_provider,
  SUM(cost_amount) as total_cost,
  COUNT(*) as total_requests
FROM `magi_monitoring.api_costs`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 12 MONTH)
GROUP BY month, api_provider
ORDER BY month DESC, total_cost DESC;

-- 高コストリクエストの検出
SELECT 
  timestamp,
  api_provider,
  api_name,
  model_name,
  cost_amount,
  tokens_total,
  source_service,
  user_id
FROM `magi_monitoring.api_costs`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND cost_amount > 1.0  -- 1ドル以上のリクエスト
ORDER BY cost_amount DESC
LIMIT 100;

-- サービス別コスト配分
SELECT 
  source_service,
  api_provider,
  SUM(cost_amount) as total_cost,
  COUNT(*) as request_count,
  AVG(cost_amount) as avg_cost_per_request
FROM `magi_monitoring.api_costs`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY source_service, api_provider
ORDER BY total_cost DESC;

-- ===================================================================
-- 6. アラート履歴関連クエリ
-- Alert History Queries
-- ===================================================================

-- 現在発火中のアラート
SELECT 
  alert_name,
  severity,
  status,
  source_service,
  timestamp,
  description,
  TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), timestamp, MINUTE) as minutes_firing
FROM `magi_monitoring.alerts_history`
WHERE status = 'firing'
  AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
ORDER BY severity, timestamp DESC;

-- アラート発生頻度の分析
SELECT 
  alert_name,
  severity,
  COUNT(*) as total_alerts,
  COUNT(DISTINCT source_service) as affected_services,
  AVG(TIMESTAMP_DIFF(resolved_at, timestamp, MINUTE)) as avg_resolution_time_minutes
FROM `magi_monitoring.alerts_history`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND resolved_at IS NOT NULL
GROUP BY alert_name, severity
ORDER BY total_alerts DESC;

-- 未確認のアラート
SELECT 
  alert_id,
  alert_name,
  severity,
  status,
  timestamp,
  source_service,
  description
FROM `magi_monitoring.alerts_history`
WHERE acknowledged_at IS NULL
  AND status = 'firing'
ORDER BY severity, timestamp;

-- アラートの時系列トレンド
SELECT 
  DATE(timestamp) as date,
  severity,
  COUNT(*) as alert_count,
  COUNT(DISTINCT alert_name) as unique_alerts,
  AVG(TIMESTAMP_DIFF(resolved_at, timestamp, MINUTE)) as avg_resolution_minutes
FROM `magi_monitoring.alerts_history`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY date, severity
ORDER BY date DESC;

-- ===================================================================
-- 7. クロステーブル分析
-- Cross-table Analysis
-- ===================================================================

-- エラーとアラートの相関
SELECT 
  e.error_type,
  a.alert_name,
  COUNT(*) as correlation_count
FROM `magi_monitoring.errors` e
JOIN `magi_monitoring.alerts_history` a
  ON e.source_service = a.source_service
  AND TIMESTAMP_DIFF(a.timestamp, e.timestamp, MINUTE) BETWEEN 0 AND 5
WHERE e.timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY e.error_type, a.alert_name
ORDER BY correlation_count DESC;

-- コストとメトリクスの関連
SELECT 
  DATE(c.timestamp) as date,
  c.source_service,
  SUM(c.cost_amount) as total_cost,
  AVG(m.value_avg) as avg_cpu_usage
FROM `magi_monitoring.api_costs` c
LEFT JOIN `magi_monitoring.metrics_daily` m
  ON DATE(c.timestamp) = m.date
  AND c.source_service = m.source_service
  AND m.metric_name = 'cpu_usage'
WHERE c.timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY date, c.source_service
ORDER BY date DESC, total_cost DESC;

-- サービス健全性ダッシュボード
SELECT 
  m.source_service,
  AVG(m.value_avg) as avg_cpu_usage,
  COUNT(e.error_id) as error_count,
  COUNT(a.alert_id) as alert_count,
  SUM(c.cost_amount) as total_api_cost
FROM `magi_monitoring.metrics_daily` m
LEFT JOIN `magi_monitoring.errors` e
  ON m.date = DATE(e.timestamp)
  AND m.source_service = e.source_service
LEFT JOIN `magi_monitoring.alerts_history` a
  ON m.date = DATE(a.timestamp)
  AND m.source_service = a.source_service
LEFT JOIN `magi_monitoring.api_costs` c
  ON m.date = DATE(c.timestamp)
  AND m.source_service = c.source_service
WHERE m.date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  AND m.metric_name = 'cpu_usage'
GROUP BY m.source_service
ORDER BY m.source_service;
