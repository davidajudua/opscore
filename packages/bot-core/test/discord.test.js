import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordBot, hasAnyRole } from '../src/discord.js';

function makeBot(overrides = {}) {
  return new DiscordBot({
    token: 'fake-token',
    clientId: '123456789',
    botPrefix: 'testbot',
    ...overrides,
  });
}

test('registerCommands does NOT PUT when no commands are registered (avoids wiping)', async () => {
  const bot = makeBot();
  let putCalled = false;
  // Inject a fake REST client via the documented `rest` seam.
  bot.rest = {
    put() {
      putCalled = true;
      return Promise.resolve(['should-not-happen']);
    },
  };
  const result = await bot.registerCommands();
  assert.equal(putCalled, false, 'must not call PUT with an empty body');
  assert.deepEqual(result, [], 'returns empty list as a no-op');
});

test('registerCommands DOES PUT when commands exist', async () => {
  const bot = makeBot();
  bot.command({ name: 'ping', description: 'pong' }, async () => {});
  let bodySent = null;
  bot.rest = {
    put(_route, opts) {
      bodySent = opts.body;
      return Promise.resolve(opts.body);
    },
  };
  const result = await bot.registerCommands();
  assert.equal(bodySent.length, 1);
  assert.equal(bodySent[0].name, 'ping');
  assert.equal(result.length, 1);
});

test('registerCommands with allowEmpty:true performs the empty PUT (explicit wipe)', async () => {
  const bot = makeBot();
  let putCalled = false;
  let bodySent;
  bot.rest = {
    put(_route, opts) {
      putCalled = true;
      bodySent = opts.body;
      return Promise.resolve([]);
    },
  };
  await bot.registerCommands({ allowEmpty: true });
  assert.equal(putCalled, true, 'explicit override should send the empty PUT');
  assert.deepEqual(bodySent, []);
});

test('start({registerCommands:true}) with no commands does not wipe (calls guarded no-op)', async () => {
  const bot = makeBot();
  let putCalled = false;
  bot.rest = {
    put() {
      putCalled = true;
      return Promise.resolve([]);
    },
  };
  // Stub login so we don't hit the network.
  bot.client.login = async () => bot.client;
  await bot.start({ registerCommands: true });
  assert.equal(putCalled, false, 'start() must not wipe commands when none are registered');
});

test('hasAnyRole matches case-insensitively and returns false without roles', () => {
  const pred = hasAnyRole(['Admin', 'Mod']);
  assert.equal(pred({ member: { roles: { cache: new Map([[1, { name: 'admin' }]]) } } }), true);
  assert.equal(pred({ member: { roles: { cache: new Map([[1, { name: 'guest' }]]) } } }), false);
  assert.equal(pred({ member: null }), false);
  assert.equal(pred({}), false);
});

test('customId / parseCustomId round-trip and reject foreign prefixes', () => {
  const bot = makeBot();
  const id = bot.customId('request', 'email', 'x1');
  assert.equal(id, 'testbot:request:email:x1');
  assert.deepEqual(bot.parseCustomId(id), { action: 'request', args: ['email', 'x1'] });
  assert.equal(bot.parseCustomId('otherbot:request:email'), null);
});
