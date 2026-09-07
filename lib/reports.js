/**
 * @module lib/reports
 * Daily and weekly report generators (Cloud Scheduler driven).
 */
const { runQuery } = require('./bigquery');
const { PROJECT_ID, nyDateString } = require('./config');

// Report sections must not silently turn a query failure into "no data": a
// failed query is reported as such so the numbers are never quietly wrong.
async function safeQuery(label, query, params) {
  try {
    return { rows: await runQuery(query, params) };
  } catch (err) {
    console.error(`[REPORT] query failed (${label}): ${err.message}`);
    return { rows: [], error: err.message };
  }
}

// BigQuery returns DATE/TIMESTAMP columns as { value } wrappers.
function fmtTimestamp(ts) {
  const raw = ts && ts.value ? ts.value : ts;
  return raw ? String(raw).replace('T', ' ').slice(0, 16) : '-';
}

function fmtDate(d) {
  const raw = d && d.value ? d.value : d;
  return raw ? String(raw).slice(0, 10) : '-';
}

// Reports are sent with parse_mode=HTML (lib/telegram.js), so any value coming
// from BigQuery or an error message must be escaped or Telegram rejects the
// whole message.
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function failureSection(sections) {
  const failed = sections.filter(([, r]) => r.error);
  if (failed.length === 0) return '';
  let out = `\n\u26a0\ufe0f <b>\u53d6\u5f97\u5931\u6557</b>\n`;
  for (const [name, r] of failed) out += `  ${name}: ${esc(r.error)}\n`;
  return out;
}

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

  // L4 is warn-only (magi-core src/paperGuards.js): no probation state exists,
  // warnings land in thoughts with concerns='L4'.
  const l4Query = `
    SELECT llm_provider, unit_name,
           REGEXP_EXTRACT(reasoning, r'^(BUY|SELL)') AS side,
           COUNT(*) AS warnings,
           MAX(timestamp) AS last_warned_at
    FROM \`${PROJECT_ID}.magi_core.thoughts\`
    WHERE concerns = 'L4'
      AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    GROUP BY llm_provider, unit_name, side
    ORDER BY warnings DESC
  `;

  const blockQuery = `
    SELECT concerns AS blocked_by, COUNT(*) AS count
    FROM \`${PROJECT_ID}.magi_core.thoughts\`
    WHERE DATE(timestamp, 'America/New_York') = @today
      AND action = 'BLOCKED'
    GROUP BY concerns
    ORDER BY count DESC
  `;

  const todayParams = { today };

  const [tradeRes, l4Res, blockRes] = await Promise.all([
    safeQuery('daily_trades', tradeQuery, todayParams),
    safeQuery('l4_warnings', l4Query),
    safeQuery('guard_blocks', blockQuery, todayParams)
  ]);
  const trades = tradeRes.rows;
  const l4Warnings = l4Res.rows;
  const blockStats = blockRes.rows;

  const totalTrades = trades.reduce((a, r) => a + Number(r.trades || 0), 0);
  const totalWins   = trades.reduce((a, r) => a + Number(r.wins || 0), 0);
  const totalLosses = trades.reduce((a, r) => a + Number(r.losses || 0), 0);
  const totalPnl    = trades.reduce((a, r) => a + Number(r.total_pnl_usd || 0), 0);
  const overallWR   = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';

  let msg = `📊 <b>MAGI Daily Report</b> - ${today}\n\n`;
  msg += `📈 <b>取引サマリー</b>\n`;
  if (tradeRes.error) {
    // Zero rows from a failed query are not zero trades.
    msg += `取得失敗（集計不能）\n\n`;
  } else {
    msg += `総取引: ${totalTrades}件 | WIN: ${totalWins} | LOSE: ${totalLosses}\n`;
    msg += `勝率: ${overallWR}% | P&L: $${totalPnl.toFixed(2)}\n\n`;
  }

  if (trades.length > 0) {
    msg += `<b>LLM別パフォーマンス</b>\n`;
    for (const r of trades) {
      const wr = r.win_rate || 0;
      const emoji = wr >= 60 ? '🟢' : wr >= 40 ? '🟡' : '🔴';
      msg += `${emoji} ${esc(r.llm_provider)}: ${r.trades}件 WR${wr}% P&L$${Number(r.total_pnl_usd).toFixed(2)}\n`;
    }
    msg += '\n';
  }

  if (l4Res.error) {
    msg += `⚠️ L4警告(直近7日): 取得失敗\n\n`;
  } else if (l4Warnings.length > 0) {
    msg += `⚠️ <b>L4方向適性警告 (直近7日 / warn-only)</b>\n`;
    for (const b of l4Warnings) {
      const who = esc(b.unit_name || b.llm_provider);
      msg += `  ${who}(${esc(b.side || '-')}): ${b.warnings}件 最終 ${fmtTimestamp(b.last_warned_at)}\n`;
    }
    msg += '\n';
  } else {
    msg += `✅ L4警告(直近7日): なし\n\n`;
  }

  if (blockStats.length > 0) {
    msg += `🛡 <b>本日のガードブロック</b>\n`;
    for (const s of blockStats) {
      msg += `  ${esc(s.blocked_by)}: ${s.count}件\n`;
    }
  }

  msg += failureSection([
    ['取引サマリー', tradeRes],
    ['L4警告', l4Res],
    ['ガードブロック', blockRes]
  ]);

  return { message: msg, data: { trades, l4Warnings, blockStats } };
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
      llm_provider,
      win_count,
      lose_count,
      win_pattern_summary,
      analyzed_at
    FROM \`${PROJECT_ID}.magi_core.isabel_l4_patterns\`
    WHERE analyzed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY llm_provider ORDER BY analyzed_at DESC) = 1
    ORDER BY win_count DESC
    LIMIT 3
  `;

  const dateParams = { startDate, endDate };

  const [trendRes, llmPerfRes, patternRes] = await Promise.all([
    safeQuery('weekly_trend', trendQuery, dateParams),
    safeQuery('weekly_llm_perf', llmPerfQuery, dateParams),
    safeQuery('isabel_patterns', patternQuery)
  ]);
  const trend = trendRes.rows;
  const llmPerf = llmPerfRes.rows;
  const patterns = patternRes.rows;

  const weekTotal  = llmPerf.reduce((a, r) => a + Number(r.total_trades || 0), 0);
  const weekWins   = llmPerf.reduce((a, r) => a + Number(r.wins || 0), 0);
  const weekPnl    = llmPerf.reduce((a, r) => a + Number(r.total_pnl_usd || 0), 0);
  const weekWR     = weekTotal > 0 ? ((weekWins / weekTotal) * 100).toFixed(1) : '0.0';

  let msg = `📅 <b>MAGI Weekly Report</b>\n`;
  msg += `期間: ${startDate} ～ ${endDate}\n\n`;

  msg += `📊 <b>週間サマリー</b>\n`;
  if (llmPerfRes.error) {
    // Zero rows from a failed query are not zero trades.
    msg += `取得失敗（集計不能）\n\n`;
  } else {
    msg += `総取引: ${weekTotal}件 | 勝率: ${weekWR}% | P&L: $${weekPnl.toFixed(2)}\n\n`;
  }

  if (trend.length > 0) {
    msg += `📈 <b>勝率トレンド</b>\n`;
    for (const d of trend) {
      const bar = '█'.repeat(Math.round(Number(d.win_rate) / 10));
      msg += `${fmtDate(d.trade_date)}: ${d.win_rate}% ${bar} (${d.trades}件)\n`;
    }
    msg += '\n';
  }

  if (llmPerf.length > 0) {
    msg += `🤖 <b>LLM別パフォーマンス</b>\n`;
    for (const r of llmPerf) {
      const wr = Number(r.win_rate);
      const emoji = wr >= 60 ? '🟢' : wr >= 40 ? '🟡' : '🔴';
      msg += `${emoji} ${esc(r.llm_provider)}: WR${wr}% | ${r.total_trades}件 | P&L$${Number(r.total_pnl_usd).toFixed(2)}\n`;
    }
    msg += '\n';
  }

  if (patterns.length > 0) {
    msg += `🔍 <b>ISABEL注目パターン (L4)</b>\n`;
    for (const p of patterns) {
      const summary = esc(String(p.win_pattern_summary || '').replace(/\s+/g, ' ').replace(/^\**\s*/, '').slice(0, 160));
      msg += `  ${esc(p.llm_provider)} (${p.win_count}W/${p.lose_count}L): ${summary}\n`;
    }
  }

  msg += failureSection([
    ['勝率トレンド', trendRes],
    ['LLM別パフォーマンス', llmPerfRes],
    ['ISABELパターン', patternRes]
  ]);

  return { message: msg, data: { trend, llmPerf, patterns } };
}

module.exports = { generateDailyReport, generateWeeklyReport };
