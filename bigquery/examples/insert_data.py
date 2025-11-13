"""
BigQuery データ挿入サンプル
Example script for inserting data into magi_monitoring BigQuery tables
"""

from google.cloud import bigquery
from datetime import datetime, timedelta
import random

# BigQuery クライアントの初期化
client = bigquery.Client()
dataset_name = "magi_monitoring"


def insert_realtime_metrics():
    """リアルタイムメトリクスの挿入例"""
    table_id = f"{dataset_name}.metrics_realtime"
    
    rows_to_insert = [
        {
            "timestamp": datetime.utcnow().isoformat(),
            "metric_name": "cpu_usage",
            "metric_type": "gauge",
            "value": random.uniform(20.0, 80.0),
            "labels": [
                {"key": "environment", "value": "production"},
                {"key": "region", "value": "us-west-1"}
            ],
            "source_service": "api-server",
            "source_instance": "api-server-01",
            "source_region": "us-west-1",
            "unit": "percent",
        },
        {
            "timestamp": datetime.utcnow().isoformat(),
            "metric_name": "memory_usage",
            "metric_type": "gauge",
            "value": random.uniform(40.0, 90.0),
            "labels": [
                {"key": "environment", "value": "production"},
                {"key": "region", "value": "us-west-1"}
            ],
            "source_service": "api-server",
            "source_instance": "api-server-01",
            "source_region": "us-west-1",
            "unit": "percent",
        }
    ]
    
    errors = client.insert_rows_json(table_id, rows_to_insert)
    if errors == []:
        print(f"✓ Inserted {len(rows_to_insert)} rows into {table_id}")
    else:
        print(f"✗ Errors inserting rows: {errors}")


def insert_error_log():
    """エラーログの挿入例"""
    table_id = f"{dataset_name}.errors"
    
    rows_to_insert = [
        {
            "timestamp": datetime.utcnow().isoformat(),
            "error_id": f"err_{int(datetime.utcnow().timestamp())}",
            "error_type": "DatabaseConnectionError",
            "error_code": "DB_CONN_TIMEOUT",
            "error_message": "Failed to connect to database after 30 seconds",
            "severity": "error",
            "source_service": "api-server",
            "source_instance": "api-server-01",
            "source_region": "us-west-1",
            "source_function": "connect_to_database",
            "environment": "production",
            "tags": ["database", "connection", "timeout"],
            "is_resolved": False,
        }
    ]
    
    errors = client.insert_rows_json(table_id, rows_to_insert)
    if errors == []:
        print(f"✓ Inserted {len(rows_to_insert)} rows into {table_id}")
    else:
        print(f"✗ Errors inserting rows: {errors}")


def insert_api_cost():
    """APIコストの挿入例"""
    table_id = f"{dataset_name}.api_costs"
    
    rows_to_insert = [
        {
            "timestamp": datetime.utcnow().isoformat(),
            "api_name": "chat.completions",
            "api_version": "v1",
            "api_provider": "OpenAI",
            "endpoint": "/v1/chat/completions",
            "method": "POST",
            "cost_amount": 0.002,
            "cost_currency": "USD",
            "usage_quantity": 1000.0,
            "usage_unit": "tokens",
            "tokens_input": 500,
            "tokens_output": 500,
            "tokens_total": 1000,
            "model_name": "gpt-4",
            "model_tier": "standard",
            "request_id": f"req_{int(datetime.utcnow().timestamp())}",
            "request_duration_ms": 1250.5,
            "request_status": "success",
            "source_service": "chatbot-service",
            "source_region": "us-west-1",
            "user_id": "user_12345",
            "tags": ["production", "chatbot"],
        }
    ]
    
    errors = client.insert_rows_json(table_id, rows_to_insert)
    if errors == []:
        print(f"✓ Inserted {len(rows_to_insert)} rows into {table_id}")
    else:
        print(f"✗ Errors inserting rows: {errors}")


def insert_alert():
    """アラートの挿入例"""
    table_id = f"{dataset_name}.alerts_history"
    
    rows_to_insert = [
        {
            "timestamp": datetime.utcnow().isoformat(),
            "alert_id": f"alert_{int(datetime.utcnow().timestamp())}",
            "alert_name": "High CPU Usage",
            "alert_type": "threshold",
            "severity": "high",
            "status": "firing",
            "description": "CPU usage exceeded 80% for more than 5 minutes",
            "trigger_condition": "cpu_usage > 80",
            "trigger_value": 85.5,
            "threshold_value": 80.0,
            "metric_name": "cpu_usage",
            "metric_value": 85.5,
            "source_service": "api-server",
            "source_instance": "api-server-01",
            "source_region": "us-west-1",
            "notification_channels": ["slack", "email", "pagerduty"],
            "notified_at": datetime.utcnow().isoformat(),
            "notification_status": "sent",
            "tags": ["infrastructure", "performance"],
            "runbook_url": "https://wiki.example.com/runbooks/high-cpu",
        }
    ]
    
    errors = client.insert_rows_json(table_id, rows_to_insert)
    if errors == []:
        print(f"✓ Inserted {len(rows_to_insert)} rows into {table_id}")
    else:
        print(f"✗ Errors inserting rows: {errors}")


def main():
    """メイン実行関数"""
    print("================================================")
    print("Magi Monitoring - Data Insertion Examples")
    print("================================================")
    print("")
    
    try:
        print("Inserting realtime metrics...")
        insert_realtime_metrics()
        print("")
        
        print("Inserting error log...")
        insert_error_log()
        print("")
        
        print("Inserting API cost...")
        insert_api_cost()
        print("")
        
        print("Inserting alert...")
        insert_alert()
        print("")
        
        print("================================================")
        print("✓ All insertions completed successfully!")
        print("================================================")
        
    except Exception as e:
        print(f"✗ Error: {e}")
        raise


if __name__ == "__main__":
    main()
