# payment-bot

Confirms customer payments from the payment providers' own alert emails, keeps a ledger, and shows revenue in Discord.
A customer claiming they paid is not enough.
The payment shows up when the Zelle, Venmo or PayPal alert reaches the business's inbox.
Each alert email is booked once, keyed by its IMAP UID.

## How it works

1. **Email rails.** For each of Zelle, Venmo and PayPal that has credentials, `monitor.js` keeps one IMAP connection to that rail's Gmail inbox, using an app password. The rails can share one Gmail account. Gmail pushes new mail over IMAP IDLE. A sweep also runs on connect and every 5 minutes, in case a push is missed.
2. **Parsing.** Only mail whose From address exactly matches one of the rail's known senders is parsed, for example `venmo@venmo.com`. Each rail's `parse()` in `providers.js` returns the payer's name and amount, or `null` for anything that is not an inbound payment.
3. **Ledger.** `recordPayment` inserts the payment with the IMAP UID as `external_id`. A partial unique index on `(method, external_id)` rejects a second insert of the same email, so each alert email is booked and posted once, keyed by its IMAP UID.
4. **Discord.** Each new payment is posted to `DISCORD_PAYMENT_CHANNEL_ID`, and every saved `/dashboard` message is edited to show the new totals.
5. **Crypto.** `/crypto` takes a transaction hash or a block explorer link, looks it up on its chain, and prices it in USD at the time it was sent. It is booked only if it paid one of the `CRYPTO_ADDRESS_*` addresses, with the transaction hash as `external_id`.

The root [README](../../README.md#how-a-payment-gets-confirmed) has a diagram of this flow.

## Commands

| Command | Who can run it | What it does |
|---|---|---|
| `/dashboard` | admin role | Posts the revenue panel in the current channel and keeps it updated |
| `/cashout` | admin role | Records money taken out. It lowers the balance. |
| `/minus` | admin role | Records a deduction against one rail, such as a chargeback |
| `/purge` | admin role | Deletes all bot data after a confirmation button |
| `/crypto` | any member | Submits a crypto transaction to check and book |
| `/refund` | any member | Posts a refund request to `REFUND_CHANNEL_ID` with **Approve** and **Deny** buttons. Approving records a deduction. |

The `/dashboard` panel has two views: totals for today, this week, this month and all time, and revenue for each of the last 8 days.
Anyone can switch views.
Its **Restart**, **Lock** and **Unlock** buttons are admin only.
**Restart** runs `pm2 restart all`.
**Lock** writes the fleet lockdown file, which stops card-bot's `/card` until **Unlock**.

The refund buttons do not check roles, so make the refund channel visible to admins only.

## Design decisions

- **Parsers that try several patterns.** Bank alert formats differ and change, Zelle's most of all, so each parser tries several phrasings. Each returns `null` for mail that does not read as an inbound payment. Venmo skips outbound notices, and PayPal skips refunds, disputes, failures and reversals, so those never reach the ledger.
- **Alerts without an amount are skipped.** Some banks now leave the amount out of the alert, for example US Bank's Zelle notice. The parser returns the name with a `null` amount, and the bot logs it and books nothing rather than guess.
- **Exact sender match.** A substring match would accept a spoofed address such as `venmo@venmo.com.example.org`. The bot does not verify DKIM or SPF itself, and relies on Gmail to reject forged senders.
- **Push with a backstop.** IMAP IDLE delivers new mail without polling, and the 5-minute sweep covers a dropped push.
- **Reconnect with backoff.** A dropped connection retries after 2, 5, 10, 30, 60, then every 120 seconds.
- **Resume where it stopped.** `imap_cursor` stores the highest UID handled per rail, so a restart processes only newer mail. On its first start a rail skips the mail already in the inbox.
- **Rails switch on with config.** A rail without credentials is skipped. With none configured, the bot logs a warning and runs with `/crypto` and the manual commands only.
- **Time in New York.** Day, week and month totals start at midnight in `America/New_York`, wherever the server runs.

## Code layout

```
src/
├── monitor.js      one IMAP IDLE connection per rail, sweep, reconnect, cursor
├── providers.js    per-rail sender addresses and email parsers
├── blockchain.js   transaction lookup and USD pricing for BTC, ETH, LTC, SOL, TRX, BSC, Base, Arbitrum, Polygon
├── ledger.js       ledger writes and totals
├── embeds.js       payment posts and the dashboard
├── commands.js     slash commands and button and modal handlers
├── pm2.js          the dashboard's Restart button
├── env-schema.js   zod schema for .env
└── index.js        boot: env, database and migrations, Discord, monitors
```

## Setup

```bash
cp .env.example .env
```

Fill in the Discord token, client id, guild id, the payment channel, the admin role name, a Gmail address and app password for each rail you use, and the crypto addresses you accept.
Leave a rail's address or password empty to turn that rail off.
Start the bot with the root `install.sh` or `start.bat`, then run `/dashboard` in the channel that should show revenue.
