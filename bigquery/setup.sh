#!/bin/bash
# BigQuery テーブル作成スクリプト
# Script to create all BigQuery tables for magi_monitoring

set -e  # エラーが発生したら終了

DATASET_NAME="magi_monitoring"
LOCATION="us"
SCHEMA_DIR="$(dirname "$0")/schemas"

echo "================================================"
echo "Magi Monitoring - BigQuery Setup"
echo "================================================"
echo ""

# データセットが存在するか確認
echo "Checking if dataset exists..."
if bq ls -d | grep -q "$DATASET_NAME"; then
    echo "✓ Dataset '$DATASET_NAME' already exists"
else
    echo "Creating dataset '$DATASET_NAME'..."
    bq mk --dataset --location="$LOCATION" \
        --description="Magi Monitoring Dataset" \
        "$DATASET_NAME"
    echo "✓ Dataset created"
fi

echo ""
echo "Creating tables..."
echo ""

# テーブルを作成
tables=(
    "metrics_realtime:リアルタイムメトリクス"
    "metrics_hourly:時間別集計"
    "metrics_daily:日次集計"
    "errors:エラーログ"
    "api_costs:APIコスト"
    "alerts_history:アラート履歴"
)

for table_info in "${tables[@]}"; do
    IFS=':' read -r table_name table_desc <<< "$table_info"
    schema_file="$SCHEMA_DIR/${table_name}.sql"
    
    echo "Creating table: $table_name ($table_desc)"
    
    if [ -f "$schema_file" ]; then
        if bq query --use_legacy_sql=false < "$schema_file"; then
            echo "✓ Table '$table_name' created successfully"
        else
            echo "✗ Failed to create table '$table_name'"
            exit 1
        fi
    else
        echo "✗ Schema file not found: $schema_file"
        exit 1
    fi
    echo ""
done

echo "================================================"
echo "✓ All tables created successfully!"
echo "================================================"
echo ""
echo "Dataset: $DATASET_NAME"
echo "Location: $LOCATION"
echo ""
echo "You can now start inserting data into the tables."
echo "See README.md for example queries and usage."
