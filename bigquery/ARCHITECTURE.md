# BigQuery Schema Architecture

## データフロー / Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                  Data Sources                           │
│  (Applications, Services, Infrastructure)                │
└────────────────┬────────────────────────────────────────┘
                 │
                 │ Real-time data ingestion
                 ▼
┌─────────────────────────────────────────────────────────┐
│              metrics_realtime                           │
│         (1-minute granularity)                          │
│  - timestamp, metric_name, value                        │
│  - labels, source info                                  │
│  Retention: 7 days                                      │
└────────────────┬────────────────────────────────────────┘
                 │
                 │ Hourly aggregation (scheduled query)
                 ▼
┌─────────────────────────────────────────────────────────┐
│              metrics_hourly                             │
│         (Hourly aggregation)                            │
│  - avg, min, max, stddev                                │
│  - p50, p95, p99 percentiles                            │
│  Retention: 365 days                                    │
└────────────────┬────────────────────────────────────────┘
                 │
                 │ Daily aggregation (scheduled query)
                 ▼
┌─────────────────────────────────────────────────────────┐
│              metrics_daily                              │
│         (Daily aggregation)                             │
│  - daily statistics                                     │
│  - trend analysis                                       │
│  Retention: 730 days (2 years)                          │
└─────────────────────────────────────────────────────────┘
```

## 並行データストリーム / Parallel Data Streams

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│     errors       │     │    api_costs     │     │ alerts_history   │
│                  │     │                  │     │                  │
│ - error logs     │     │ - API usage      │     │ - alert events   │
│ - stack traces   │     │ - cost tracking  │     │ - notifications  │
│ - severity       │     │ - token counts   │     │ - resolution     │
│                  │     │                  │     │                  │
│ Retention: 90d   │     │ Retention: 730d  │     │ Retention: 365d  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

## テーブル間の関係 / Table Relationships

```
┌─────────────────────────────────────────────────────────────┐
│                    Cross-Table Analysis                     │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Service Health  │  │  Cost Analysis   │  │ Error Tracking   │
│   Dashboard      │  │                  │  │                  │
├──────────────────┤  ├──────────────────┤  ├──────────────────┤
│ Metrics ───┐     │  │ API Costs ───┐   │  │ Errors ───┐      │
│ Errors     ├──── │  │ Metrics      ├─  │  │ Alerts    ├────  │
│ Alerts     │     │  │              │   │  │ Metrics   │      │
│ API Costs ─┘     │  │              │   │  │           │      │
└──────────────────┘  └──────────────┘   └──────────────┘
```

## パーティショニング戦略 / Partitioning Strategy

| Table            | Partition By          | Cluster By                           |
|------------------|-----------------------|--------------------------------------|
| metrics_realtime | TIMESTAMP(DAY)        | metric_name, source_service          |
| metrics_hourly   | TIMESTAMP(MONTH)      | metric_name, source_service          |
| metrics_daily    | DATE                  | metric_name, source_service          |
| errors           | TIMESTAMP(DAY)        | severity, source_service, error_type |
| api_costs        | TIMESTAMP(DAY)        | api_provider, api_name, source_service|
| alerts_history   | TIMESTAMP(DAY)        | severity, status, source_service     |

## クエリパターン / Query Patterns

### 1. Real-time Monitoring
```
metrics_realtime → Filter by timestamp (last 1-24 hours)
                → Group by metric_name, source_service
                → Real-time dashboard
```

### 2. Historical Analysis
```
metrics_hourly/daily → Filter by date range
                     → Aggregate statistics
                     → Trend analysis
```

### 3. Incident Investigation
```
errors + alerts_history → Correlate by timestamp and service
                        → Root cause analysis
                        → Resolution tracking
```

### 4. Cost Optimization
```
api_costs → Aggregate by provider, service
          → Identify high-cost operations
          → Budget tracking
```

## データ保持ライフサイクル / Data Retention Lifecycle

```
Real-time (7 days)     → Hourly (1 year)     → Daily (2 years)
      ↓                       ↓                       ↓
  [Archive]              [Archive]              [Archive]
     or                     or                     or
  [Delete]               [Delete]               [Delete]

Errors (90 days) → [Archive/Delete]
API Costs (2 years) → [Archive/Delete]
Alerts (1 year) → [Archive/Delete]
```

## 推奨される使用パターン / Recommended Usage Patterns

### Real-time Operations
- Use `metrics_realtime` for current status
- Filter by last 1-24 hours
- Enable streaming inserts

### Analysis & Reporting
- Use `metrics_hourly` for trends
- Use `metrics_daily` for reports
- Schedule aggregation queries

### Troubleshooting
- Join `errors` with `alerts_history`
- Correlate with `metrics_realtime`
- Track resolution time

### Cost Management
- Track `api_costs` daily
- Alert on budget thresholds
- Optimize high-cost operations
