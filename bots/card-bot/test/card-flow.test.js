import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCardVault } from '../src/card-vault.js';
import { addProvider, loadCards, openInventory, setWhitelist } from '../src/inventory.js';
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

function interaction({ admin = false, userId = 'worker', messageId, options = {} } = {}) {
  const sent = [];
  return {
    sent,
    channelId: 'chan',
    user: { id: userId },
    member: { roles: { cache: new Map(admin ? [['r', { name: 'owner' }]] : []) } },
    message: messageId ? { id: messageId } : undefined,
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

test('the cards browser lists last four digits only', async () => {
  const { ctx, cleanup } = await setup();
  try {
    const browse = interaction({ admin: true });
    await providersButtonHandler(ctx)(browse, ['opencards']);
    const shown = visible(browse.sent[0]);
    assert.ok(shown.includes('[amex] •••• 0005') && shown.includes('[amex] •••• 8431'));
    for (const secret of SECRETS) assert.ok(!shown.includes(secret), `browser hides ${secret}`);
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
