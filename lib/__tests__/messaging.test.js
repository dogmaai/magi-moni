const test = require('node:test');
const assert = require('node:assert');
const discord = require('../discord');
const { context } = require('../operator-context');
const { sendTo } = require('../messaging');

test('sendTo outside an interaction does not reach the notification webhook', async () => {
  const original = discord.sendNotification;
  let calls = 0;
  discord.sendNotification = async () => { calls += 1; return true; };
  try {
    assert.equal(context.getStore(), undefined);
    assert.equal(await sendTo(null, 'balance: secret'), false);
    assert.equal(calls, 0);
  } finally {
    discord.sendNotification = original;
  }
});

test('sendTo inside an interaction replies to the operator', async () => {
  const replies = [];
  await context.run({ reply: async m => { replies.push(m); return true; } }, async () => {
    assert.equal(await sendTo(null, 'hello'), true);
  });
  assert.deepEqual(replies, ['hello']);
});
