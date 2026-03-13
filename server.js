const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID || 'screen-share-459802';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(express.json());

const bq = new BigQuery({ projectId: PROJECT_ID });

// 取引結果の履歴を保存（既存機能）
const tradeResults = [];

// ===== Telegram送信ヘルパー =====
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[MONI] Telegram not configured, skipping');
    return;
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        console.log(`[MONI] Telegram sent (status ${res.statusCode})`);
        resolve();
      });
    });
    req.on('error', (e) => {
      console.error('[MONI] Telegram error:', e.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

// ===== BigQueryクエリヘルパー =====
async function runQuery(query) {
  const [rows] = await bq.query({ query });
  return rows;
}

// ===== 日次レポート生成 =====
// Phase 4: 毎日22:00 UTCにCloud Schedulerが /report/daily を叩く
async function generateDailyReport() {
  const today = new Date().toISOString().split('T')[0];

  // 当日取引サマリー
  const tradeQuery = `
    SELECT
      llm_provider,
      COUNT(*) AS trades,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS losses,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      ROUND(SUM(pnl_amount), 2) AS total_pnl_usd
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp) = '${today}'
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider
    ORDER BY total_pnl_usd DESC
  `;

  // L4プロベーション状態
  const l4Query = `
    SELECT llm_provider, side, blocked_at,
           TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), blocked_at, HOUR) AS hours_blocked
    FROM \`${PROJECT_ID}.magi_core.l4_probation\`
    ORDER BY blocked_at DESC
  `;

  // ブロック統計
  const blockQuery = `
    SELECT blocked_by, COUNT(*) AS count
    FROM \`${PROJECT_ID}.magi_core.trades\`
    WHERE DATE(timestamp) = '${today}'
      AND trade_mode = 'BLOCKED'
    GROUP BY blocked_by
    ORDER BY count DESC
  `;

  const [trades, l4Blocks, blockStats] = await Promise.all([
    runQuery(tradeQuery).catch(() => []),
    runQuery(l4Query).catch(() => []),
    runQuery(blockQuery).catch(() => [])
  ]);

  // レポート構築
  const totalTrades = trades.reduce((a, r) => a + Number(r.trades || 0), 0);
  const totalWins   = trades.reduce((a, r) => a + Number(r.wins || 0), 0);
  const totalLosses = trades.reduce((a, r) => a + Number(r.losses || 0), 0);
  const totalPnl    = trades.reduce((a, r) => a + Number(r.total_pnl_usd || 0), 0);
  const overallWR   = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';

  let msg = `📊 <b>MAGI Daily Report</b> - ${today}\n\n`;
  msg += `📈 <b>取引サマリー</b>\n`;
  msg += `総取引: ${totalTrades}件 | WIN: ${totalWins} | LOSE: ${totalLosses}\n`;
  msg += `勝率: ${overallWR}% | P&L: $${totalPnl.toFixed(2)}\n\n`;

  if (trades.length > 0) {
    msg += `<b>LLM別パフォーマンス</b>\n`;
    for (const r of trades) {
      const wr = r.win_rate || 0;
      const emoji = wr >= 60 ? '🟢' : wr >= 40 ? '🟡' : '🔴';
      msg += `${emoji} ${r.llm_provider}: ${r.trades}件 WR${wr}% P&L$${Number(r.total_pnl_usd).toFixed(2)}\n`;
    }
    msg += '\n';
  }

  if (l4Blocks.length > 0) {
    msg += `🔒 <b>L4ブロック状態</b>\n`;
    for (const b of l4Blocks) {
      msg += `  ${b.llm_provider}(${b.side}): ${b.hours_blocked}時間経過\n`;
    }
    msg += '\n';
  } else {
    msg += `✅ L4ブロック: なし\n\n`;
  }

  if (blockStats.length > 0) {
    msg += `🛡 <b>本日のガードブロック</b>\n`;
    for (const s of blockStats) {
      msg += `  ${s.blocked_by}: ${s.count}件\n`;
    }
  }

  return { message: msg, data: { trades, l4Blocks, blockStats } };
}

// ===== 週次レポート生成 =====
// Phase 4: 毎週月曜00:00 UTCにCloud Schedulerが /report/weekly を叩く
async function generateWeeklyReport() {
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 7 * 86400 * 1000).toISOString().split('T')[0];

  // 週次勝率トレンド（日別）
  const trendQuery = `
    SELECT
      DATE(timestamp) AS trade_date,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      COUNT(*) AS trades
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp) BETWEEN '${startDate}' AND '${endDate}'
      AND result IN ('WIN','LOSE')
    GROUP BY trade_date
    ORDER BY trade_date
  `;

  // LLM別パフォーマンス推移
  const llmPerfQuery = `
    SELECT
      llm_provider,
      COUNT(*) AS total_trades,
      COUNTIF(result = 'WIN') AS wins,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      ROUND(SUM(pnl_amount), 2) AS total_pnl_usd,
      ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp) BETWEEN '${startDate}' AND '${endDate}'
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider
    ORDER BY win_rate DESC
  `;

  // 注目パターン（ISABELから）
  const patternQuery = `
    SELECT
      pattern_summary,
      win_probability,
      similar_trade_count
    FROM \`${PROJECT_ID}.magi_core.isabel_analysis\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    ORDER BY win_probability DESC
    LIMIT 3
  `;

  const [trend, llmPerf, patterns] = await Promise.all([
    runQuery(trendQuery).catch(() => []),
    runQuery(llmPerfQuery).catch(() => []),
    runQuery(patternQuery).catch(() => [])
  ]);

  // 週全体の集計
  const weekTotal  = llmPerf.reduce((a, r) => a + Number(r.total_trades || 0), 0);
  const weekWins   = llmPerf.reduce((a, r) => a + Number(r.wins || 0), 0);
  const weekPnl    = llmPerf.reduce((a, r) => a + Number(r.total_pnl_usd || 0), 0);
  const weekWR     = weekTotal > 0 ? ((weekWins / weekTotal) * 100).toFixed(1) : '0.0';

  let msg = `📅 <b>MAGI Weekly Report</b>\n`;
  msg += `期間: ${startDate} ～ ${endDate}\n\n`;

  msg += `📊 <b>週間サマリー</b>\n`;
  msg += `総取引: ${weekTotal}件 | 勝率: ${weekWR}% | P&L: $${weekPnl.toFixed(2)}\n\n`;

  // 日別トレンド
  if (trend.length > 0) {
    msg += `📈 <b>勝率トレンド</b>\n`;
    for (const d of trend) {
      const bar = '█'.repeat(Math.round(Number(d.win_rate) / 10));
      msg += `${d.trade_date}: ${d.win_rate}% ${bar} (${d.trades}件)\n`;
    }
    msg += '\n';
  }

  // LLM別パフォーマンス
  if (llmPerf.length > 0) {
    msg += `🤖 <b>LLM別パフォーマンス</b>\n`;
    for (const r of llmPerf) {
      const wr = Number(r.win_rate);
      const emoji = wr >= 60 ? '🟢' : wr >= 40 ? '🟡' : '🔴';
      msg += `${emoji} ${r.llm_provider}: WR${wr}% | ${r.total_trades}件 | P&L$${Number(r.total_pnl_usd).toFixed(2)}\n`;
    }
    msg += '\n';
  }

  // 注目パターン
  if (patterns.length > 0) {
    msg += `🔍 <b>ISABEL注目パターン</b>\n`;
    for (const p of patterns) {
      msg += `  勝率予測${Number(p.win_probability * 100).toFixed(0)}%: ${p.pattern_summary}\n`;
    }
  }

  return { message: msg, data: { trend, llmPerf, patterns } };
}

// ===== ヘルスチェック =====
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'magi-moni',
    version: '3.0.0',
    resultsCount: tradeResults.length,
    timestamp: new Date().toISOString()
  });
});

// ===== Pub/Sub エンドポイント（既存機能） =====
app.post('/pubsub/trade-result', (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.data) {
      console.log('[MONI] No message data');
      return res.status(200).send('OK');
    }
    const data = JSON.parse(Buffer.from(message.data, 'base64').toString());
    console.log('[MONI] Received trade result:', JSON.stringify(data));
    tradeResults.push({ ...data, receivedAt: new Date().toISOString() });
    if (tradeResults.length > 100) tradeResults.shift();
    res.status(200).send('OK');
  } catch (error) {
    console.error('[MONI] Error processing message:', error.message);
    res.status(200).send('OK');
  }
});

// ===== 取引結果履歴取得（既存機能） =====
app.get('/results', (req, res) => {
  res.json({
    count: tradeResults.length,
    results: tradeResults.slice(-20).reverse()
  });
});

// ===== 日次レポート（Phase 4）=====
// Cloud Schedulerから毎日22:00 UTCに叩かれる
app.post('/report/daily', async (req, res) => {
  console.log('[MONI] Generating daily report...');
  try {
    const { message, data } = await generateDailyReport();
    await sendTelegram(message);
    console.log('[MONI] Daily report sent');
    res.json({ status: 'ok', message: 'Daily report sent', data });
  } catch (err) {
    console.error('[MONI] Daily report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 週次レポート（Phase 4）=====
// Cloud Schedulerから毎週月曜00:00 UTCに叩かれる
app.post('/report/weekly', async (req, res) => {
  console.log('[MONI] Generating weekly report...');
  try {
    const { message, data } = await generateWeeklyReport();
    await sendTelegram(message);
    console.log('[MONI] Weekly report sent');
    res.json({ status: 'ok', message: 'Weekly report sent', data });
  } catch (err) {
    console.error('[MONI] Weekly report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MAGI Monitoring v3.0 on port ${PORT}`);
});
