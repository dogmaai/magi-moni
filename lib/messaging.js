/**
 * @module lib/messaging
 * Outbound messages for magi-moni. Discord is the only channel: Jun retired
 * every Telegram route on 2026-11-08 (magi-knowledge
 * system/services/discord-migration.md).
 *
 * Replies go only to the current Discord interaction's ephemeral followup;
 * reports and alerts go to the notification webhook. There is no fallback
 * channel.
 */
const { context } = require('./operator-context');
const discord = require('./discord');

/**
 * Reply to the operator who triggered the current interaction. Outside an
 * interaction there is no private destination, so the reply is dropped
 * rather than leaking operator-only content to the notification channel.
 */
async function sendTo(_target, message) {
  const operator = context.getStore();
  if (operator) return operator.reply(message);
  console.warn(`[MESSAGING] Reply outside a Discord interaction dropped (${String(message).length} chars)`);
  return false;
}

/** Send to the notification webhook (reports and alerts). */
async function sendNotification(message) {
  return discord.sendNotification(message);
}

/** Send a screenshot to the current interaction; outside one it is dropped. */
async function sendPhotoTo(_target, base64Jpeg, caption = '') {
  if (!context.getStore()) return false;
  return discord.sendPhoto(base64Jpeg, caption);
}

module.exports = { sendTo, sendNotification, sendPhotoTo };
