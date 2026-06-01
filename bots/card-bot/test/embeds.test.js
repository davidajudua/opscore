import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lowStockPayload,
  cardEmbed,
  workersStatsPageContainer,
} from '../src/embeds.js';

// Pull the flat list of TextDisplay (type 10) content strings out of a
// Components V2 payload or a bare ContainerBuilder.
function texts(payloadOrContainer) {
  // A v2Payload is a plain object with a `flags` field wrapping the container;
  // a ContainerBuilder also exposes a `components` array, so key off `flags`.
  const container =
    'flags' in payloadOrContainer
      ? payloadOrContainer.components[0]
      : payloadOrContainer;
  return container
    .toJSON()
    .components.filter((c) => c.type === 10)
    .map((c) => c.content);
}

const fakeBot = { customId: (...a) => a.join(':') };

test('lowStockPayload renders provider.name, not [object Object]', () => {
  const provider = { name: 'Visa', exp_date: '01/30', zip: '00000' };
  const [content] = texts(lowStockPayload({ provider, count: 3, threshold: 5 }));
  assert.ok(
    content.includes('`Visa`'),
    `expected provider name in alert, got: ${content}`,
  );
  assert.ok(
    !content.includes('[object Object]'),
    `provider object leaked into alert: ${content}`,
  );
});

test('cardEmbed expands single-digit year to a full 20xx year', () => {
  const card = { card_number: '4111', cvv: '123', mm: '08', yy: 5, zip: '90210' };
  const provider = { name: 'Visa', exp_date: '01/30', zip: '00000' };
  const expLine = texts(cardEmbed({ card, provider, bot: fakeBot })).find((t) =>
    t.startsWith('**Exp Date**'),
  );
  assert.ok(
    expLine.includes('08/2005'),
    `single-digit year not expanded, got: ${expLine}`,
  );
});

test('cardEmbed handles two-digit year unchanged', () => {
  const card = { card_number: '4111', cvv: '123', mm: '12', yy: 26, zip: '90210' };
  const provider = { name: 'Visa', exp_date: '01/30', zip: '00000' };
  const expLine = texts(cardEmbed({ card, provider, bot: fakeBot })).find((t) =>
    t.startsWith('**Exp Date**'),
  );
  assert.ok(
    expLine.includes('12/2026'),
    `two-digit year mishandled, got: ${expLine}`,
  );
});

test('cardEmbed handles string two-digit year unchanged', () => {
  const card = { card_number: '4111', cvv: '123', mm: '04', yy: '27', zip: '90210' };
  const provider = { name: 'Visa', exp_date: '01/30', zip: '00000' };
  const expLine = texts(cardEmbed({ card, provider, bot: fakeBot })).find((t) =>
    t.startsWith('**Exp Date**'),
  );
  assert.ok(
    expLine.includes('04/2027'),
    `string two-digit year mishandled, got: ${expLine}`,
  );
});

test('cardEmbed leaves full four-digit year untouched', () => {
  const card = { card_number: '4111', cvv: '123', mm: '06', yy: 2031, zip: '90210' };
  const provider = { name: 'Visa', exp_date: '01/30', zip: '00000' };
  const expLine = texts(cardEmbed({ card, provider, bot: fakeBot })).find((t) =>
    t.startsWith('**Exp Date**'),
  );
  assert.ok(
    expLine.includes('06/2031'),
    `four-digit year mishandled, got: ${expLine}`,
  );
});

test('workersStatsPageContainer per-worker cost matches costOf (cards * price)', () => {
  const sorted = [{ userId: '1', cards: 3 }];
  const prices = { card: 250 }; // $2.50 each -> $7.50
  const container = workersStatsPageContainer({
    bot: fakeBot,
    tab: 'today',
    sorted,
    pageIdx: 0,
    prices,
  });
  const block = texts(container).find((t) => t.includes('cards'));
  assert.ok(
    block.includes('$7.50'),
    `per-worker cost wrong, got: ${block}`,
  );
});
