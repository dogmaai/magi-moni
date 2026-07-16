/**
 * @module lib/commands
 * Telegram slash command handler (handleBotCommand).
 */
const { sendTelegramTo } = require('./telegram');
const { bq, runQuery } = require('./bigquery');
const { getLastResponseModel } = require('./llm');
const {
  PROJECT_ID, SAKANA_API_KEY, SAKANA_MODEL,
  OLLAMA_BASE_URL, OLLAMA_MODEL,
  GEMINI_API_KEY, GEMINI_FALLBACK_MODEL,
} = require('./config');

const SESSION_STATUS_UP_MINUTES = 30;
const SESSION_STATUS_UP_HOURS = 24;

function parseTimestamp(ts) {
  if (!ts) return null;
  return ts.value ? new Date(ts.value) : new Date(ts);
}

async function queryLatestSessions() {
  const query = `
    SELECT
      session_id,
      llm_provider,
      started_at,
      ended_at,
      total_trades,
      pnl,
      pnl_percent
    FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY llm_provider ORDER BY started_at DESC) AS rn
      FROM \`${PROJECT_ID}.magi_core.sessions\`
      WHERE started_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    )
    WHERE rn = 1
    ORDER BY started_at DESC
  `;
  const rows = await runQuery(query).catch((e) => {
    console.error('[MONI] queryLatestSessions error:', e.message);
    return [];
  });

  return rows.map((r) => {
    const startedAt = parseTimestamp(r.started_at);
    const endedAt = parseTimestamp(r.ended_at);
    const lastRun = endedAt || startedAt;
    const now = Date.now();
    const startedAgo = startedAt ? now - startedAt.getTime() : null;
    const endedAgo = endedAt ? now - endedAt.getTime() : null;

    let status = 'DOWN';
    if (!endedAt && startedAgo !== null && startedAgo < SESSION_STATUS_UP_MINUTES * 60 * 1000) {
      status = 'RUNNING';
    } else if (startedAgo !== null && startedAgo < SESSION_STATUS_UP_HOURS * 60 * 60 * 1000) {
      status = 'SUCCESS';
    }

    return {
      llm_provider: r.llm_provider,
      status,
      lastRun,
      startedAt,
      endedAt,
      total_trades: Number(r.total_trades || 0),
      pnl: r.pnl != null ? Number(r.pnl) : null,
      pnl_percent: r.pnl_percent != null ? Number(r.pnl_percent) : null,
    };
  });
}

async function queryTodaySummary() {
  const query = `
    SELECT
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS loses,
      COUNTIF(result NOT IN ('WIN', 'LOSE', 'AUTO_CLOSE') OR result IS NULL) AS holds
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') = CURRENT_DATE('America/New_York')
  `;
  const rows = await runQuery(query).catch((e) => {
    console.error('[MONI] queryTodaySummary error:', e.message);
    return [];
  });
  const r = rows[0] || {};
  return {
    wins: Number(r.wins || 0),
    loses: Number(r.loses || 0),
    holds: Number(r.holds || 0)
  };
}

async function queryOverallStats() {
  const query = `
    SELECT
      COUNTIF(result = 'WIN') AS total_wins,
      COUNTIF(result = 'LOSE') AS total_loses,
      ROUND(
        COUNTIF(result = 'WIN')
          / NULLIF(COUNTIF(result IN ('WIN','LOSE')), 0) * 100,
        1
      ) AS overall_wr
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE result IN ('WIN', 'LOSE')
  `;
  const rows = await runQuery(query).catch((e) => {
    console.error('[MONI] queryOverallStats error:', e.message);
    return [];
  });
  const r = rows[0] || {};
  return {
    total_wins: Number(r.total_wins || 0),
    total_loses: Number(r.total_loses || 0),
    overall_wr: r.overall_wr ?? null
  };
}

async function queryTradeMetrics({ days = 30 } = {}) {
  const query = `
    SELECT
      llm_provider,
      side,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS loses,
      ROUND(
        COUNTIF(result = 'WIN')
          / NULLIF(COUNTIF(result IN ('WIN','LOSE')), 0) * 100,
        1
      ) AS win_rate
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      AND result IN ('WIN', 'LOSE')
      AND llm_provider IS NOT NULL
      AND side IS NOT NULL
    GROUP BY llm_provider, side
    HAVING wins + loses >= 1
    ORDER BY llm_provider, side
  `;
  const rows = await runQuery(query, { days }, { days: 'INT64' }).catch((e) => {
    console.error('[MONI] queryTradeMetrics error:', e.message);
    return [];
  });
  return rows.map((r) => ({
    llm_provider: r.llm_provider,
    side: r.side,
    wins: Number(r.wins || 0),
    loses: Number(r.loses || 0),
    win_rate: r.win_rate ?? null
  }));
}

async function handleBotCommand(chatId, text) {
  const cmd = text.split(' ')[0].toLowerCase().replace('@magi_claw_bot', '');

  if (cmd === '/help' || cmd === '/start') {
    return sendTelegramTo(chatId,
      `[MAGI Monitor] コマンド一覧\n\n` +
      `/status  - LLM API死活 + 本日サマリー\n` +
      `/wr      - LLM x 方向別勝率テーブル\n` +
      `/jobs    - Cloud Run Jobs状態\n` +
      `/today   - 本日の取引一覧\n` +
      `/llm     - AKA-1 の現在の LLM 設定\n` +
      `/help    - このメッセージ\n\n` +
      `📝 自然文での質問 (AKA-1 / Sakana AI ${SAKANA_MODEL}) にも対応しています。\n` +
      `例: 「直近1週間のGroqの勝率は？」「今日のWIN件数を教えて」\n\n` +
      `🔧 システム操作もAKA-1経由で可能です:\n` +
      `例: 「GroqのSELLブロックを解除して」「Optunaを実行して」\n\n` +
      `🖥️ TIALA操作 (OpenClaw Gateway 経由):\n` +
      `例: 「TIALAのサービス状態を確認して」「Ollamaを再起動して」「ollama listを実行して」「TIALAの画面を撮って」「OpenClawに○○してと指示して」`
    );
  }

  if (cmd === '/llm') {
    const sakana = SAKANA_API_KEY ? `✓ ${SAKANA_MODEL}` : '✗ SAKANA_API_KEY 未設定';
    const ollama = OLLAMA_BASE_URL ? `✓ ${OLLAMA_MODEL}` : '✗ OLLAMA_BASE_URL 未設定';
    const gemini = GEMINI_API_KEY ? `✓ ${GEMINI_FALLBACK_MODEL}` : '✗ GEMINI_API_KEY 未設定';
    const actual = getLastResponseModel()
      ? `\n実モデル (API確認): ${getLastResponseModel()}`
      : '\n実モデル: まだ応答なし（自然文を送ると記録されます）';
    return sendTelegramTo(chatId,
      `[AKA-1] LLM 設定\n\n` +
      `Primary: Sakana AI — ${sakana}\n` +
      `Fallback 1: Ollama (TIALA) — ${ollama}\n` +
      `Fallback 2: Gemini — ${gemini}${actual}\n\n` +
      `※ Sakana AI を常に優先。失敗時は Ollama → Gemini の順にフォールバック。`
    );
  }

  if (cmd === '/status') {
    try {
      const [today, overall, sessions] = await Promise.all([
        queryTodaySummary(),
        queryOverallStats(),
        queryLatestSessions(),
      ]);
      const upList = sessions.filter((s) => s.status !== 'DOWN').map((s) => s.llm_provider);
      const downList = sessions.filter((s) => s.status === 'DOWN').map((s) => s.llm_provider);
      let msg = `[MAGI Status] ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n\n`;
      msg += `総合勝率: ${overall.overall_wr ?? '--'}% (${overall.total_wins ?? 0}W ${overall.total_loses ?? 0}L)\n`;
      msg += `評価済み: ${(overall.total_wins ?? 0) + (overall.total_loses ?? 0)} 件\n\n`;
      msg += `本日: WIN ${today.wins} / LOSE ${today.loses} / HOLD ${today.holds}\n\n`;
      msg += `LLM API UP: ${upList.length > 0 ? upList.join(', ') : 'なし'}\n`;
      if (downList.length > 0) msg += `DOWN: ${downList.join(', ')}\n`;
      return sendTelegramTo(chatId, msg);
    } catch (e) { return sendTelegramTo(chatId, `[MAGI] /status エラー: ${e.message}`); }
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
      return sendTelegramTo(chatId, msg);
    } catch (e) { return sendTelegramTo(chatId, `[MAGI] /wr エラー: ${e.message}`); }
  }

  if (cmd === '/jobs') {
    try {
      const sessions = await queryLatestSessions();
      let msg = `[MAGI] Cloud Run Jobs\n\n`;
      if (sessions.length === 0) {
        msg += 'セッションが取得できません。`magi_core.sessions` にデータが無いか、権限を確認してください。';
      } else {
        for (const s of sessions) {
          const icon = s.status === 'SUCCESS' ? 'OK' : s.status === 'RUNNING' ? 'RUN' : s.status === 'DOWN' ? 'FAIL' : '??';
          const diff = s.lastRun ? Math.floor((Date.now() - s.lastRun.getTime()) / 60000) : null;
          const ago = diff !== null ? (diff < 60 ? `${diff}m前` : `${Math.floor(diff/60)}h前`) : '--';
          msg += `[${icon}] ${s.llm_provider} (${ago})\n`;
        }
      }
      return sendTelegramTo(chatId, msg);
    } catch (e) { return sendTelegramTo(chatId, `[MAGI] /jobs エラー: ${e.message}`); }
  }

  if (cmd === '/today') {
    try {
      const query = `SELECT symbol, side, llm_provider, result, timestamp FROM \`${PROJECT_ID}.magi_core.trades_active\` WHERE DATE(timestamp, 'America/New_York') = CURRENT_DATE('America/New_York') ORDER BY timestamp DESC LIMIT 20`;
      const [rows] = await bq.query({ query, useLegacySql: false });
      if (rows.length === 0) return sendTelegramTo(chatId, '[MAGI] 本日の取引はまだありません');
      let msg = `[MAGI] 本日の取引 (${rows.length}件)\n\n`;
      for (const r of rows) {
        const result = r.result || 'pending';
        const time = new Date(r.timestamp?.value || r.timestamp).toLocaleTimeString('ja-JP', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
        msg += `${time} ${r.symbol} ${r.side} [${r.llm_provider}] -> ${result}\n`;
      }
      return sendTelegramTo(chatId, msg);
    } catch (e) { return sendTelegramTo(chatId, `[MAGI] /today エラー: ${e.message}`); }
  }

  return sendTelegramTo(chatId, `[MAGI] 不明なコマンド: ${cmd}\n/help でコマンド一覧を確認してください`);
}

module.exports = { handleBotCommand };
