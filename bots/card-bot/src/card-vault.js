/**
 * The only module that sees a card's number, expiry, CVV and zip together.
 *
 * A card exists in two forms:
 *   PlainCard   lives only in memory: while a /load file is parsed, while a claimed
 *               card is shown to the worker who claimed it, and while /export builds
 *               its file.
 *   SealedCard  is what SQLite stores: the plain card encrypted with AES-256-GCM,
 *               plus columns that let the bot work without opening it.
 *
 * Both subkeys and the key id derive from CARD_ENCRYPTION_KEY with HKDF, so one
 * secret is all an operator has to back up.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * @typedef {object} PlainCard
 * @property {string} card_number
 * @property {string} mm
 * @property {string} yy
 * @property {string} cvv
 * @property {string|null} [zip]
 */

/**
 * Column names match the `cards` and `card_sessions` tables, so a row read from
 * either table is already a SealedCard.
 *
 * @typedef {object} SealedCard
 * @property {string} key_id          Which key sealed it. Opening with another key fails.
 * @property {Uint8Array} nonce       12 random bytes, fresh for every seal.
 * @property {Uint8Array} tag         16-byte GCM auth tag.
 * @property {Uint8Array} ciphertext
 * @property {string} fingerprint     HMAC-SHA256 of the card number. Lets SQLite enforce
 *                                    uniqueness without the number itself.
 * @property {string} last4           The only part of the number that is ever displayed.
 */

export const SEALED_COLUMNS = ['key_id', 'nonce', 'tag', 'ciphertext', 'fingerprint', 'last4'];

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

function derive(masterKey, purpose, length) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `card-bot/v1/${purpose}`, length));
}

/** @param {Buffer} masterKey  32 bytes, already validated by the env schema. */
export function createCardVault(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) {
    throw new Error(`card vault needs a ${KEY_BYTES}-byte key`);
  }
  const encryptionKey = derive(masterKey, 'encrypt', KEY_BYTES);
  const fingerprintKey = derive(masterKey, 'fingerprint', KEY_BYTES);
  const keyId = derive(masterKey, 'key-id', 4).toString('hex');

  const fingerprint = (cardNumber) =>
    createHmac('sha256', fingerprintKey).update(cardNumber).digest('hex');

  return {
    keyId,
    fingerprint,

    /** @param {PlainCard} card @returns {SealedCard} */
    seal(card) {
      const plain = { card_number: card.card_number, mm: card.mm, yy: card.yy, cvv: card.cvv, zip: card.zip ?? null };
      const fp = fingerprint(plain.card_number);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
      // The fingerprint is authenticated data, so a ciphertext cannot be moved under
      // another card's fingerprint without failing to open.
      cipher.setAAD(Buffer.from(fp));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
      return {
        key_id: keyId,
        nonce,
        tag: cipher.getAuthTag(),
        ciphertext,
        fingerprint: fp,
        last4: plain.card_number.slice(-4),
      };
    },

    /** @param {SealedCard} sealed @returns {PlainCard} */
    open(sealed) {
      if (sealed.key_id !== keyId) {
        throw new Error(
          `card was sealed with key id ${sealed.key_id}, but CARD_ENCRYPTION_KEY has key id ${keyId}`,
        );
      }
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, sealed.nonce);
      decipher.setAAD(Buffer.from(sealed.fingerprint));
      decipher.setAuthTag(sealed.tag);
      const json = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
      return JSON.parse(json);
    },
  };
}
