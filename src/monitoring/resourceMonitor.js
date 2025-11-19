const os = require('os');

class ResourceMonitor {
  constructor(useMockData = true) {
    this.useMockData = useMockData;
    this.history = [];
    this.maxHistorySize = 100;
  }

  getMetrics() {
    let metrics;

    if (this.useMockData) {
      metrics = this.getMockMetrics();
    } else {
      metrics = this.getRealMetrics();
    }

    // Add to history
    this.history.push({
      timestamp: new Date().toISOString(),
      ...metrics
    });

    // Keep only recent history
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    return {
      current: metrics,
      history: this.history.slice(-20) // Return last 20 data points
    };
  }

  getRealMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Calculate CPU usage (simplified)
    let totalIdle = 0;
    let totalTick = 0;
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const cpuUsage = 100 - ~~(100 * idle / total);

    return {
      cpu: {
        usage: cpuUsage,
        cores: cpus.length
      },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usagePercent: ((usedMem / totalMem) * 100).toFixed(2)
      },
      uptime: os.uptime()
    };
  }

  getMockMetrics() {
    // Generate mock data that simulates realistic resource usage
    const baselineCPU = 45;
    const baselineMemory = 60;

    return {
      cpu: {
        usage: baselineCPU + Math.random() * 30,
        cores: 4
      },
      memory: {
        total: 8589934592, // 8GB
        used: (8589934592 * (baselineMemory + Math.random() * 20) / 100),
        free: (8589934592 * (40 - Math.random() * 20) / 100),
        usagePercent: (baselineMemory + Math.random() * 20).toFixed(2)
      },
      uptime: 86400 + Math.floor(Math.random() * 86400),
      disk: {
        total: 107374182400, // 100GB
        used: 53687091200 + Math.random() * 10737418240,
        usagePercent: (50 + Math.random() * 10).toFixed(2)
      },
      network: {
        bytesIn: Math.floor(Math.random() * 1000000000),
        bytesOut: Math.floor(Math.random() * 500000000)
      }
    };
  }
}

module.exports = ResourceMonitor;
