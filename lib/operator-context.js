const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const context = new AsyncLocalStorage();
const grants = new WeakMap();
const clean = input => JSON.parse(JSON.stringify({ ...input, confirmed: undefined }));

function authorize(name, input, actor) {
  const grant = Object.freeze({});
  grants.set(grant, { name, input: JSON.stringify(clean(input)), actor });
  return grant;
}

function consumeAuthorization(grant, name, input) {
  const record = grant && grants.get(grant);
  if (!record) return null;
  grants.delete(grant);
  return record.name === name && record.input === JSON.stringify(clean(input)) ? record.actor : null;
}

// Pending approvals intentionally do not survive a restart or move between instances.
// Only the instance winning Discord's one-shot initial ACK creates an approval.
function createPendingApprovals({ now = Date.now, ttl = 60000 } = {}) {
  const pending = new Map();
  return {
    create(name, input, identity) {
      for (const [id, p] of pending) if (p.expires <= now()) pending.delete(id);
      if (pending.size >= 100) throw new Error('Too many pending approvals');
      const snapshot = clean(input);
      if (JSON.stringify(snapshot).length > 1200) throw new Error('Operation too large to confirm');
      const id = randomUUID();
      pending.set(id, { name, input: snapshot, ...identity, expires: now() + ttl });
      return { id, name, input: snapshot };
    },
    take(id, identity) {
      const p = pending.get(id);
      if (!p || p.expires <= now()) { pending.delete(id); return null; }
      if (['actor', 'guild', 'channel'].some(k => p[k] !== identity[k])) return null;
      pending.delete(id);
      return p;
    },
  };
}

module.exports = { context, authorize, consumeAuthorization, createPendingApprovals };
