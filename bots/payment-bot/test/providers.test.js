import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS } from '../src/providers.js';

const paypal = PROVIDERS.paypal;

test('PayPal: a genuine inbound payment is parsed', () => {
  const r = paypal.parse({ subject: "You've received $18.00 USD from Jamie Rivera", text: '' });
  assert.deepEqual(r, { amount: 18, name: 'Jamie Rivera' });
});

test('PayPal: a reversed payment is NOT treated as inbound income', () => {
  const r = paypal.parse({
    subject: "You've received $50.00 USD from John Doe",
    text: 'This payment was later reversed and funds were returned.',
  });
  assert.equal(r, null, 'reversed notifications must be skipped, not recorded as income');
});

test('PayPal: an unauthorized-transaction notice is NOT treated as inbound income', () => {
  const r = paypal.parse({
    subject: 'Jane Smith sent you $40.00',
    text: 'We are reviewing an unauthorized transaction on your account.',
  });
  assert.equal(r, null, 'unauthorized notices must be skipped, not recorded as income');
});
