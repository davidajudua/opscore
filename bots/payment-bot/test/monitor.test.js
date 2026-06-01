import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senderMatches } from '../src/monitor.js';

test('sender match is exact (case-insensitive)', () => {
  assert.equal(
    senderMatches('CustomerService@ealerts.bankofamerica.com', [
      'customerservice@ealerts.bankofamerica.com',
    ]),
    true,
  );
});

test('a spoofed suffix domain is rejected (no substring match)', () => {
  // attacker registers paystack.com.attacker.com to slip past a substring filter
  assert.equal(senderMatches('noreply@paystack.com.attacker.com', ['noreply@paystack.com']), false);
});

test('a spoofed prefix is rejected', () => {
  assert.equal(senderMatches('evilvenmo@venmo.com.evil.com', ['venmo@venmo.com']), false);
});

test('non-matching and empty senders are rejected', () => {
  assert.equal(senderMatches('random@example.com', ['venmo@venmo.com']), false);
  assert.equal(senderMatches('', ['venmo@venmo.com']), false);
  assert.equal(senderMatches('venmo@venmo.com', []), false);
});
