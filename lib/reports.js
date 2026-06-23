/**
 * @module lib/reports
 * Daily and weekly report generators (Cloud Scheduler driven).
 */
const { runQuery } = require('./bigquery');
const { PROJECT_ID, nyDateString } = require('./config');

async function generateDailyReport() {
  const today = nyDateString();

  const tradeQuery = `
    SELECT
      llm_provider,
      COUNT(*) AS trades,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS losses,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      ROUND(SUM(pnl_amount), 2) AS total_pnl_usd
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') = @today
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider
    ORDER BY total_pnl_usd DESC
  `;

  const l4Query = `
    SELECT llm_provider, side, blocked_at,
           TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), blocked_at, HOUR) AS hours_blocked
    FROM \`${PROJECT_ID}.magi_core.l4_probation\`
    ORDER BY blocked_at DESC
  `;

  const blockQuery = `
    SELECT blocked_by, COUNT(*) AS count
    FROM \`${PROJECT_ID}.magi_core.trades\`
    WHERE DATE(timestamp, 'America/New_York') = @today
      AND trade_mode = 'BLOCKED'
    GROUP BY blocked_by
    ORDER BY count DESC
  `;

  const todayParams = { today };

  const [trades, l4Blocks, blockStats] = await Promise.all([
    runQuery(tradeQuery, todayParams).catch(() => []),
    runQuery(l4Query).catch(() => []),
    runQuery(blockQuery, todayParams).catch(() => [])
  ]);

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

async function generateWeeklyReport() {
  const endDate = nyDateString();
  const startDate = nyDateString(new Date(Date.now() - 7 * 86400 * 1000));

  const trendQuery = `
    SELECT
      DATE(timestamp, 'America/New_York') AS trade_date,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      COUNT(*) AS trades
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') BETWEEN @startDate AND @endDate
      AND result IN ('WIN','LOSE')
    GROUP BY trade_date
    ORDER BY trade_date
  `;

  const llmPerfQuery = `
    SELECT
      llm_provider,
      COUNT(*) AS total_trades,
      COUNTIF(result = 'WIN') AS wins,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      ROUND(SUM(pnl_amount), 2) AS total_pnl_usd,
      ROUND(AVG(pnl_percent), 2) AS avg_pnl_pct
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') BETWEEN @startDate AND @endDate
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider
    ORDER BY win_rate DESC
  `;

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

  const dateParams = { startDate, endDate };

  const [trend, llmPerf, patterns] = await Promise.all([
    runQuery(trendQuery, dateParams).catch(() => []),
    runQuery(llmPerfQuery, dateParams).catch(() => []),
    runQuery(patternQuery).catch(() => [])
  ]);

  const weekTotal  = llmPerf.reduce((a, r) => a + Number(r.total_trades || 0), 0);
  const weekWins   = llmPerf.reduce((a, r) => a + Number(r.wins || 0), 0);
  const weekPnl    = llmPerf.reduce((a, r) => a + Number(r.total_pnl_usd || 0), 0);
  const weekWR     = weekTotal > 0 ? ((weekWins / weekTotal) * 100).toFixed(1) : '0.0';

  let msg = `📅 <b>MAGI Weekly Report</b>\n`;
  msg += `期間: ${startDate} ～ ${endDate}\n\n`;

  msg += `📊 <b>週間サマリー</b>\n`;
  msg += `総取引: ${weekTotal}件 | 勝率: ${weekWR}% | P&L: $${weekPnl.toFixed(2)}\n\n`;

  if (trend.length > 0) {
    msg += `📈 <b>勝率トレンド</b>\n`;
    for (const d of trend) {
      const bar = '█'.repeat(Math.round(Number(d.win_rate) / 10));
      msg += `${d.trade_date}: ${d.win_rate}% ${bar} (${d.trades}件)\n`;
    }
    msg += '\n';
  }

  if (llmPerf.length > 0) {
    msg += `🤖 <b>LLM別パフォーマンス</b>\n`;
    for (const r of llmPerf) {
      const wr = Number(r.win_rate);
      const emoji = wr >= 60 ? '🟢' : wr >= 40 ? '🟡' : '🔴';
      msg += `${emoji} ${r.llm_provider}: WR${wr}% | ${r.total_trades}件 | P&L$${Number(r.total_pnl_usd).toFixed(2)}\n`;
    }
    msg += '\n';
  }

  if (patterns.length > 0) {
    msg += `🔍 <b>ISABEL注目パターン</b>\n`;
    for (const p of patterns) {
      msg += `  勝率予測${Number(p.win_probability * 100).toFixed(0)}%: ${p.pattern_summary}\n`;
    }
  }

  return { message: msg, data: { trend, llmPerf, patterns } };
}

module.exports = { generateDailyReport, generateWeeklyReport };
