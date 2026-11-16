/**
 * @module lib/tools
 * AKA-1 tool definitions, handlers, and executor.
 * Includes original BigQuery/MooMoo tools plus system operation tools
 * ported from central-dogma (trigger_job, trigger_optuna, query_thoughts).
 */
const { GoogleAuth } = require('google-auth-library');
const { runQuery } = require('./bigquery');
const { callMoomoo } = require('./moomoo');
const { checkPolicy } = require('./policy-engine');
const { PROJECT_ID, REGION, nyDateString } = require('./config');
const { addFocusSymbol, removeFocusSymbol, listFocusSymbols, MAX_MANUAL_SYMBOLS } = require('./focus-symbols');
const { getKillSwitchStatus, setKillSwitch } = require('./kill-switch');
const { issueApproval, journalManualOrder } = require('./order-approvals');
const { getSymbolAnalysis } = require('./symbol-analysis');

// ===== Tool Definitions (Anthropic schema) =====

const AKA1_TOOLS = [
  // --- BigQuery read-only tools ---
  {
    name: 'get_today_trades',
    description:
      '本日 (America/New_York) の取引一覧を取得する。symbol / side / llm_provider / result / pnl_amount / timestamp を返す。',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '取得する最大件数 (1-100, default 20)'
        }
      }
    }
  },
  {
    name: 'get_winrate_by_llm',
    description:
      '指定期間の LLM × 方向別の勝率を返す。各行: llm_provider / side / trades / wins / losses / win_rate。',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: '過去何日間を集計するか (1-90, default 30)'
        }
      }
    }
  },
  {
    name: 'get_daily_summary',
    description:
      '指定日 (YYYY-MM-DD, America/New_York) の取引サマリーを返す。LLM 別の trades / wins / losses / win_rate / total_pnl_usd を含む。',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'YYYY-MM-DD 形式の日付 (省略時は本日)'
        }
      }
    }
  },
  {
    name: 'get_l4_status',
    description:
      'L4（方向適性層）の警告状況を返す。L4 は warn-only で取引をブロックしないため、返るのは直近 N 日に ' +
      '警告が出た LLM × 方向と件数・最終警告時刻。空配列なら警告無し（=ブロックされている LLM は存在しない）。',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: '過去何日間を集計するか (1-90, default 7)'
        }
      }
    }
  },
  {
    name: 'get_constitution',
    description:
      'MAGI Constitution（最上位ルール）を BigQuery から取得する。セクション名を指定すると該当セクションのみ返す。省略時は全文を返す。',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'セクション名（例: NORTH STAR, CORE PRINCIPLES, FORBIDDEN ACTIONS）。省略時は全文'
        }
      }
    }
  },
  {
    name: 'query_thoughts',
    description:
      'PLM の思考ログ (thoughts_active) を取得する。LLMプロバイダーや取引結果でフィルタ可能。reasoning / confidence / action 等を返す。',
    input_schema: {
      type: 'object',
      properties: {
        llm_provider: {
          type: 'string',
          description: 'LLMプロバイダー名（例: mistral, google, groq, deepseek）。省略時は全て'
        },
        trade_mode: {
          type: 'string',
          description: '取引モードフィルター: NORMAL / BLOCKED 等。省略時は全て'
        },
        limit: {
          type: 'integer',
          description: '取得件数 (1-200, default 10)'
        }
      }
    }
  },
  {
    name: 'get_symbol_analysis',
    description:
      '指定銘柄の詳細分析を llm_analysis から取得する（読取専用）。最新N件の判断理由・仮説・観測・懸念・目標価格・事後採点と、' +
      '期間全体のユニット×モード×action件数・最終分析時刻を返す。SHADOWを含む全モードが対象。分析は発注実績ではない。',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'ティッカーシンボル（必須。例: AAPL, BRK.B）' },
        days: { type: 'integer', description: '過去何日間を検索するか (1-30, default 7)' },
        limit: { type: 'integer', description: '最新分析の取得件数 (1-20, default 5)' },
        unit_name: { type: 'string', description: 'ユニット名（任意。例: MELCHIOR-1）。省略時は全て' },
        action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'], description: '分析上の判断（任意）。省略時は全て' },
      },
      required: ['symbol'],
    },
  },
  // --- MooMoo tools ---
  {
    name: 'moomoo_account_info',
    description:
      'MooMooペーパー取引口座の残高・資産情報を取得する。total_assets / cash / market_value / pnl 等を返す。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'moomoo_positions',
    description:
      'MooMooペーパー取引口座の保有ポジション一覧を取得する。各行: symbol / qty / cost_price / market_value / pnl 等。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'moomoo_quote',
    description:
      '指定シンボルの現在気配値を取得する。last_price / bid / ask / volume 等を返す。',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '銘柄シンボル (例: AAPL, TSLA, NVDA)'
        }
      },
      required: ['symbol']
    }
  },
  {
    name: 'moomoo_place_order',
    description:
      'MooMooペーパー取引口座で成行注文を発注する。SIMULATEモードのみ（本番取引不可）。' +
      '危険操作のため confirmed=true が必要。初回は confirmed なしで呼び、ユーザーに確認を取ること。' +
      '確認後は単発の承認トークンが発行され、サーバー側の発注ゲート（キルスイッチ・上限・承認検証）を通過してから発注される。' +
      'ゲートに拒否された場合は confirmed=true でも発注されない。',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄シンボル (例: AAPL)' },
        side: { type: 'string', description: '売買方向: BUY または SELL' },
        qty: { type: 'integer', description: '注文数量' },
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      },
      required: ['symbol', 'side', 'qty']
    }
  },
  {
    name: 'moomoo_connectivity',
    description:
      'MooMoo接続チェーン全体の疎通確認。proxy → bridge → OpenD の各ステップの状態を返す。',
    input_schema: { type: 'object', properties: {} }
  },
  // --- HERMES focus symbol tools ---
  {
    name: 'list_focus_symbols',
    description:
      'HERMES監視銘柄の一覧を返す。手動追加分 (manual_focus_symbols) と ISABEL 自動選定分 (focus_symbols, 本日分) の両方を含む。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'add_focus_symbol',
    description:
      '個別株シンボルを HERMES 監視銘柄に手動追加する（magi_core.manual_focus_symbols）。' +
      '追加後は HERMES がニュース/センチメントを毎回収集する（ISABEL の日次リストとは独立に永続）。' +
      `上限 ${MAX_MANUAL_SYMBOLS} 件。confirmed=true が必要。初回は confirmed なしで呼び、ユーザーに確認を取ること。`,
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄シンボル (例: PLTR, TSLA)' },
        note: { type: 'string', description: '監視理由メモ（省略可）' },
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'remove_focus_symbol',
    description:
      '手動追加した HERMES 監視銘柄を解除する（active=FALSE のソフト削除）。' +
      'ISABEL 自動選定分は削除できない。confirmed=true が必要。初回は confirmed なしで呼び、ユーザーに確認を取ること。',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '解除する銘柄シンボル (例: PLTR)' },
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      },
      required: ['symbol']
    }
  },
  // --- System operation tools (ported from central-dogma) ---
  {
    name: 'trigger_job',
    description:
      'Cloud Schedulerジョブを手動実行する。confirmed=true が必要。初回は confirmed なしで呼び、ユーザーに確認を取ること。',
    input_schema: {
      type: 'object',
      properties: {
        job_name: {
          type: 'string',
          description: 'Cloud Schedulerジョブ名（例: magi-optuna-optimizer, magi-core-main）'
        },
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      },
      required: ['job_name']
    }
  },
  // --- Emergency kill switch ---
  {
    name: 'emergency_kill',
    description:
      '緊急キルスイッチを発動する。magi-core の全注文（新規エントリー・決済とも）を L0 ガードで即時ブロックする。' +
      '安全側の操作のため確認不要で即時実行される。解除は resume_trading。',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '停止理由（例: 急落対応、誤発注発見）' }
      }
    }
  },
  {
    name: 'resume_trading',
    description:
      '緊急キルスイッチを解除して取引を再開する。confirmed=true が必要。' +
      '初回は confirmed なしで呼び、ユーザーに確認を取ること。',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      }
    }
  },
  {
    name: 'get_kill_status',
    description: '緊急キルスイッチの現在状態（停止中か否か、理由、最終更新）を返す。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'trigger_optuna',
    description:
      'Optuna再最適化を手動トリガーする（magi-optuna-optimizer ジョブを実行）。confirmed=true が必要。',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      }
    }
  },
];

// ===== Tool Handlers =====

async function akaTool_getTodayTrades({ limit }) {
  const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
  const query = `
    SELECT symbol, side, llm_provider, result,
           ROUND(pnl_amount, 2) AS pnl_usd, timestamp
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') = CURRENT_DATE('America/New_York')
    ORDER BY timestamp DESC
    LIMIT @lim
  `;
  const rows = await runQuery(query, { lim }, { lim: 'INT64' });
  return { count: rows.length, trades: rows };
}

async function akaTool_getWinrateByLlm({ days }) {
  const d = Math.max(1, Math.min(Number(days) || 30, 90));
  const query = `
    SELECT
      llm_provider,
      side,
      COUNT(*) AS trades,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS losses,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNTIF(result IN ('WIN','LOSE')), 0) * 100, 1) AS win_rate
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @d DAY)
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider, side
    ORDER BY llm_provider, side
  `;
  const rows = await runQuery(query, { d }, { d: 'INT64' });
  return { days: d, rows };
}

async function akaTool_getDailySummary({ date }) {
  const target = date || nyDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    throw new Error('date は YYYY-MM-DD 形式で指定してください');
  }
  const query = `
    SELECT
      llm_provider,
      COUNT(*) AS trades,
      COUNTIF(result = 'WIN') AS wins,
      COUNTIF(result = 'LOSE') AS losses,
      ROUND(COUNTIF(result = 'WIN') / NULLIF(COUNT(*), 0) * 100, 1) AS win_rate,
      ROUND(SUM(pnl_amount), 2) AS total_pnl_usd
    FROM \`${PROJECT_ID}.magi_core.trades_active\`
    WHERE DATE(timestamp, 'America/New_York') = @date
      AND result IN ('WIN','LOSE')
    GROUP BY llm_provider
    ORDER BY total_pnl_usd DESC
  `;
  const rows = await runQuery(query, { date: target });
  return { date: target, rows };
}

// L4 is warn-only in magi-core (src/paperGuards.js runL4Guard always returns
// null). There is no probation state; warnings are logged to magi_core.thoughts
// with concerns='L4' and action='WARN_ONLY'.
async function akaTool_getL4Status({ days }) {
  const d = Math.max(1, Math.min(Number(days) || 7, 90));
  const query = `
    SELECT
      llm_provider,
      unit_name,
      REGEXP_EXTRACT(reasoning, r'^(BUY|SELL)') AS side,
      COUNT(*) AS warnings,
      MAX(timestamp) AS last_warned_at,
      TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(timestamp), HOUR) AS hours_since_last
    FROM \`${PROJECT_ID}.magi_core.thoughts\`
    WHERE concerns = 'L4'
      AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @d DAY)
    GROUP BY llm_provider, unit_name, side
    ORDER BY last_warned_at DESC
  `;
  const rows = await runQuery(query, { d }, { d: 'INT64' });
  return {
    mode: 'WARN_ONLY',
    days: d,
    count: rows.length,
    rows,
    note: 'L4 は警告のみで取引をブロックしません。解除操作は存在しません。'
  };
}

async function akaTool_getConstitution({ section }) {
  const query = `
    SELECT version, content, sha256, effective_date, section_index
    FROM \`${PROJECT_ID}.magi_core.constitution\`
    WHERE deprecated_at IS NULL
    ORDER BY effective_date DESC
    LIMIT 1
  `;
  const rows = await runQuery(query);
  if (!rows.length) return { error: 'Constitution not found' };
  const row = rows[0];
  if (!section) {
    return {
      version: row.version,
      sha256: row.sha256,
      effective_date: row.effective_date?.value || row.effective_date,
      content: row.content
    };
  }
  const lines = row.content.split('\n');
  const sectionHeader = lines.findIndex(l =>
    l.startsWith('## ') && l.toLowerCase().includes(section.toLowerCase())
  );
  if (sectionHeader === -1) {
    const sections = JSON.parse(row.section_index || '[]');
    return { error: `Section "${section}" not found`, available_sections: sections };
  }
  const nextHeader = lines.findIndex(
    (l, i) => i > sectionHeader && l.startsWith('## ')
  );
  const sectionContent = lines
    .slice(sectionHeader, nextHeader === -1 ? undefined : nextHeader)
    .join('\n')
    .trim();
  return {
    version: row.version,
    sha256: row.sha256,
    section: lines[sectionHeader].replace(/^## /, ''),
    content: sectionContent
  };
}

async function akaTool_queryThoughts({ llm_provider, trade_mode, limit }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 200));
  const whereClauses = [];
  const params = {};

  if (llm_provider) {
    whereClauses.push('llm_provider = @llm_provider');
    params.llm_provider = llm_provider;
  }
  if (trade_mode) {
    whereClauses.push('trade_mode = @trade_mode');
    params.trade_mode = trade_mode.toUpperCase();
  }

  const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const query = `
    SELECT
      llm_provider, unit_name, symbol, action, trade_mode,
      reasoning, confidence, timestamp
    FROM \`${PROJECT_ID}.magi_core.thoughts_active\`
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT ${safeLimit}
  `;
  const rows = await runQuery(query, Object.keys(params).length ? params : undefined);
  return { count: rows.length, thoughts: rows };
}

async function akaTool_moomooAccountInfo() {
  return callMoomoo('/trade/account_info');
}

async function akaTool_moomooPositions() {
  return callMoomoo('/trade/positions');
}

async function akaTool_moomooQuote({ symbol }) {
  if (!symbol) throw new Error('symbol は必須です');
  return callMoomoo(`/trade/quote?symbol=${encodeURIComponent(symbol)}`);
}

async function akaTool_moomooPlaceOrder({ symbol, side, qty, confirmed }, operator) {
  if (!symbol || !side || !qty) throw new Error('symbol, side, qty は必須です');

  const policyResult = checkPolicy({ type: 'moomoo_place_order', symbol, side, qty });

  if (policyResult.result === 'blocked') {
    throw new Error(`policy blocked: ${policyResult.reason}`);
  }

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      symbol,
      side,
      qty,
      message: `${symbol} ${side.toUpperCase()} ${qty}株の成行注文を発注しますか？`,
      danger: policyResult.dangerMessage || null,
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  // Operator confirmed — issue a single-use approval token bound to these
  // params. The magi-moomoo order gate verifies and consumes it; without it
  // non-reducing orders are rejected. If this insert fails we cannot prove
  // approval, so fail closed before touching the broker.
  const approvalToken = await issueApproval({ symbol, side, qty, createdBy: `discord:${operator.actor}` });

  const result = await callMoomoo('/trade/place_order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol,
      side: side.toUpperCase(),
      qty: Number(qty),
      price: 0,
      order_type: 'MARKET',
      remark: 'AKA-1 Discord',
      source: 'magi-moni',
      approval_token: approvalToken
    })
  });

  // Journal the submitted order so manual fills land in the ledger
  // (price_confirmed=false → fill-reconcile reconciles later).
  try {
    await journalManualOrder({
      symbol, side, qty,
      orderId: result && (result.order_id || result.orderId),
      brokerStatus: result && result.status
    });
  } catch (e) {
    // The order was already submitted — never throw here or a retry could
    // duplicate it. Surface the journal failure in the result instead.
    console.error('[AKA-1] manual order journal failed:', e.message);
    result.journal_warning = 'order submitted but trades journal failed: ' + e.message;
  }
  return result;
}

async function akaTool_moomooConnectivity() {
  return callMoomoo('/connectivity');
}

// --- HERMES focus symbol tool handlers ---

async function akaTool_listFocusSymbols() {
  const { manual, isabel } = await listFocusSymbols();
  return {
    manual_count: manual.length,
    manual,
    isabel_today_count: isabel.length,
    isabel_today: isabel,
  };
}

async function akaTool_addFocusSymbol({ symbol, note, confirmed }, operator) {
  if (!symbol) throw new Error('symbol は必須です');

  const policyResult = checkPolicy({ type: 'add_focus_symbol', symbol });

  if (policyResult.result === 'blocked') {
    throw new Error(`policy blocked: ${policyResult.reason}`);
  }

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      symbol: symbol.toUpperCase(),
      message: `${symbol.toUpperCase()} をHERMES監視銘柄に追加しますか？（ニュース/センチメント収集コストが増えます）`,
      danger: policyResult.dangerMessage || null,
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  const result = await addFocusSymbol(symbol, { note: note || null, addedBy: `discord:${operator.actor}` });
  return {
    status: 'executed',
    message: `監視銘柄に追加しました: ${result.symbol}（手動監視: ${result.active_count}/${MAX_MANUAL_SYMBOLS}件）`
  };
}

async function akaTool_removeFocusSymbol({ symbol, confirmed }) {
  if (!symbol) throw new Error('symbol は必須です');

  const policyResult = checkPolicy({ type: 'remove_focus_symbol', symbol });

  if (policyResult.result === 'blocked') {
    throw new Error(`policy blocked: ${policyResult.reason}`);
  }

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      symbol: symbol.toUpperCase(),
      message: `${symbol.toUpperCase()} をHERMES監視銘柄から解除しますか？`,
      danger: policyResult.dangerMessage || null,
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  const result = await removeFocusSymbol(symbol);
  return result.removed
    ? { status: 'executed', message: `監視銘柄から解除しました: ${result.symbol}` }
    : { status: 'not_found', message: `${result.symbol} は手動監視銘柄に登録されていません` };
}

// --- System operation tool handlers (from central-dogma) ---

async function akaTool_triggerJob({ job_name, confirmed }) {
  if (!job_name) throw new Error('job_name は必須です');

  const policyResult = checkPolicy({ type: 'trigger_job', job_name });

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      job_name,
      message: `Cloud Schedulerジョブ「${job_name}」を手動実行しますか？`,
      danger: policyResult.dangerMessage || null,
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  const jobPath = `projects/${PROJECT_ID}/locations/${REGION}/jobs/${job_name}`;
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const res = await fetch(
    `https://cloudscheduler.googleapis.com/v1/${jobPath}:run`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloud Scheduler run failed: ${res.status} ${err}`);
  }

  return { status: 'executed', message: `ジョブ手動実行完了: ${job_name}` };
}

async function akaTool_triggerOptuna({ confirmed }) {
  const policyResult = checkPolicy({ type: 'trigger_optuna' });

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      message: 'Optuna再最適化（magi-optuna-optimizer）を手動実行しますか？',
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  return akaTool_triggerJob({ job_name: 'magi-optuna-optimizer', confirmed: true });
}

// ===== Emergency kill switch =====

function formatKillStatus(s) {
  if (s.unknown) {
    return '\u26A0\uFE0F 状態不明（system_control を読み取れません。magi-core はリスク増加注文のみブロック中）';
  }
  return s.halted
    ? `\u{1F6D1} 取引停止中 (理由: ${s.reason || 'なし'}, 発動: ${s.updated_by || '不明'}, ${s.updated_at || '--'})`
    : '\u2705 通常稼働中（キルスイッチは解除状態）';
}

async function akaTool_emergencyKill({ reason }, operator) {
  const state = await setKillSwitch(true, { reason: reason || null, updatedBy: `discord:${operator.actor}` });
  return {
    status: 'halted',
    message: '緊急キルスイッチを発動しました。magi-coreの全注文（新規・決済とも）がL0ガードでブロックされます。解除は /resume。',
    state: formatKillStatus(state)
  };
}

async function akaTool_resumeTrading({ confirmed }, operator) {
  if (!confirmed) {
    const s = await getKillSwitchStatus();
    return {
      status: 'confirmation_required',
      message: 'キルスイッチを解除して取引を再開しますか？',
      current_state: formatKillStatus(s),
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }
  const state = await setKillSwitch(false, { updatedBy: `discord:${operator.actor}` });
  return { status: 'resumed', message: 'キルスイッチを解除しました。取引を再開します。', state: formatKillStatus(state) };
}

async function akaTool_getKillStatus() {
  const s = await getKillSwitchStatus();
  return { ...s, summary: formatKillStatus(s) };
}

// ===== Handler map and executor =====

const AKA1_TOOL_HANDLERS = {
  get_today_trades: akaTool_getTodayTrades,
  get_winrate_by_llm: akaTool_getWinrateByLlm,
  get_daily_summary: akaTool_getDailySummary,
  get_l4_status: akaTool_getL4Status,
  get_constitution: akaTool_getConstitution,
  query_thoughts: akaTool_queryThoughts,
  get_symbol_analysis: getSymbolAnalysis,
  moomoo_account_info: akaTool_moomooAccountInfo,
  moomoo_positions: akaTool_moomooPositions,
  moomoo_quote: akaTool_moomooQuote,
  moomoo_place_order: akaTool_moomooPlaceOrder,
  moomoo_connectivity: akaTool_moomooConnectivity,
  list_focus_symbols: akaTool_listFocusSymbols,
  add_focus_symbol: akaTool_addFocusSymbol,
  remove_focus_symbol: akaTool_removeFocusSymbol,
  trigger_job: akaTool_triggerJob,
  trigger_optuna: akaTool_triggerOptuna,
  emergency_kill: akaTool_emergencyKill,
  resume_trading: akaTool_resumeTrading,
  get_kill_status: akaTool_getKillStatus,
};

const { context, consumeAuthorization } = require('./operator-context');
const READ_ONLY_TOOLS = new Set([
  'get_today_trades', 'get_winrate_by_llm', 'get_daily_summary', 'get_l4_status',
  'get_constitution', 'query_thoughts', 'get_symbol_analysis', 'moomoo_account_info', 'moomoo_positions',
  'moomoo_quote', 'moomoo_connectivity', 'list_focus_symbols', 'get_kill_status',
]);

async function executeAka1Tool(name, input, grant) {
  const handler = AKA1_TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const params = { ...(input || {}), confirmed: false };
  if (READ_ONLY_TOOLS.has(name)) return handler(params);
  const actor = consumeAuthorization(grant, name, params);
  if (!actor) {
    const operator = context.getStore();
    if (operator?.propose) return operator.propose(name, params);
    return { status: 'confirmation_required', message: 'Discord本人確認が必要です。confirmed=true は承認になりません。' };
  }
  return handler({ ...params, confirmed: true }, { actor });
}

// Convert Anthropic tool schema to Gemini function declarations
function toGeminiFunctionDeclarations() {
  return AKA1_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema
  }));
}

module.exports = {
  AKA1_TOOLS,
  executeAka1Tool,
  toGeminiFunctionDeclarations,
};
