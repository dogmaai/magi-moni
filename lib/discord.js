const { createPublicKey, verify } = require('node:crypto');
const { context, authorize, createPendingApprovals } = require('./operator-context');

function chunks(value) {
  const text = String(value).replace(/<\/?(?:b|strong|i|em|u|s|code|pre)>/gi, '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const result = [];
  let part = '';
  for (const c of text) {
    if (part.length + c.length > 2000) { result.push(part); part = ''; }
    part += c;
  }
  if (part) result.push(part);
  return result;
}

function webhookUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password ||
      !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('Invalid Discord webhook');
  url.search = '?wait=true';
  url.hash = '';
  return url.toString();
}

async function post(url, body, { fetchImpl = fetch, method = 'POST' } = {}) {
  try {
    const response = await fetchImpl(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2500), redirect: 'error',
    });
    if (!response.ok) throw new Error('Rejected');
    return true;
  } catch {
    // URL paths contain interaction tokens or webhook credentials.
    console.error('[DISCORD] Request failed (configuration, HTTP or timeout)');
    return false;
  }
}

async function sendText(url, message, options = {}) {
  const parts = chunks(message);
  for (const content of parts) {
    if (!await post(url, { content, allowed_mentions: { parse: [] }, ...options.payload }, options)) return false;
  }
  return parts.length > 0;
}

async function sendNotification(message) {
  try { return await sendText(webhookUrl(process.env.DISCORD_WEBHOOK_URL), message); }
  catch { console.error('[DISCORD] Notification not configured'); return false; }
}

function verifySignature(req, publicKey, now = Date.now()) {
  try {
    const signature = req.get('x-signature-ed25519');
    const timestamp = req.get('x-signature-timestamp');
    if (!/^[a-f0-9]{64}$/i.test(publicKey) || !/^[a-f0-9]{128}$/i.test(signature) ||
        !/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !Buffer.isBuffer(req.body)) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(timestamp), req.body]), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

function createInteractionHandler({ ask, command, execute, fetchImpl = fetch, env = process.env, pending = createPendingApprovals() }) {
  return async (req, res) => {
    if (!verifySignature(req, env.DISCORD_PUBLIC_KEY)) return res.sendStatus(401);
    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
    if (!env.DISCORD_APPLICATION_ID || event.application_id !== env.DISCORD_APPLICATION_ID) return res.sendStatus(403);
    if (event.type === 1) return res.json({ type: 1 });
    const identity = { actor: event.member?.user?.id, guild: event.guild_id, channel: event.channel_id };
    if (!env.DISCORD_OWNER_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_OPS_CHANNEL_ID ||
        identity.actor !== env.DISCORD_OWNER_ID || identity.guild !== env.DISCORD_GUILD_ID || identity.channel !== env.DISCORD_OPS_CHANNEL_ID) return res.sendStatus(403);
    if (![2, 3].includes(event.type) || !/^\d+$/.test(event.id) || !/^[A-Za-z0-9_.-]+$/.test(event.token)) return res.sendStatus(400);
    // Discord accepts the callback only once, even across Cloud Run instances.
    // Do not perform work if the ACK fails or its acceptance is uncertain.
    const ack = await post(`https://discord.com/api/v10/interactions/${event.id}/${event.token}/callback`, { type: 5, data: { flags: 64 } }, { fetchImpl });
    res.status(202).end();
    if (!ack) return;
    const url = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${event.token}`;
    const reply = text => sendText(url, text, { fetchImpl, payload: { flags: 64 } });
    const propose = async (name, input) => {
      const p = pending.create(name, input, identity);
      const content = `本人確認: ${name}\n${JSON.stringify(p.input)}\n60秒以内に確認してください。変更・再起動時は失効し、自動再実行しません。`;
      const ok = await post(url, { content, flags: 64, allowed_mentions: { parse: [] }, components: [{ type: 1, components: [
        { type: 2, style: 4, label: '確認して実行', custom_id: `approve:${p.id}` },
        { type: 2, style: 2, label: '取消', custom_id: `cancel:${p.id}` },
      ] }] }, { fetchImpl });
      if (!ok) pending.take(p.id, identity);
      return { status: ok ? 'confirmation_required' : 'confirmation_failed', message: 'Discord本人確認が必要です。confirmed=true は承認になりません。' };
    };
    try {
      await context.run({ ...identity, reply, propose, followupUrl: url }, async () => {
        if (event.type === 3) {
          const [action, id] = String(event.data?.custom_id || '').split(':');
          if (!['approve', 'cancel'].includes(action)) return reply('不明な操作です。');
          const p = pending.take(id, identity);
          if (!p) return reply('承認は失効済み・使用済み、または別インスタンスです。新しい操作としてやり直してください。');
          if (action === 'cancel') return reply('取り消しました。');
          const result = await execute(p.name, p.input, authorize(p.name, p.input, identity.actor));
          return reply(JSON.stringify(result));
        }
        const name = event.data?.name;
        const options = Object.fromEntries((event.data?.options || []).map(o => [o.name, o.value]));
        if (name === 'ask' && typeof options.message === 'string' && options.message.trim()) return ask(identity.actor, options.message);
        if (name === 'kill') {
          const input = { reason: String(options.reason || 'Discord operator') };
          return reply(JSON.stringify(await execute('emergency_kill', input, authorize('emergency_kill', input, identity.actor))));
        }
        if (name === 'resume') return propose('resume_trading', {});
        if (['help', 'status', 'llm', 'report'].includes(name)) return command(identity.actor, `/${name}`);
        return reply('未対応のコマンドです。/ask を使用してください。');
      });
    } catch {
      console.error('[DISCORD] Operator action failed; no automatic retry');
      await reply('処理に失敗しました。実行済みの可能性があるため、自動再試行しません。状態を確認してください。');
    }
  };
}

async function sendPhoto(base64, caption) {
  const active = context.getStore();
  if (!active) return false;
  try {
    const form = new FormData();
    const bytes = Buffer.from(base64.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return false;
    form.append('payload_json', JSON.stringify({ content: String(caption || '').slice(0, 2000), flags: 64, allowed_mentions: { parse: [] } }));
    form.append('files[0]', new Blob([bytes], { type: 'image/jpeg' }), 'screenshot.jpg');
    const response = await fetch(active.followupUrl, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(10000) });
    return response.ok;
  } catch { console.error('[DISCORD] Screenshot delivery failed'); return false; }
}

module.exports = { chunks, webhookUrl, post, sendText, sendNotification, verifySignature, createInteractionHandler, sendPhoto };
