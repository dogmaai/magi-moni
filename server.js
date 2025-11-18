'use strict';
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

// ===== 監視 API =====

// 1. Cloud Run サービスステータス
app.get('/api/services', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const output = execSync('gcloud run services list --region=asia-northeast1 --format=json 2>/dev/null', { encoding: 'utf-8' });
    const services = JSON.parse(output);
    res.json({
      timestamp: new Date().toISOString(),
      services: services.map(s => ({
        name: s.metadata.name,
        url: s.status.url,
        updated: s.metadata.updateTime
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. BigQuery テーブル情報
app.get('/api/bigquery', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const output = execSync('bq show --format=json screen-share-459802:magi_analysis.stock_ai_analysis 2>/dev/null', { encoding: 'utf-8' });
    const table = JSON.parse(output);
    res.json({
      timestamp: new Date().toISOString(),
      dataset: 'magi_analysis',
      table: 'stock_ai_analysis',
      rows: table.numRows,
      bytes: table.numBytes,
      created: table.creationTime
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. ログ統計
app.get('/api/logs', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const errors = execSync('gcloud logging read "severity>=ERROR" --limit=100 --format=json 2>/dev/null | wc -l', { encoding: 'utf-8' }).trim();
    const warnings = execSync('gcloud logging read "severity=WARNING" --limit=100 --format=json 2>/dev/null | wc -l', { encoding: 'utf-8' }).trim();
    
    res.json({
      timestamp: new Date().toISOString(),
      errors: parseInt(errors) || 0,
      warnings: parseInt(warnings) || 0,
      status: parseInt(errors) === 0 ? 'OK' : 'ALERT'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ヘルス =====
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'magi-moni', version: '1.0.0' });
});

// ===== サーバー起動 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('🎯 MAGI Monitoring listening on port ' + PORT);
});
