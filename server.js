const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const HealthMonitor = require('./src/monitoring/healthMonitor');
const ResourceMonitor = require('./src/monitoring/resourceMonitor');
const RequestLogger = require('./src/monitoring/requestLogger');
const yaml = require('js-yaml');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(limiter);
app.use(express.static(path.join(__dirname, 'public')));

// Load monitoring configuration
let config = {};
try {
  const configFile = fs.readFileSync('./monitoring/config.yaml', 'utf8');
  config = yaml.load(configFile);
} catch (e) {
  console.error('Error loading config:', e.message);
  config = { monitoring: { interval: 60, services: [] } };
}

// Initialize monitors
const healthMonitor = new HealthMonitor(config.monitoring);
const resourceMonitor = new ResourceMonitor();
const requestLogger = new RequestLogger();

// Start background monitoring
healthMonitor.start();

// API Routes

// Get current health status of all services
app.get('/api/health/status', (req, res) => {
  const status = healthMonitor.getStatus();
  res.json(status);
});

// Get resource usage metrics
app.get('/api/resources/metrics', (req, res) => {
  const metrics = resourceMonitor.getMetrics();
  res.json(metrics);
});

// Get API request statistics
app.get('/api/requests/summary', (req, res) => {
  const { startDate, endDate, user } = req.query;
  const summary = requestLogger.getSummary(startDate, endDate, user);
  res.json(summary);
});

// Get active alerts/notifications
app.get('/api/alerts', (req, res) => {
  const alerts = healthMonitor.getAlerts();
  res.json(alerts);
});

// Log API request (for tracking)
app.post('/api/requests/log', (req, res) => {
  const { endpoint, user, status } = req.body;
  requestLogger.log(endpoint, user, status);
  res.json({ success: true });
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Magi-Moni Dashboard running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  healthMonitor.stop();
  process.exit(0);
});
