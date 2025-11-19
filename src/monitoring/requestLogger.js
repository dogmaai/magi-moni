const fs = require('fs');
const path = require('path');

class RequestLogger {
  constructor(storageType = 'file') {
    this.storageType = storageType;
    this.logFile = path.join(__dirname, '../../data/request-logs.json');
    this.logs = [];
    this.loadLogs();
  }

  loadLogs() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.logFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      if (fs.existsSync(this.logFile)) {
        const data = fs.readFileSync(this.logFile, 'utf8');
        this.logs = JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading request logs:', error.message);
      this.logs = [];
    }
  }

  saveLogs() {
    try {
      fs.writeFileSync(this.logFile, JSON.stringify(this.logs, null, 2));
    } catch (error) {
      console.error('Error saving request logs:', error.message);
    }
  }

  log(endpoint, user = 'anonymous', status = 200) {
    const logEntry = {
      id: Date.now() + Math.random(),
      endpoint,
      user,
      status,
      timestamp: new Date().toISOString()
    };

    this.logs.push(logEntry);

    // Keep only last 10000 logs
    if (this.logs.length > 10000) {
      this.logs = this.logs.slice(-10000);
    }

    this.saveLogs();
    return logEntry;
  }

  getSummary(startDate, endDate, user) {
    let filteredLogs = this.logs;

    // Filter by date range
    if (startDate) {
      const start = new Date(startDate);
      filteredLogs = filteredLogs.filter(log => new Date(log.timestamp) >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      filteredLogs = filteredLogs.filter(log => new Date(log.timestamp) <= end);
    }

    // Filter by user
    if (user) {
      filteredLogs = filteredLogs.filter(log => log.user === user);
    }

    // Calculate statistics
    const totalRequests = filteredLogs.length;
    const successfulRequests = filteredLogs.filter(log => log.status >= 200 && log.status < 300).length;
    const failedRequests = filteredLogs.filter(log => log.status >= 400).length;

    // Group by endpoint
    const byEndpoint = {};
    filteredLogs.forEach(log => {
      if (!byEndpoint[log.endpoint]) {
        byEndpoint[log.endpoint] = {
          count: 0,
          success: 0,
          failed: 0
        };
      }
      byEndpoint[log.endpoint].count++;
      if (log.status >= 200 && log.status < 300) {
        byEndpoint[log.endpoint].success++;
      } else if (log.status >= 400) {
        byEndpoint[log.endpoint].failed++;
      }
    });

    // Group by user
    const byUser = {};
    filteredLogs.forEach(log => {
      if (!byUser[log.user]) {
        byUser[log.user] = {
          count: 0,
          success: 0,
          failed: 0
        };
      }
      byUser[log.user].count++;
      if (log.status >= 200 && log.status < 300) {
        byUser[log.user].success++;
      } else if (log.status >= 400) {
        byUser[log.user].failed++;
      }
    });

    // Group by date (daily)
    const byDate = {};
    filteredLogs.forEach(log => {
      const date = log.timestamp.split('T')[0];
      if (!byDate[date]) {
        byDate[date] = 0;
      }
      byDate[date]++;
    });

    return {
      summary: {
        total: totalRequests,
        successful: successfulRequests,
        failed: failedRequests,
        successRate: totalRequests > 0 ? ((successfulRequests / totalRequests) * 100).toFixed(2) : 0
      },
      byEndpoint,
      byUser,
      byDate,
      recentLogs: filteredLogs.slice(-50).reverse() // Last 50 logs
    };
  }
}

module.exports = RequestLogger;
