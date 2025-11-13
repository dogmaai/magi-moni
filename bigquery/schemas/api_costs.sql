-- APIコストテーブル
-- API cost tracking table

CREATE TABLE IF NOT EXISTS `magi_monitoring.api_costs` (
  -- タイムスタンプ
  timestamp TIMESTAMP NOT NULL OPTIONS(description="コスト記録時刻 / Cost recording timestamp"),
  
  -- API識別情報
  api_name STRING NOT NULL OPTIONS(description="API名 / API name"),
  api_version STRING OPTIONS(description="APIバージョン / API version"),
  api_provider STRING OPTIONS(description="APIプロバイダー (OpenAI, Anthropic, Google, AWS, etc.) / API provider"),
  
  -- エンドポイント情報
  endpoint STRING OPTIONS(description="APIエンドポイント / API endpoint"),
  method STRING OPTIONS(description="HTTPメソッド / HTTP method"),
  
  -- コスト情報
  cost_amount FLOAT64 NOT NULL OPTIONS(description="コスト金額 / Cost amount"),
  cost_currency STRING DEFAULT 'USD' OPTIONS(description="通貨 / Currency"),
  
  -- 使用量情報
  usage_quantity FLOAT64 OPTIONS(description="使用量 / Usage quantity"),
  usage_unit STRING OPTIONS(description="使用単位 (tokens, requests, GB, hours, etc.) / Usage unit"),
  
  -- トークン情報（LLM APIの場合）
  tokens_input INT64 OPTIONS(description="入力トークン数 / Input tokens"),
  tokens_output INT64 OPTIONS(description="出力トークン数 / Output tokens"),
  tokens_total INT64 OPTIONS(description="合計トークン数 / Total tokens"),
  
  -- モデル情報（LLM APIの場合）
  model_name STRING OPTIONS(description="モデル名 / Model name"),
  model_tier STRING OPTIONS(description="モデルティア / Model tier"),
  
  -- リクエスト情報
  request_id STRING OPTIONS(description="リクエストID / Request ID"),
  request_duration_ms FLOAT64 OPTIONS(description="リクエスト処理時間（ミリ秒）/ Request duration in milliseconds"),
  request_status STRING OPTIONS(description="リクエスト状態 (success, error) / Request status"),
  
  -- ソース情報
  source_service STRING OPTIONS(description="呼び出し元サービス / Source service"),
  source_instance STRING OPTIONS(description="呼び出し元インスタンス / Source instance"),
  source_region STRING OPTIONS(description="呼び出し元リージョン / Source region"),
  
  -- コンテキスト情報
  user_id STRING OPTIONS(description="ユーザーID / User ID"),
  organization_id STRING OPTIONS(description="組織ID / Organization ID"),
  project_id STRING OPTIONS(description="プロジェクトID / Project ID"),
  
  -- タグ・ラベル
  tags ARRAY<STRING> OPTIONS(description="タグ / Tags"),
  labels ARRAY<STRUCT<
    key STRING,
    value STRING
  >> OPTIONS(description="ラベル / Labels"),
  
  -- 追加情報
  metadata JSON OPTIONS(description="追加メタデータ / Additional metadata"),
  
  -- データ管理
  ingestion_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP() OPTIONS(description="データ取り込み時刻 / Data ingestion timestamp")
)
PARTITION BY TIMESTAMP_TRUNC(timestamp, DAY)
CLUSTER BY api_provider, api_name, source_service
OPTIONS(
  description="APIコスト追跡データ / API cost tracking data",
  partition_expiration_days=730,
  require_partition_filter=true
);
