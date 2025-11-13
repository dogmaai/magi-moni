-- エラーログテーブル
-- Error log table

CREATE TABLE IF NOT EXISTS `magi_monitoring.errors` (
  -- タイムスタンプ
  timestamp TIMESTAMP NOT NULL OPTIONS(description="エラー発生時刻 / Error occurrence timestamp"),
  
  -- エラー識別情報
  error_id STRING OPTIONS(description="エラーID（ユニーク識別子）/ Error ID (unique identifier)"),
  error_type STRING NOT NULL OPTIONS(description="エラータイプ / Error type"),
  error_code STRING OPTIONS(description="エラーコード / Error code"),
  
  -- エラー詳細
  error_message STRING OPTIONS(description="エラーメッセージ / Error message"),
  error_stack_trace TEXT OPTIONS(description="スタックトレース / Stack trace"),
  severity STRING NOT NULL OPTIONS(description="重大度 (critical, error, warning) / Severity level"),
  
  -- ソース情報
  source_service STRING OPTIONS(description="エラー発生サービス / Source service"),
  source_instance STRING OPTIONS(description="エラー発生インスタンス / Source instance"),
  source_region STRING OPTIONS(description="エラー発生リージョン / Source region"),
  source_function STRING OPTIONS(description="エラー発生関数・メソッド / Source function/method"),
  source_file STRING OPTIONS(description="エラー発生ファイル / Source file"),
  source_line INT64 OPTIONS(description="エラー発生行番号 / Source line number"),
  
  -- コンテキスト情報
  user_id STRING OPTIONS(description="ユーザーID / User ID"),
  request_id STRING OPTIONS(description="リクエストID / Request ID"),
  session_id STRING OPTIONS(description="セッションID / Session ID"),
  
  -- 追加情報
  environment STRING OPTIONS(description="環境 (production, staging, development) / Environment"),
  tags ARRAY<STRING> OPTIONS(description="タグ / Tags"),
  metadata JSON OPTIONS(description="追加メタデータ / Additional metadata"),
  
  -- 状態管理
  is_resolved BOOL DEFAULT FALSE OPTIONS(description="解決済みフラグ / Resolution flag"),
  resolved_at TIMESTAMP OPTIONS(description="解決時刻 / Resolution timestamp"),
  resolved_by STRING OPTIONS(description="解決者 / Resolved by"),
  
  -- データ管理
  ingestion_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP() OPTIONS(description="データ取り込み時刻 / Data ingestion timestamp")
)
PARTITION BY TIMESTAMP_TRUNC(timestamp, DAY)
CLUSTER BY severity, source_service, error_type
OPTIONS(
  description="エラーログデータ / Error log data",
  partition_expiration_days=90,
  require_partition_filter=true
);
