import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCardVault } from '../src/card-vault.js';
import { addProvider, cardCount, getCardSession, loadCards, openInventory, setWhitelist } from '../src/inventory.js';
import {
  cardActionHandler,
  cardHandler,
  exportHandler,
  providersButtonHandler,
} from '../src/commands.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const CARDS = [
  { card_number: '378282246310005', mm: '09', yy: '2031', cvv: '7351', zip: '90210' },
  { card_number: '371449635398431', mm: '10', yy: '2032', cvv: '8462' },
];
const SECRETS = CARDS.flatMap((c) => [c.card_number, c.cvv]);

function capturingLogger(lines) {
  const log = (...args) => lines.push(JSON.stringify(args));
  const logger = { debug: log, info: log, warn: log, error: log, child: () => logger };
  return logger;
}

/** Everything a payload would show in Discord, flattened to one string. */
function visible(payload) {
  return JSON.stringify(
    (payload.components ?? []).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c)),
  ) + (payload.content ?? '');
}

let interactionSequence = 0;

function interaction({ admin = false, userId = 'worker', messageId, originId, options = {} } = {}) {
  const sent = [];
  return {
    sent,
    id: `interaction-${++interactionSequence}`,
    channelId: 'chan',
    user: { id: userId },
    member: { roles: { cache: new Map(admin ? [['r', { name: 'owner' }]] : []) } },
    message: messageId ? { id: messageId, ...(originId ? { interactionMetadata: { id: originId, user: { id: 'worker' } } } : {}) } : undefined,
    replied: false,
    deferred: false,
    options: { getString: (name) => options[name] ?? null },
    async reply(p) { this.replied = true; sent.push(p); },
    async followUp(p) { sent.push(p); },
    async update(p) { sent.push(p); },
    async fetchReply() { return { id: 'claim-msg' }; },
  };
}

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'card-bot-'));
  const vault = createCardVault(randomBytes(32));
  const db = await openInventory({ dbPath: path.join(dir, 'card.db'), migrationsDir: MIGRATIONS, vault });
  addProvider(db, { id: 'amex', name: 'Amex' });
  setWhitelist(db, 'chan', 'card', true);
  loadCards(db, vault, 'amex', CARDS);
  const logLines = [];
  const ctx = {
    db,
    vault,
    env: { ADMIN_ROLE_NAME: 'owner' },
    logger: capturingLogger(logLines),
    bot: { customId: (...a) => a.join(':') },
    repoRoot: dir,
  };
  return { ctx, logLines, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the claimer sees the full card, and the message drops to the last four once resolved', async () => {
  const { ctx, logLines, cleanup } = await setup();
  try {
    const claim = interaction();
    await cardHandler(ctx)(claim);
    const shown = visible(claim.sent[0]);
    for (const value of [CARDS[0].card_number, CARDS[0].cvv, '09/2031', '90210']) {
      assert.ok(shown.includes(value), `claim message shows ${value}`);
    }

    const used = interaction({ messageId: 'claim-msg' });
    await cardActionHandler(ctx)(used, ['used']);
    const after = visible(used.sent[0]);
    assert.ok(after.includes('•••• 0005'), 'resolved message shows the last four');
    for (const secret of SECRETS) assert.ok(!after.includes(secret), `resolved message hides ${secret}`);

    for (const secret of SECRETS) {
      assert.ok(!logLines.some((l) => l.includes(secret)), `no log line contains ${secret}`);
    }
  } finally {
    cleanup();
  }
});

/** Every button in a payload, as Discord receives it. */
function buttons(payload) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node.type === 2 && node.custom_id) found.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk((payload.components ?? []).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c)));
  return found;
}

test('the cards browser lists last four digits only, and its provider filter works', async () => {
  const { ctx, cleanup } = await setup();
  try {
    addProvider(ctx.db, { id: 'cap1', name: 'Capital One' });
    loadCards(ctx.db, ctx.vault, 'cap1', [{ card_number: '4111111111111111', mm: '11', yy: '2033', cvv: '123' }]);

    const browse = interaction({ admin: true });
    await providersButtonHandler(ctx)(browse, ['opencards']);
    const shown = visible(browse.sent[0]);
    for (const row of ['[amex] •••• 0005', '[amex] •••• 8431', '[cap1] •••• 1111']) {
      assert.ok(shown.includes(row), `browser lists ${row}`);
    }
    for (const secret of [...SECRETS, '4111111111111111']) {
      assert.ok(!shown.includes(secret), `browser hides ${secret}`);
    }

    // Press the "cap1" filter button. The router hands the handler the custom id
    // minus the action it is registered under, which here is the first segment.
    const cap1Button = buttons(browse.sent[0]).find((b) => b.label === 'cap1');
    const press = interaction({ admin: true });
    await providersButtonHandler(ctx)(press, cap1Button.custom_id.split(':').slice(1));
    const filtered = visible(press.sent[0]);
    assert.ok(filtered.includes('[cap1] •••• 1111'), 'filtered view lists the cap1 card');
    assert.ok(!filtered.includes('[amex]'), 'filtered view leaves out other providers');
  } finally {
    cleanup();
  }
});

test('/export gives the admin role an ephemeral file of full cards, and nobody else anything', async () => {
  const { ctx, logLines, cleanup } = await setup();
  try {
    const options = { type: 'cards', provider: 'amex' };

    const worker = interaction({ options });
    await exportHandler(ctx)(worker);
    assert.ok(!worker.sent[0].files, 'no file for a member without the admin role');
    assert.match(visible(worker.sent[0]), /Requires the \*\*owner\*\* role/);

    const admin = interaction({ admin: true, options });
    await exportHandler(ctx)(admin);
    const [reply] = admin.sent;
    assert.ok(reply.flags & 64, 'reply is ephemeral');
    assert.equal(
      reply.files[0].attachment.toString('utf8'),
      '378282246310005,09,2031,7351,90210\n371449635398431,10,2032,8462',
    );
    for (const secret of SECRETS) {
      assert.ok(!logLines.some((l) => l.includes(secret)), `no log line contains ${secret}`);
    }
  } finally {
    cleanup();
  }
});


for (const action of ['used', 'error', 'return']) {
  test(`${action} closes state before Discord update and a retry masks the closed claim`, async () => {
    const { ctx, cleanup } = await setup();
    try {
      await cardHandler(ctx)(interaction());
      const handler = cardActionHandler(ctx);
      const press = interaction({ messageId: 'claim-msg' });
      press.update = async () => { throw new Error('Discord unavailable'); };
      await assert.rejects(handler(press, [action]), /Discord unavailable/);
      assert.equal(getCardSession(ctx.db, 'claim-msg'), undefined);
      assert.equal(cardCount(ctx.db, 'amex'), action === 'return' ? 2 : 1);
      const retry = interaction({ messageId: 'claim-msg' });
      await handler(retry, [action]);
      assert.match(visible(retry.sent[0]), /claim is closed/);
      for (const value of [...SECRETS, '09/2031', '90210', '0005']) assert.ok(!visible(retry.sent[0]).includes(value));
      assert.deepEqual(buttons(retry.sent[0]), []);
    } finally {
      cleanup();
    }
  });
}

for (const [first, second] of [['return', 'return'], ['used', 'return'], ['error', 'return'], ['return', 'used'], ['return', 'error']]) {
  test(`concurrent ${first} and ${second} resolve once and mask both messages`, async () => {
    const { ctx, logLines, cleanup } = await setup();
    try {
      await cardHandler(ctx)(interaction());
      const handler = cardActionHandler(ctx);
      const winner = interaction({ messageId: 'claim-msg' });
      const closed = interaction({ messageId: 'claim-msg' });
      const releases = [];
      for (const press of [winner, closed]) {
        press.update = (payload) => {
          press.sent.push(payload);
          return new Promise((resolve) => releases.push(resolve));
        };
      }
      const pending = [handler(winner, [first]), handler(closed, [second])];
      assert.equal(releases.length, 2);
      assert.equal(getCardSession(ctx.db, 'claim-msg'), undefined);
      assert.equal(cardCount(ctx.db, 'amex'), first === 'return' ? 2 : 1);
      releases.forEach((resolve) => resolve());
      await Promise.all(pending);
      assert.match(visible(winner.sent[0]), first === 'return' ? /Returned/ : first === 'used' ? /Used/ : /Errored/);
      assert.match(visible(closed.sent[0]), /claim is closed/);
      assert.deepEqual(buttons(closed.sent[0]), []);
      for (const secret of SECRETS) {
        assert.ok(!visible(closed.sent[0]).includes(secret));
        assert.ok(!visible(winner.sent[0]).includes(secret));
        assert.ok(!logLines.some((line) => line.includes(secret)));
      }
      assert.equal(logLines.filter((line) => line.includes('card returned to pool')).length, first === 'return' ? 1 : 0);
    } finally {
      cleanup();
    }
  });
}

test('a failed Return transaction keeps the session and lets Used close it', async () => {
  const { ctx, cleanup } = await setup();
  try {
    await cardHandler(ctx)(interaction());
    ctx.db.runScript(`CREATE TRIGGER reject_return BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    const handler = cardActionHandler(ctx);
    const press = interaction({ messageId: 'claim-msg' });
    await handler(press, ['return']);
    assert.ok(press.sent[0].flags & 64);
    assert.match(visible(press.sent[0]), /Could not return/);
    assert.ok(getCardSession(ctx.db, 'claim-msg'));
    assert.equal(cardCount(ctx.db, 'amex'), 1);
    const used = interaction({ messageId: 'claim-msg' });
    await handler(used, ['used']);
    assert.match(visible(used.sent[0]), /Used/);
    assert.equal(getCardSession(ctx.db, 'claim-msg'), undefined);
  } finally {
    cleanup();
  }
});

for (const [action, presser] of ['used', 'error', 'return'].flatMap((action) => [[action, 'worker'], [action, 'other-worker']])) {
  test(`${action} by ${presser} during publication preserves the message until registration`, async () => {
    const { ctx, cleanup } = await setup();
    try {
      const claim = interaction();
      let finishFetch;
      let fetchStarted;
      const fetching = new Promise((resolve) => { fetchStarted = resolve; });
      claim.fetchReply = () => {
        fetchStarted();
        return new Promise((resolve) => { finishFetch = resolve; });
      };
      const pending = cardHandler(ctx)(claim);
      await fetching;
      const press = interaction({ messageId: 'claim-msg', originId: claim.id, userId: presser });
      let edits = 0;
      press.update = async () => { edits++; };
      await cardActionHandler(ctx)(press, [action]);
      assert.equal(edits, 0, 'initializing claim must retain its card and buttons');
      assert.match(visible(press.sent[0]), /still being set up/);
      assert.ok(press.sent[0].flags & 64);
      assert.equal(getCardSession(ctx.db, 'claim-msg'), undefined);
      finishFetch({ id: 'claim-msg' });
      await pending;
      assert.ok(getCardSession(ctx.db, 'claim-msg'));
      const retry = interaction({ messageId: 'claim-msg', originId: claim.id });
      await cardActionHandler(ctx)(retry, [action]);
      assert.equal(getCardSession(ctx.db, 'claim-msg'), undefined);
      assert.equal(cardCount(ctx.db, 'amex'), action === 'return' ? 2 : 1);
      assert.match(visible(retry.sent[0]), action === 'return' ? /Returned/ : action === 'used' ? /Used/ : /Errored/);
      for (const secret of SECRETS) assert.ok(!visible(retry.sent[0]).includes(secret));
    } finally {
      cleanup();
    }
  });
}

test('concurrent publications for one worker stay pending until both finish', async () => {
  const { ctx, cleanup } = await setup();
  try {
    const releases = [];
    let bothStarted;
    const started = new Promise((resolve) => { bothStarted = resolve; });
    const claims = [interaction(), interaction()];
    for (const claim of claims) {
      claim.fetchReply = () => new Promise((resolve) => {
        releases.push(resolve);
        if (releases.length === 2) bothStarted();
      });
    }
    const pending = claims.map((claim) => cardHandler(ctx)(claim));
    await started;
    releases[0]({ id: 'first' });
    await pending[0];
    const press = interaction({ messageId: 'second', originId: claims[1].id });
    await cardActionHandler(ctx)(press, ['return']);
    assert.match(visible(press.sent[0]), /still being set up/);
    for (const originId of [undefined, 'finished-interaction']) {
      const expired = interaction({ messageId: 'expired', originId });
      await cardActionHandler(ctx)(expired, ['return']);
      assert.match(visible(expired.sent[0]), /claim is closed/);
      assert.deepEqual(buttons(expired.sent[0]), []);
      for (const secret of SECRETS) assert.ok(!visible(expired.sent[0]).includes(secret));
    }
    releases[1]({ id: 'second' });
    await pending[1];
    const handler = cardActionHandler(ctx);
    await handler(interaction({ messageId: 'first' }), ['return']);
    await handler(interaction({ messageId: 'second' }), ['return']);
    assert.equal(cardCount(ctx.db, 'amex'), 2);
    const closed = interaction({ messageId: 'second', originId: claims[1].id });
    await handler(closed, ['return']);
    assert.match(visible(closed.sent[0]), /claim is closed/);
  } finally {
    cleanup();
  }
});
