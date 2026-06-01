import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSolNativeTransfer,
  btcConfirmations,
  evmConfirmations,
  buildAddressIndex,
  isOurAddress,
} from '../src/blockchain.js';

test('buildAddressIndex includes TRX so TRON recipient/ownership checks work', () => {
  const { addressSet, coinAddresses } = buildAddressIndex({ CRYPTO_ADDRESS_TRX: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' });
  assert.deepEqual(coinAddresses.TRX, ['TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'], 'TRX address must be indexed for fetchTRON filtering');
  assert.equal(isOurAddress(addressSet, 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'), true, 'our TRX address is recognized as ours');
  assert.equal(isOurAddress(addressSet, 'TSomeOtherThirdPartyAddressXXXXXXXX'), false, 'a third-party TRX address is NOT ours');
});

// --- SOL native transfer: must never report a negative (outbound) amount as income ---

test('extractSolNativeTransfer: inbound to our address yields a positive amount', () => {
  const tx = {
    transaction: { message: { accountKeys: ['MYADDR', 'SENDER'] } },
    meta: { preBalances: [0, 5_000_000_000], postBalances: [1_000_000_000, 4_000_000_000] },
  };
  const r = extractSolNativeTransfer(tx, ['MYADDR']);
  assert.equal(r.amountNative, 1);
  assert.equal(r.toAddress, 'MYADDR');
});

test('extractSolNativeTransfer: when OUR address is the sender, do not return a negative amount', () => {
  const tx = {
    transaction: { message: { accountKeys: ['MYADDR', 'RECIPIENT'] } },
    // our balance goes DOWN (we sent); recipient goes up by 1 SOL
    meta: { preBalances: [5_000_000_000, 0], postBalances: [3_999_000_000, 1_000_000_000] },
  };
  const r = extractSolNativeTransfer(tx, ['MYADDR']);
  assert.ok(r.amountNative === null || r.amountNative > 0, `amount must not be negative, got ${r.amountNative}`);
  // it should fall through to the largest positive delta (the actual recipient)
  assert.equal(r.toAddress, 'RECIPIENT');
  assert.equal(r.amountNative, 1);
});

// --- BTC confirmations: derived from chain tip, not the block height ---

test('btcConfirmations: tip - blockHeight + 1, guarded', () => {
  assert.equal(btcConfirmations(850010, 850000, true), 11);
  assert.equal(btcConfirmations(850000, 850000, true), 1);
  assert.equal(btcConfirmations(null, 850000, true), 0, 'no tip → 0, never the block height');
  assert.equal(btcConfirmations(850010, null, false), 0, 'unconfirmed → 0');
});

// --- EVM confirmations: pending tx (null blockNumber) must yield 0, never NaN ---

test('evmConfirmations: pending tx yields 0, not NaN', () => {
  assert.equal(evmConfirmations(900100, null), 0);
  assert.equal(Number.isNaN(evmConfirmations(900100, null)), false);
});

test('evmConfirmations: mined tx computes blocks since inclusion', () => {
  // 0xdbba0 === 900000; tx mined 100 blocks ago → 101 confirmations
  assert.equal(evmConfirmations(900100, '0xdbba0'), 101);
});
