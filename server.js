'use strict';
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

// MAGIサービス定義（静的）
const MAGI_SERVICES = [
  { name: 'magi-ac', url: 'https://magi-ac-398890937507.asia-northeast1.run.app', description: '証券分析（5AI）' },
  { name: 'magi-app', url: 'https://magi-app-398890937507.asia-northeast1.run.app', description: '質問応答（5AI合議）' },
  { name: 'magi-stg', url: 'https://magi-stg-398890937507.asia-northeast1.run.app', description: '仕様書管理' },
  { name: 'magi-ui', url: 'https://magi-ui-398890937507.asia-northeast1.run.app', description: 'UI' },
  { name: 'magi-moni', url: 'https://magi-moni-398890937507.asia-northeast1.run.app', description: 'モニタリング' },
];

// ===== 監視 API =====

// 1. サービスステータス（ヘルスチェック付き）
app.get('/api/services', async (req, res) => {
  const results = await Promise.all(
    MAGI_SERVICES.map(async (svc) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(`${svc.url}/health`, {
          signal: controller.signal,
          headers: { 'Authorization': req.headers.authorization || '' }
        });
        clearTimeout(timeout);
        
        const data = await response.json();
        return {
          ...svc,
          status: response.ok ? 'UP' : 'DOWN',
          health: data,
          latency: 'OK'
        };
      } catch (e) {
        return {
          ...svc,
          status: 'DOWN',
          error: e.message
        };
      }
    })
  );
  
  res.json({
    timestamp: new Date().toISOString(),
    services: results,
    summary: {
      total: results.length,
      up: results.filter(s => s.status === 'UP').length,
      down: results.filter(s => s.status === 'DOWN').length
    }
  });
});

// 2. 単一サービスのヘルスチェック
app.get('/api/services/:name/health', async (req, res) => {
  const svc = MAGI_SERVICES.find(s => s.name === req.params.name);
  if (!svc) {
    return res.status(404).json({ error: 'Service not found' });
  }
  
  try {
    const response = await fetch(`${svc.url}/health`, {
      headers: { 'Authorization': req.headers.authorization || '' }
    });
    const data = await response.json();
    res.json({ service: svc.name, status: 'UP', health: data });
  } catch (e) {
    res.json({ service: svc.name, status: 'DOWN', error: e.message });
  }
});

// 3. ログ統計（簡易版）
app.get('/api/logs', async (req, res) => {
  // Cloud Run環境ではgcloudコマンド使用不可のため、簡易版
  res.json({
    timestamp: new Date().toISOString(),
    message: 'Use Cloud Console for detailed logs',
    consoleUrl: 'https://console.cloud.google.com/logs/query?project=screen-share-459802',
    status: 'OK'
  });
});

// 4. BigQuery統計
app.get('/api/bigquery', async (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    dataset: 'magi_ac',
    tables: ['analyses', 'ai_judgments', 'document_analyses'],
    consoleUrl: 'https://console.cloud.google.com/bigquery?project=screen-share-459802',
    status: 'OK'
  });
});

// 5. システム概要
app.get('/api/overview', (req, res) => {
  res.json({
    system: 'MAGI System v4.0',
    services: MAGI_SERVICES.length,
    ai_providers: {
      'magi-app': ['Grok', 'Gemini', 'Claude', 'GPT-4', 'Mistral'],
      'magi-ac': ['Grok', 'Gemini', 'Claude', 'Mistral', 'Cohere']
    },
    storage: {
      bigquery: 'magi_ac dataset',
      cloud_storage: 'gs://magi-documents/'
    },
    updated: new Date().toISOString()
  });
});

// ===== ヘルス =====
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'magi-moni', version: '1.1.0' });
});

// ===== サーバー起動 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('🔍 MAGI Monitoring v1.1 listening on port ' + PORT);
});
