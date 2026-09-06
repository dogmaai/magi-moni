/**
 * @module lib/tools
 * AKA-1 tool definitions, handlers, and executor.
 * Includes original BigQuery/MooMoo tools plus system operation tools
 * ported from central-dogma (trigger_job, trigger_optuna, query_thoughts).
 */
const { GoogleAuth } = require('google-auth-library');
const { runQuery } = require('./bigquery');
const { callMoomoo } = require('./moomoo');
const { callOpenClawAgent } = require('./openclaw');
const {
  getServicesStatus,
  restartService,
  executeCommand,
  getSystemInfo,
  getScreenshot,
  performAction,
} = require('./tiala');
const { checkPolicy } = require('./policy-engine');
const { PROJECT_ID, REGION, nyDateString } = require('./config');
const { addFocusSymbol, removeFocusSymbol, listFocusSymbols, MAX_MANUAL_SYMBOLS } = require('./focus-symbols');
const { getKillSwitchStatus, setKillSwitch } = require('./kill-switch');

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
      '危険操作のため confirmed=true が必要。初回は confirmed なしで呼び、ユーザーに確認を取ること。',
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
  // --- TIALA operation tools (OpenClaw Gateway via magi-moni) ---
  {
    name: 'tiala_services',
    description:
      'TIALA (Mac mini M4) 上の全サービス（Ollama, OpenD, moomoo-bridge, OpenClaw等）の稼働状態を取得する。' +
      'OpenClaw Gateway の exec ツールでポート/プロセスを確認し、稼働状況を返す。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'tiala_restart',
    description:
      'TIALA上の指定サービスを再起動する。OpenClaw Gateway の exec ツールで実行。' +
      '対応: ollama, moomoo-bridge。手動再起動が必要なサービス（opend, openclaw）はエラーを返す。' +
      '危険操作のため confirmed=true が必要。初回は confirmed なしで呼び、ユーザーに確認を取ること。',
    input_schema: {
      type: 'object',
      properties: {
        service_name: {
          type: 'string',
          description: 'サービス名: ollama, moomoo-bridge, openclaw, opend, ttyd, netdata'
        },
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      },
      required: ['service_name']
    }
  },
  {
    name: 'tiala_exec',
    description:
      'TIALA上で許可されたコマンドを実行する。OpenClaw Gateway の exec ツールで実行。' +
      'allowlist方式: git, ollama, brew, ls, cat, ps, curl 等のプレフィックスのみ。タイムアウト30秒。confirmed=true が必要。',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '実行するコマンド（例: "ollama list", "git status", "ps aux"）'
        },
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      },
      required: ['command']
    }
  },
  {
    name: 'tiala_system',
    description:
      'TIALAのシステム情報を取得する。OpenClaw Gateway の exec ツールで CPU, メモリ, ディスク, 稼働時間, ロードアベレージを返す。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'tiala_screenshot',
    description:
      'TIALAの画面をスクリーンショットで取得する。OpenClaw Gateway の exec ツール経由で macOS screencapture を実行し、Telegram に JPEG 画像として送信する。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'tiala_action',
    description:
      'TIALAの画面を操作する（OpenClaw Gateway の exec ツール経由で macOS osascript / cliclick を使用）。' +
      'クリック、入力、キー操作、スクロールなど。危険操作のため confirmed=true が必要。',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'アクション名（例: click, double_click, right_click, type, key, hotkey, scroll）'
        },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'クリック/スクロール先の [x, y] 座標（action=click/scroll 等で必要）'
        },
        text: {
          type: 'string',
          description: '入力する文字列（action=type で使用）'
        },
        key: {
          type: 'string',
          description: '単一キー名（action=key で使用、例: "return", "escape", "tab"）'
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'ホットキー組み合わせ（action=hotkey で使用、例: ["cmd","s"]）'
        },
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: 'スクロール方向（action=scroll で使用）'
        },
        amount: {
          type: 'integer',
          description: 'スクロール量や回数（action=scroll で使用）'
        },
        confirmed: { type: 'boolean', description: 'ユーザーが確認済みの場合 true を渡す' }
      },
      required: ['action']
    }
  },
  {
    name: 'openclaw_agent',
    description:
      'OpenClaw Gateway 上のエージェント（Sonnet 5 等）に自然言語で指示する。' +
      'TIALAの画面を見ながら computer / browser / exec ツールを使ってタスクを実行し、結果をテキストで返す。' +
      'OpenClaw 設定で `gateway.http.endpoints.chatCompletions.enabled: true` が必要。',
    input_schema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'エージェントへの指示（例: "デスクトップの時計を確認して教えて", "Safariを開いて dogma.jp を表示して"）'
        },
        model: {
          type: 'string',
          description: 'OpenClaw モデル/エージェント指定（省略時は openclaw/default）'
        },
        session_key: {
          type: 'string',
          description: '継続セッションを使う場合のセッションキー（省略可）'
        }
      },
      required: ['instruction']
    }
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

async function akaTool_moomooPlaceOrder({ symbol, side, qty, confirmed }) {
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

  return callMoomoo('/trade/place_order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol,
      side: side.toUpperCase(),
      qty: Number(qty),
      price: 0,
      order_type: 'MARKET',
      remark: 'AKA-1 Telegram'
    })
  });
}

async function akaTool_moomooConnectivity() {
  return callMoomoo('/connectivity');
}

// --- TIALA operation tool handlers ---

async function akaTool_tialaServices() {
  return getServicesStatus();
}

async function akaTool_tialaRestart({ service_name, confirmed }) {
  if (!service_name) throw new Error('service_name は必須です');

  const policyResult = checkPolicy({ type: 'tiala_restart', service_name });

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      service_name,
      message: `TIALA上の「${service_name}」を再起動しますか？`,
      danger: policyResult.dangerMessage || null,
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  return restartService(service_name);
}

async function akaTool_tialaExec({ command, confirmed }) {
  if (!command) throw new Error('command は必須です');

  const policyResult = checkPolicy({ type: 'tiala_exec', command });

  if (policyResult.result === 'blocked') {
    throw new Error(`policy blocked: ${policyResult.reason}`);
  }

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      command,
      message: `TIALA上でコマンド「${command}」を実行しますか？`,
      danger: policyResult.dangerMessage || null,
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  return executeCommand(command);
}

async function akaTool_tialaSystem() {
  return getSystemInfo();
}

async function akaTool_tialaScreenshot() {
  const result = await getScreenshot();
  // The full base64 image is cached in lib/tiala.js and sent to Telegram by handleAka1Chat.
  // Return a compact summary so the LLM tool message does not carry megabytes of base64.
  return {
    status: result.status,
    source: result.source,
    contentType: result.contentType,
    base64_length: result.base64?.length || 0,
    note: 'Screenshot captured and will be sent to the chat as an image.'
  };
}

async function akaTool_tialaAction({ action, coordinate, text, key, keys, direction, amount, confirmed }) {
  if (!action) throw new Error('action は必須です');

  const policyResult = checkPolicy({ type: 'tiala_action', action, coordinate, text });

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      action,
      coordinate,
      text,
      message: `TIALA画面で「${action}」を実行しますか？`,
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  return performAction({ action, coordinate, text, key, keys, direction, amount });
}

async function akaTool_openclawAgent({ instruction, model, session_key, confirmed }) {
  if (!instruction) throw new Error('instruction は必須です');

  const policyResult = checkPolicy({ type: 'openclaw_agent', instruction });

  if (policyResult.result === 'confirm_required' && !confirmed) {
    return {
      status: 'confirmation_required',
      instruction,
      message: `OpenClaw エージェントに「${instruction}」を実行させますか？`,
      danger: policyResult.dangerMessage || null,
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }

  return callOpenClawAgent(instruction, { model, sessionKey: session_key });
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

async function akaTool_addFocusSymbol({ symbol, note, confirmed }) {
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

  const result = await addFocusSymbol(symbol, { note: note || null });
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
  return s.halted
    ? `\u{1F6D1} 取引停止中 (理由: ${s.reason || 'なし'}, 発動: ${s.updated_by || '不明'}, ${s.updated_at || '--'})`
    : '\u2705 通常稼働中（キルスイッチは解除状態）';
}

async function akaTool_emergencyKill({ reason }) {
  const state = await setKillSwitch(true, { reason: reason || null, updatedBy: 'aka-1' });
  return {
    status: 'halted',
    message: '緊急キルスイッチを発動しました。magi-coreの全注文（新規・決済とも）がL0ガードでブロックされます。解除は /resume。',
    state: formatKillStatus(state)
  };
}

async function akaTool_resumeTrading({ confirmed }) {
  if (!confirmed) {
    const s = await getKillSwitchStatus();
    return {
      status: 'confirmation_required',
      message: 'キルスイッチを解除して取引を再開しますか？',
      current_state: formatKillStatus(s),
      hint: 'ユーザーが同意したら confirmed=true で再度呼び出してください'
    };
  }
  const state = await setKillSwitch(false, { updatedBy: 'aka-1' });
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
  moomoo_account_info: akaTool_moomooAccountInfo,
  moomoo_positions: akaTool_moomooPositions,
  moomoo_quote: akaTool_moomooQuote,
  moomoo_place_order: akaTool_moomooPlaceOrder,
  moomoo_connectivity: akaTool_moomooConnectivity,
  tiala_services: akaTool_tialaServices,
  tiala_restart: akaTool_tialaRestart,
  tiala_exec: akaTool_tialaExec,
  tiala_system: akaTool_tialaSystem,
  tiala_screenshot: akaTool_tialaScreenshot,
  tiala_action: akaTool_tialaAction,
  openclaw_agent: akaTool_openclawAgent,
  list_focus_symbols: akaTool_listFocusSymbols,
  add_focus_symbol: akaTool_addFocusSymbol,
  remove_focus_symbol: akaTool_removeFocusSymbol,
  trigger_job: akaTool_triggerJob,
  trigger_optuna: akaTool_triggerOptuna,
  emergency_kill: akaTool_emergencyKill,
  resume_trading: akaTool_resumeTrading,
  get_kill_status: akaTool_getKillStatus,
};

async function executeAka1Tool(name, input) {
  const handler = AKA1_TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(input || {});
}

// Convert Anthropic tool schema to Gemini function declarations
function toGeminiFunctionDeclarations() {
  return AKA1_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema
  }));
}

// Convert Anthropic tool schema to OpenAI function tools (Sakana Chat Completions / Ollama)
function toOpenAiFunctionTools() {
  return AKA1_TOOLS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }
  }));
}

// Convert Anthropic tool schema to Sakana Responses API tool definitions.
// Responses API uses a flat function schema without the nested `function` key.
function toSakanaResponsesTools() {
  return AKA1_TOOLS.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema
  }));
}

module.exports = {
  AKA1_TOOLS,
  executeAka1Tool,
  toGeminiFunctionDeclarations,
  toOpenAiFunctionTools,
  toSakanaResponsesTools,
};
