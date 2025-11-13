# magi-moni
Monitoring Status Dashboard

A comprehensive monitoring system with BigQuery-based data storage and analytics.

## Features

- **Real-time Metrics**: Track metrics with 1-minute granularity
- **Aggregated Analytics**: Hourly and daily metric aggregations
- **Error Logging**: Centralized error tracking and management
- **API Cost Monitoring**: Track API usage and costs across providers
- **Alert Management**: Alert history and incident tracking

## BigQuery Schema

This project includes a complete BigQuery schema for monitoring data storage. See the [BigQuery documentation](bigquery/README.md) for details.

### Tables

```
BigQuery: magi_monitoring
├── metrics_realtime     # Real-time metrics (1-minute granularity)
├── metrics_hourly       # Hourly aggregated metrics
├── metrics_daily        # Daily aggregated metrics
├── errors               # Error logs
├── api_costs            # API cost tracking
└── alerts_history       # Alert history
```

## Quick Start

### Setup BigQuery Tables

```bash
cd bigquery
./setup.sh
```

### Example Usage

See [examples](bigquery/examples/) directory for:
- Data insertion examples (`insert_data.py`)
- Query examples (`queries.sql`)

## Documentation

- [BigQuery Schema Documentation](bigquery/README.md)
- [Example Queries](bigquery/examples/queries.sql)

## License

MIT
