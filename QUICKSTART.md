# Quick Start Guide

## Installation

1. Clone the repository and navigate to the project directory
2. Install dependencies:
   ```bash
   npm install
   ```

## Running the Dashboard

Start the server:
```bash
npm start
```

The dashboard will be available at: `http://localhost:3000`

## Configuration

### Adding Services to Monitor

Edit `monitoring/config.yaml`:

```yaml
monitoring:
  interval: 60  # Check interval in seconds
  services:
    - name: My API
      url: https://api.example.com/health
      critical: true
    - name: Secondary Service
      url: https://service.example.com
      critical: false
```

### Switching Between Mock and Real Resource Data

Edit `src/monitoring/resourceMonitor.js` constructor:

```javascript
// For mock data (default)
constructor(useMockData = true)

// For real system metrics
constructor(useMockData = false)
```

## Features Overview

### 1. Service Health Monitoring
- Automatically checks configured endpoints every 60 seconds
- Shows real-time status: UP (green) or DOWN (red)
- Displays response times for healthy services

### 2. Resource Usage
- CPU and memory usage with visual graphs
- Historical data tracking (last 20 data points)
- Auto-refreshing metrics

### 3. Alerts
- Automatic alerts when services go down
- Critical and warning severity levels
- Alerts clear automatically when services recover

### 4. API Request Statistics
- Filter by date range
- View statistics by endpoint and user
- Success rate tracking

## API Usage

### Check Health Status
```bash
curl http://localhost:3000/api/health/status
```

### Get Resource Metrics
```bash
curl http://localhost:3000/api/resources/metrics
```

### Get Request Summary
```bash
curl "http://localhost:3000/api/requests/summary?startDate=2025-11-01&endDate=2025-11-19"
```

### Get Active Alerts
```bash
curl http://localhost:3000/api/alerts
```

### Log an API Request
```bash
curl -X POST http://localhost:3000/api/requests/log \
  -H "Content-Type: application/json" \
  -d '{"endpoint":"/api/test","user":"testuser","status":200}'
```

## Troubleshooting

### Services showing as DOWN
If you're in a sandboxed or offline environment, external services may not be reachable. This is expected behavior. The system will correctly identify them as DOWN and create alerts.

### Data not appearing
- Check that the server is running
- Open browser console (F12) to check for errors
- Verify the data directory exists and is writable

## Development

To run in development mode with auto-reload:
```bash
npm run dev
```

Note: You need to install nodemon first:
```bash
npm install -g nodemon
```
