/**
 * @module lib/policy-engine
 * Policy Engine for system operation commands and AKA-1 tools.
 * Ported from central-dogma/policy-engine.js for Telegram bot unification.
 *
 * Determines whether a parsed command is safe to execute immediately,
 * requires user confirmation, or is blocked by policy.
 */

const TIALA_ALLOWED_PREFIXES = [
  'brew', 'cat', 'chmod', 'chown', 'cmake', 'cp', 'curl', 'date', 'df', 'dig',
  'docker', 'docker-compose', 'du', 'echo', 'find', 'gcloud', 'git', 'grep',
  'head', 'hostname', 'htop', 'ifconfig', 'jq', 'kill', 'killall', 'kubectl',
  'launchctl', 'ls', 'make', 'mkdir', 'mongo', 'mysql', 'netstat', 'networksetup',
  'node', 'npm', 'npx', 'nslookup', 'ollama', 'passwd', 'pgrep', 'ping', 'pkill',
  'pm2', 'ps', 'pwd', 'python', 'python3', 'redis-cli', 'route', 'rsync', 'scp',
  'sed', 'service', 'sort', 'sqlite3', 'ssh', 'systemctl', 'tail', 'tar', 'tee',
  'top', 'traceroute', 'uname', 'uniq', 'unzip', 'vagrant', 'vault', 'wc', 'wget',
  'which', 'whoami', 'xargs', 'yarn', 'yq', 'zip'
];

const TIALA_BLOCKED_PATTERNS = [
  /;\s*/, /&&/, /\|\|/, /\|/, /\$\(/, /\$\{/, /<\(|\)>/, /`/, /[<>]/,
  /2>&1/, /&\s*$/, /:\(\)\{/, /base64\s+-d/, /perl\s+-e/, /python[\d.]*\s+-c/,
  /rm\s+-rf/, /rm\s+\//, /mkfs/, /dd\s+if=/, /eval\s/, /exec\s/,
];

const COMMAND_POLICIES = {
  unblock_l4: {
    risk: 'medium',
    requiresConfirmation: true,
    description: 'L4プロベーションの手動解除',
    isDangerous: (cmd) => !cmd.llm && !cmd.side,
    dangerReason: '全LLM・全方向のL4ブロックを一括解除します。意図した操作ですか？'
  },
  trigger_job: {
    risk: 'medium',
    requiresConfirmation: true,
    description: 'Cloud Schedulerジョブの手動実行',
    isDangerous: (cmd) => cmd.job_name === 'magi-core-main',
    dangerReason: 'メイン取引ジョブを手動実行します。市場時間外でも取引が発生する可能性があります。'
  },
  trigger_optuna: {
    risk: 'low',
    requiresConfirmation: true,
    description: 'Optuna再最適化の実行',
    isDangerous: () => false,
    dangerReason: null
  },
  tiala_restart: {
    risk: 'medium',
    requiresConfirmation: true,
    description: 'TIALAサービスの再起動',
    isDangerous: (cmd) => cmd.service_name === 'opend',
    dangerReason: 'OpenDを再起動すると取引接続が一時的に切断されます。'
  },
  tiala_action: {
    risk: 'medium',
    requiresConfirmation: true,
    description: 'TIALA画面操作（クリック・入力・キー等）',
    isDangerous: () => false,
    dangerReason: null
  },
  tiala_exec: {
    risk: 'medium',
    requiresConfirmation: true,
    description: 'TIALAでのコマンド実行',
    isBlocked: (cmd) => {
      const command = (cmd.command || '').trim();
      if (!command) return { blocked: true, reason: 'コマンドが空です' };
      const first = command.split(/\s+/)[0].toLowerCase();
      if (!TIALA_ALLOWED_PREFIXES.includes(first)) {
        return { blocked: true, reason: `許可されていないコマンドプレフィックス: ${first}` };
      }
      for (const p of TIALA_BLOCKED_PATTERNS) {
        if (p.test(command)) {
          return { blocked: true, reason: '禁止されたシェル構文が含まれています' };
        }
      }
      return { blocked: false };
    },
    isDangerous: (cmd) => {
      const c = (cmd.command || '').trim();
      return c.startsWith('git pull') || c.startsWith('ollama pull');
    },
    dangerReason: 'pull操作は時間がかかる場合があります。実行しますか？'
  },
  moomoo_place_order: {
    risk: 'high',
    requiresConfirmation: true,
    description: 'MooMooペーパー取引口座への成行注文',
    isBlocked: (cmd) => {
      const side = (cmd.side || '').toUpperCase();
      const qty = Number(cmd.qty);
      if (!['BUY', 'SELL'].includes(side)) {
        return { blocked: true, reason: 'side は BUY または SELL のみ許可されています' };
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        return { blocked: true, reason: 'qty は正の整数が必要です' };
      }
      if (qty > 1000) {
        return { blocked: true, reason: 'qty が大きすぎます（最大 1000）' };
      }
      return { blocked: false };
    },
    isDangerous: (cmd) => Number(cmd.qty) > 100,
    dangerReason: '数量100を超える注文です。確認してください。'
  },
};

/**
 * @param {{ type: string, [key: string]: any }} parsedCommand
 * @returns {{ result: 'safe'|'confirm_required'|'blocked', reason: string, dangerMessage: string|null }}
 */
function checkPolicy(parsedCommand) {
  const { type } = parsedCommand;
  const policy = COMMAND_POLICIES[type];

  if (!policy) {
    return { result: 'safe', reason: 'No policy defined', dangerMessage: null };
  }

  if (policy.isBlocked) {
    const block = policy.isBlocked(parsedCommand);
    if (block.blocked) {
      return {
        result: 'blocked',
        reason: block.reason || 'Policy blocked',
        dangerMessage: null,
      };
    }
  }

  const isDangerous = policy.isDangerous ? policy.isDangerous(parsedCommand) : false;

  if (isDangerous) {
    return {
      result: 'confirm_required',
      reason: 'HIGH RISK: 危険操作のため確認が必要です',
      dangerMessage: policy.dangerReason,
    };
  }

  if (policy.requiresConfirmation) {
    return {
      result: 'confirm_required',
      reason: `${policy.description} - 実行確認が必要です`,
      dangerMessage: null,
    };
  }

  return { result: 'safe', reason: 'Policy check passed', dangerMessage: null };
}

module.exports = { checkPolicy };
