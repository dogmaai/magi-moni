// Dashboard JavaScript
const API_BASE = '';
let cpuHistory = [];
let memoryHistory = [];

// Create simple CSS-based chart
function createSimpleChart(containerId, data, label, color) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const max = Math.max(...data, 1);
    const bars = data.map((value, index) => {
        const height = (value / 100) * 100; // percentage
        return `
            <div class="simple-bar" style="height: ${height}%; background: ${color};" 
                 title="${label}: ${value.toFixed(1)}%"></div>
        `;
    }).join('');

    container.innerHTML = `
        <style>
            .simple-chart {
                display: flex;
                align-items: flex-end;
                height: 100%;
                gap: 2px;
                padding: 10px;
            }
            .simple-bar {
                flex: 1;
                min-height: 2px;
                border-radius: 2px 2px 0 0;
                transition: height 0.3s ease;
            }
        </style>
        <div class="simple-chart">${bars}</div>
    `;
}

// Initialize charts
function initCharts() {
    // Charts will be created when data is loaded
}

// Load health status
async function loadHealthStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/health/status`);
        const data = await response.json();

        // Update summary
        document.getElementById('totalServices').textContent = data.summary.total;
        document.getElementById('upServices').textContent = data.summary.up;
        document.getElementById('downServices').textContent = data.summary.down;

        // Update service list
        const serviceList = document.getElementById('serviceList');
        if (data.services.length === 0) {
            serviceList.innerHTML = '<div class="no-data">監視対象のサービスが登録されていません</div>';
        } else {
            serviceList.innerHTML = data.services.map(service => `
                <div class="service-item ${service.status}">
                    <div class="service-info">
                        <div class="service-name">${service.name}</div>
                        <div class="service-url">${service.url}</div>
                    </div>
                    <div class="service-status">
                        <span class="status-badge ${service.status}">
                            ${service.status === 'up' ? '✓ 稼働中' : '✗ 停止'}
                        </span>
                        ${service.responseTime ? `<span class="response-time">${service.responseTime}ms</span>` : ''}
                    </div>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading health status:', error);
        document.getElementById('serviceList').innerHTML = 
            '<div class="loading">データの読み込みに失敗しました</div>';
    }
}

// Load alerts
async function loadAlerts() {
    try {
        const response = await fetch(`${API_BASE}/api/alerts`);
        const alerts = await response.json();

        const alertsSection = document.getElementById('alertsSection');
        const alertsContainer = document.getElementById('alertsContainer');

        if (alerts.length === 0) {
            alertsSection.style.display = 'none';
        } else {
            alertsSection.style.display = 'block';
            alertsContainer.innerHTML = alerts.map(alert => `
                <div class="alert ${alert.severity}">
                    <div class="alert-icon">${alert.severity === 'critical' ? '🔴' : '⚠️'}</div>
                    <div class="alert-content">
                        <div class="alert-message">${alert.message}</div>
                        <div class="alert-time">${new Date(alert.timestamp).toLocaleString('ja-JP')}</div>
                    </div>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading alerts:', error);
    }
}

// Load resource metrics
async function loadResourceMetrics() {
    try {
        const response = await fetch(`${API_BASE}/api/resources/metrics`);
        const data = await response.json();

        // Update CPU
        const cpuUsage = data.current.cpu.usage.toFixed(1);
        document.getElementById('cpuUsage').textContent = `${cpuUsage}%`;
        document.getElementById('cpuProgress').style.width = `${cpuUsage}%`;

        // Update Memory
        const memoryUsage = parseFloat(data.current.memory.usagePercent);
        document.getElementById('memoryUsage').textContent = `${memoryUsage.toFixed(1)}%`;
        document.getElementById('memoryProgress').style.width = `${memoryUsage}%`;

        // Update charts
        if (data.history && data.history.length > 0) {
            const cpuValues = data.history.map(h => parseFloat(h.cpu.usage.toFixed(1)));
            const memoryValues = data.history.map(h => parseFloat(h.memory.usagePercent));

            createSimpleChart('cpuChartContainer', cpuValues, 'CPU使用率', '#667eea');
            createSimpleChart('memoryChartContainer', memoryValues, 'メモリ使用率', '#764ba2');
        }
    } catch (error) {
        console.error('Error loading resource metrics:', error);
    }
}

// Load request summary
async function loadRequestSummary() {
    try {
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;

        let url = `${API_BASE}/api/requests/summary`;
        const params = new URLSearchParams();
        if (startDate) params.append('startDate', startDate);
        if (endDate) params.append('endDate', endDate);
        if (params.toString()) url += '?' + params.toString();

        const response = await fetch(url);
        const data = await response.json();

        // Update summary
        document.getElementById('totalRequests').textContent = data.summary.total;
        document.getElementById('successfulRequests').textContent = data.summary.successful;
        document.getElementById('failedRequests').textContent = data.summary.failed;
        document.getElementById('successRate').textContent = `${data.summary.successRate}%`;

        // Update endpoint table
        const endpointTableBody = document.querySelector('#endpointTable tbody');
        if (Object.keys(data.byEndpoint).length === 0) {
            endpointTableBody.innerHTML = '<tr><td colspan="4" class="no-data">データがありません</td></tr>';
        } else {
            endpointTableBody.innerHTML = Object.entries(data.byEndpoint).map(([endpoint, stats]) => `
                <tr>
                    <td>${endpoint}</td>
                    <td>${stats.count}</td>
                    <td class="up">${stats.success}</td>
                    <td class="down">${stats.failed}</td>
                </tr>
            `).join('');
        }

        // Update user table
        const userTableBody = document.querySelector('#userTable tbody');
        if (Object.keys(data.byUser).length === 0) {
            userTableBody.innerHTML = '<tr><td colspan="4" class="no-data">データがありません</td></tr>';
        } else {
            userTableBody.innerHTML = Object.entries(data.byUser).map(([user, stats]) => `
                <tr>
                    <td>${user}</td>
                    <td>${stats.count}</td>
                    <td class="up">${stats.success}</td>
                    <td class="down">${stats.failed}</td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading request summary:', error);
    }
}

// Update last refresh time
function updateLastRefreshTime() {
    document.getElementById('lastUpdate').textContent = new Date().toLocaleString('ja-JP');
}

// Refresh all data
async function refreshDashboard() {
    await Promise.all([
        loadHealthStatus(),
        loadAlerts(),
        loadResourceMetrics(),
        loadRequestSummary()
    ]);
    updateLastRefreshTime();
}

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    
    // Set default date range (last 7 days)
    const today = new Date();
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    document.getElementById('endDate').valueAsDate = today;
    document.getElementById('startDate').valueAsDate = lastWeek;

    // Initial load
    refreshDashboard();

    // Auto-refresh every 30 seconds
    setInterval(refreshDashboard, 30000);
});
