import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeoutView, buildAutoTimeoutView } from '../src/session.js';

const bot = { customId: (...a) => a.join(':') };

function viewText(view) {
  const json = view.components[0].toJSON();
  // The first text-display component (type 10) holds the body copy.
  const td = json.components.find((c) => c.type === 10);
  return td?.content ?? '';
}

test('buildTimeoutView states Eno\'s real 3-minute wait, not 60 seconds', () => {
  const text = viewText(buildTimeoutView(bot, { mention: '1', provider: 'eno' }));
  assert.match(text, /Capital One/);
  assert.match(text, /3 minutes/);
  assert.doesNotMatch(text, /60 seconds/);
});

test('buildTimeoutView keeps 60 seconds for amex', () => {
  const text = viewText(buildTimeoutView(bot, { mention: '1', provider: 'amex' }));
  assert.match(text, /Safekey/);
  assert.match(text, /60 seconds/);
});

test('buildTimeoutView matches buildAutoTimeoutView window per provider', () => {
  for (const provider of ['amex', 'eno']) {
    const manual = viewText(buildTimeoutView(bot, { mention: '1', provider }));
    const auto = viewText(buildAutoTimeoutView({ userId: '1', provider }));
    const win = provider === 'eno' ? '3 minutes' : '60 seconds';
    assert.match(manual, new RegExp(win));
    assert.match(auto, new RegExp(win));
  }
});
