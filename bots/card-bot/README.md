# card-bot

Hands employees cards from the business's own bank accounts, one at a time, with a record of who claimed each card.
An employee runs `/card` in a whitelisted Discord channel and gets one card.
That card leaves the pool, so nobody else can be handed it.

## How it works

1. An admin creates a provider with `/providers`. A provider is a named pool of cards, for example one per bank account, with an optional default zip and expiry.
2. An admin uploads a file with `/load`. Each line is `number,mm,yy,cvv[,zip]`, separated by commas or slashes. Lines whose first field is not all digits, such as a header row, are skipped. card-bot seals each card before it writes it.
3. An employee runs `/card`. card-bot opens the next card, deletes it from the pool in the same transaction, and replies with the number, CVV, expiry and zip.
4. The employee presses a button on that message:
   - **Used** closes the claim.
   - **Error** closes the claim and logs a warning. The card stays out of the pool.
   - **Return** puts the card back at the front of its provider's pool.

   After any of the three, the message is edited to show the last four digits only.
5. When a claim leaves a provider with 10 cards or fewer, card-bot posts a low-stock alert, once per count.

## Commands

| Command | Who can run it | What it does |
|---|---|---|
| `/card` | anyone in a whitelisted channel | Claims one card |
| `/load` | admin role | Uploads cards into a provider, appending or replacing |
| `/export` | admin role | Returns a provider's cards in stock as a file |
| `/providers` | admin role | Creates, edits, erases and deletes providers, sets the selection mode, and browses stock and cards |
| `/whitelist` | admin role | Turns `/card` on or off for the current channel |
| `/stats` | admin role | Cards claimed per member today and this week, with their cost at the `/setprice` price |
| `/setprice` | admin role | Sets the per-card price used by `/stats` |
| `/purge` | admin role | Deletes all bot data after a confirmation button |

The admin role is the Discord role named by `ADMIN_ROLE_NAME`, which the template sets to `owner`.
An empty value matches no role, so nobody could run admin commands.

### What /export returns

`/export type:cards provider:<id>` replies with `cards-<id>.txt`.
The file has one line per card still in stock, in the order `/card` would hand them out, as `number,mm,yy,cvv[,zip]`.
Cards out on a claim are not included.
That is the format `/load` reads, so export, edit, then `/load mode:replace` is how to bulk-edit a provider.

Only members with the admin role can run it.
The reply is ephemeral, so only the admin who ran it sees the file.
card-bot opens the cards in memory to build the file and never writes it to disk.
Once downloaded, the file is a plaintext copy of the cards on that admin's device.

## Card storage

`src/card-vault.js` owns sealing and opening.
A card in the database is a sealed card:

| Column | Holds |
|---|---|
| `ciphertext`, `nonce`, `tag` | The card's number, expiry, CVV and zip, encrypted with AES-256-GCM and a fresh 12-byte nonce |
| `key_id` | Which key sealed it. A different key refuses to open it. |
| `fingerprint` | HMAC-SHA256 of the card number. `UNIQUE(provider_id, fingerprint)` rejects a card already in that provider, which a random nonce would otherwise make impossible to detect. The fingerprint is also bound into the ciphertext as authenticated data. |
| `last4` | The last four digits, for display |

Open claims in `card_sessions` keep the same sealed columns, so **Return** moves a card back into stock without opening it.

The key comes from `CARD_ENCRYPTION_KEY`, 32 random bytes in base64.
card-bot refuses to start without a valid key, or with a key other than the one that sealed the cards already stored.
The root [Security section](../../README.md#security) covers backing up the key.

Migration `016_seal_cards.js` upgrades a database from before encryption.
It rebuilds `cards` and `card_sessions` with sealed columns, drops the plaintext tables, and skips a table that is already sealed.
`openInventory` turns on `secure_delete` before migrating and truncates the WAL afterwards, so no plaintext stays in the file.

## Design decisions

- **Consume on claim.** `claimCard` opens the card and deletes it inside one transaction. A restart or a double click cannot hand the same card to two people, and a card that fails to open stays in stock.
- **Three selection modes, stored in SQLite.** `all` takes from the first provider with stock, in creation order. `single` takes from the pinned provider first and falls through to the others when it is empty. `mix` rotates through a chosen set of providers and remembers its place across restarts.
- **Duplicate loads are skipped.** `INSERT OR IGNORE` against `UNIQUE(provider_id, fingerprint)` skips cards the provider already has, and `/load` reports how many it skipped.
- **Buttons survive restarts.** Card buttons use ids like `cardbot:cardact:used`, and the open claim is a SQLite row keyed by the Discord message id.
- **Stale claims are trimmed, not returned.** Every 6 hours card-bot deletes claim rows older than 48 hours, and the Monday stats reset deletes those older than 24 hours. Most of those cards were used without a button press, so they do not go back into stock.
- **Gated by channel, role and lockdown.** `/card` works only in whitelisted channels, and not while payment-bot's dashboard has the fleet locked.

## Code layout

```
src/
├── card-vault.js   seal and open cards, fingerprints
├── inventory.js    all SQLite access: providers, sealed cards, claims, whitelist, stats
├── embeds.js       Discord message builders: claim, resolved claim, stock, stats
├── commands.js     slash commands and button and modal handlers
├── env-schema.js   zod schema for .env
└── index.js        boot: env, key, database and migrations, Discord, claim reaper
migrations/         schema, applied at startup
```

## Setup

```bash
cp .env.example .env
```

Fill in the Discord token, client id, guild id, the admin role name, and `CARD_ENCRYPTION_KEY`.
`.env.example` shows the command that generates the key.
Start the bot with the root `install.sh` or `start.bat`.
Then, in Discord, run `/whitelist` in the channel where `/card` should work, create a provider with `/providers`, and fill it with `/load`.
