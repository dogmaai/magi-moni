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


// ---- Telegram Bot コマンドハンドラー ----

async function handleBotCommand(chatId, text) {
  const cmd = text.split(' ')[0].toLowerCase().replace('@magi_claw_bot', '');

  if (cmd === '/help' || cmd === '/start') {
    return sendTelegram(`[MAGI Monitor] コマンド一覧\n\n/status  - LLM API死活 + 本日サマリー\n/wr      - LLM x 方向別勝率テーブル\n/jobs    - Cloud Run Jobs状態\n/today   - 本日の取引一覧\n/help    - このメッセージ`);
  }

  if (cmd === '/status') {
    try {
      const [today, overall] = await Promise.all([queryTodaySummary(), queryOverallStats()]);
      const llmVals = Object.entries(llmHealthState);
      const upList = llmVals.filter(([,v]) => v.status === 'UP').map(([k]) => k);
      const downList = llmVals.filter(([,v]) => v.status === 'DOWN').map(([k]) => k);
      let msg = `[MAGI Status] ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n\n`;
      msg += `総合勝率: ${overall.overall_wr ?? '--'}% (${overall.total_wins ?? 0}W ${overall.total_loses ?? 0}L)\n`;
      msg += `評価済み: ${(overall.total_wins ?? 0) + (overall.total_loses ?? 0)} 件\n\n`;
      msg += `本日: WIN ${today.wins} / LOSE ${today.loses} / HOLD ${today.holds}\n\n`;
      msg += `LLM API UP: ${upList.length > 0 ? upList.join(', ') : 'なし'}\n`;
      if (downList.length > 0) msg += `DOWN: ${downList.join(', ')}\n`;
      return sendTelegram(msg);
    } catch (e) { return sendTelegram(`[MAGI] /status エラー: ${e.message}`); }
  }

  if (cmd === '/wr') {
    try {
      const rows = await queryTradeMetrics();
      let msg = `[MAGI] LLM x 方向別勝率\n\n`;
      const byLLM = {};
      for (const r of rows) {
        if (!byLLM[r.llm_provider]) byLLM[r.llm_provider] = [];
        byLLM[r.llm_provider].push(r);
      }
      for (const [llm, entries] of Object.entries(byLLM)) {
        msg += `${llm.toUpperCase()}\n`;
        for (const r of entries) {
          const wr = r.win_rate ?? '--';
          const blocked = r.win_rate <= 30 && r.loses >= 3 ? ' [BLOCKED]' : '';
          msg += `  ${r.side}: ${wr}% (${r.wins}W ${r.loses}L)${blocked}\n`;
        }
      }
      return sendTelegram(msg);
    } catch (e) { return sendTelegram(`[MAGI] /wr エラー: ${e.message}`); }
  }

  if (cmd === '/jobs') {
    try {
      const entries = Object.entries(jobsState);
      let msg = `[MAGI] Cloud Run Jobs\n\n`;
      if (entries.length === 0) {
        msg += '取得中... 10分後に再度お試しください';
      } else {
        for (const [name, j] of entries) {
          const icon = j.status === 'SUCCESS' ? 'OK' : j.status === 'FAILED' ? 'FAIL' : j.status === 'RUNNING' ? 'RUN' : '??';
          const diff = j.lastRun ? Math.floor((Date.now() - new Date(j.lastRun)) / 60000) : null;
          const ago = diff !== null ? (diff < 60 ? `${diff}m前` : `${Math.floor(diff/60)}h前`) : '--';
          msg += `[${icon}] ${name} (${ago})\n`;
        }
      }
      return sendTelegram(msg);
    } catch (e) { return sendTelegram(`[MAGI] /jobs エラー: ${e.message}`); }
  }

  if (cmd === '/today') {
    try {
      const query = `SELECT symbol, side, llm_provider, result, timestamp FROM \`${PROJECT_ID}.magi_core.trades_active\` WHERE DATE(timestamp) = CURRENT_DATE('America/New_York') ORDER BY timestamp DESC LIMIT 20`;
      const [rows] = await bq.query({ query, useLegacySql: false });
      if (rows.length === 0) return sendTelegram('[MAGI] 本日の取引はまだありません');
      let msg = `[MAGI] 本日の取引 (${rows.length}件)\n\n`;
      for (const r of rows) {
        const result = r.result || 'pending';
        const time = new Date(r.timestamp?.value || r.timestamp).toLocaleTimeString('ja-JP', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
        msg += `${time} ${r.symbol} ${r.side} [${r.llm_provider}] -> ${result}\n`;
      }
      return sendTelegram(msg);
    } catch (e) { return sendTelegram(`[MAGI] /today エラー: ${e.message}`); }
  }

  return sendTelegram(`[MAGI] 不明なコマンド: ${cmd}\n/help でコマンド一覧を確認してください`);
}

// Telegram Webhook
app.post('/webhook/telegram', async (req, res) => {
  res.status(200).send('OK');
  try {
    const update = req.body;
    const message = update.message || update.edited_message;
    if (!message || !message.text || !message.text.startsWith('/')) return;
    console.log(`[BOT] Command: ${message.text}`);
    await handleBotCommand(message.chat.id.toString(), message.text);
  } catch (e) { console.error('[BOT] Webhook error:', e.message); }
});

// Webhook登録
app.post('/setup/webhook', async (req, res) => {
  try {
    const webhookUrl = `https://magi-moni-398890937507.asia-northeast1.run.app/webhook/telegram`;
    const result = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await result.json();
    res.json({ webhookUrl, result: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MAGI Monitoring v3.0 on port ${PORT}`);
});
