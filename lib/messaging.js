/**
 * @module lib/messaging
 * Outbound messages for magi-moni. Discord is the only channel: Jun retired
 * every Telegram route on 2026-11-08 (magi-knowledge
 * system/services/discord-migration.md).
 *
 * Inside a Discord interaction (operator context) replies go to that
 * interaction's ephemeral followup; otherwise they go to the notification
 * webhook. There is no fallback channel.
 */
const { context } = require('./operator-context');
const discord = require('./discord');

/** Reply to the operator who triggered the current interaction, or notify. */
async function sendTo(_target, message) {
  const operator = context.getStore();
  if (operator) return operator.reply(message);
  return discord.sendNotification(message);
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
