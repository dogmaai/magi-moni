const axios = require('axios');

class HealthMonitor {
  constructor(config) {
    this.config = config;
    this.services = config.services || [];
    this.interval = (config.interval || 60) * 1000; // Convert to milliseconds
    this.intervalId = null;
    this.statusMap = new Map();
    this.alerts = [];
  }

  start() {
    console.log('Starting health monitor...');
    this.check(); // Initial check
    this.intervalId = setInterval(() => this.check(), this.interval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('Health monitor stopped');
    }
  }

  async check() {
    console.log(`Running health checks on ${this.services.length} services...`);
    
    for (const service of this.services) {
      try {
        const startTime = Date.now();
        const response = await axios.get(service.url, {
          timeout: 10000,
          validateStatus: (status) => status < 500 // Consider 4xx as "up"
        });
        const responseTime = Date.now() - startTime;

        const status = {
          name: service.name,
          url: service.url,
          status: 'up',
          statusCode: response.status,
          responseTime: responseTime,
          lastCheck: new Date().toISOString(),
          critical: service.critical || false
        };

        this.statusMap.set(service.name, status);
        this.clearAlert(service.name);
        
      } catch (error) {
        const status = {
          name: service.name,
          url: service.url,
          status: 'down',
          statusCode: error.response?.status || 0,
          error: error.message,
          lastCheck: new Date().toISOString(),
          critical: service.critical || false
        };

        this.statusMap.set(service.name, status);
        this.addAlert(service.name, `Service ${service.name} is down: ${error.message}`, service.critical);
      }
    }
  }

  addAlert(serviceName, message, critical = false) {
    // Check if alert already exists
    const existingAlert = this.alerts.find(a => a.serviceName === serviceName);
    if (!existingAlert) {
      this.alerts.push({
        id: Date.now(),
        serviceName,
        message,
        severity: critical ? 'critical' : 'warning',
        timestamp: new Date().toISOString()
      });
      console.log(`Alert added: ${message}`);
    }
  }

  clearAlert(serviceName) {
    const initialLength = this.alerts.length;
    this.alerts = this.alerts.filter(a => a.serviceName !== serviceName);
    if (this.alerts.length < initialLength) {
      console.log(`Alert cleared for ${serviceName}`);
    }
  }

  getStatus() {
    const services = Array.from(this.statusMap.values());
    const upCount = services.filter(s => s.status === 'up').length;
    const downCount = services.filter(s => s.status === 'down').length;

    return {
      summary: {
        total: services.length,
        up: upCount,
        down: downCount
      },
      services: services
    };
  }

  getAlerts() {
    return this.alerts;
  }
}

module.exports = HealthMonitor;
