/**
 * @module lib/policy-engine
 * Policy Engine for system operation commands.
 * Ported from central-dogma/policy-engine.js for Telegram bot unification.
 *
 * Determines whether a parsed command is safe to execute immediately,
 * requires user confirmation, or is blocked by policy.
 */

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
  tiala_exec: {
    risk: 'medium',
    requiresConfirmation: true,
    description: 'TIALAでのコマンド実行',
    isDangerous: (cmd) => {
      const c = (cmd.command || '').trim();
      return c.startsWith('git pull') || c.startsWith('ollama pull');
    },
    dangerReason: 'pull操作は時間がかかる場合があります。実行しますか？'
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
