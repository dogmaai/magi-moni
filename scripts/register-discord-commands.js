// Jun-operated registration only. No Cloud Run, IAM or scheduler changes.
const commands = [
  { name: 'ask', description: 'AKA-1に質問・操作を依頼', options: [{ name: 'message', description: '質問・依頼内容', type: 3, required: true }] },
  { name: 'kill', description: '本人による即時緊急停止', options: [{ name: 'reason', description: '停止理由', type: 3 }] },
  { name: 'resume', description: '確認ボタンを経て取引再開' },
  ...['help', 'status', 'llm', 'report'].map(name => ({ name, description: `AKA-1 ${name}` })),
].map(c => ({ ...c, default_member_permissions: '0' }));

async function main() {
  if (!process.argv.includes('--apply')) {
    console.log('Dry run. --apply replaces guild commands on the configured MAGI application only.');
    console.log(JSON.stringify(commands, null, 2));
    return;
  }
  const { DISCORD_APPLICATION_ID: app, DISCORD_GUILD_ID: guild, MAGI_DISCORD_BOT_TOKEN: token } = process.env;
  if (!/^\d+$/.test(app || '') || !/^\d+$/.test(guild || '') || !token) throw new Error('Missing Discord application/guild/token');
  if (app === '1568798230559592640') throw new Error('Refusing to overwrite OpenClaw aka application commands');
  const response = await fetch(`https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`, {
    method: 'PUT', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands), redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Discord registration rejected: HTTP ${response.status}`);
  console.log('MAGI guild commands registered.');
}

main().catch(() => { console.error('Discord command registration failed (configuration, HTTP or timeout)'); process.exitCode = 1; });
