# payment-bot

**Know your revenue without adding it up by hand.** A Discord bot that watches money coming in
across every rail you use, reconciles it into one ledger, and posts running daily / weekly / monthly
totals to a team channel.

---

## The problem it solves

A business taking payments through several channels — bank transfers (Zelle), Venmo, PayPal, and
on-chain crypto — has its revenue scattered across inboxes and block explorers. Answering "how much
did we make today?" means manually tallying notification emails and checking wallets. payment-bot
makes that number **always-on and self-updating**: every inbound payment is detected, parsed,
deduplicated, and rolled into a live dashboard.

**Who it's for:** an operator/admin who wants a real-time revenue picture, and a team that can see
the day's running total in their own channel without anyone exporting a spreadsheet.

## How it works

1. **Email rails (Zelle / Venmo / PayPal).** The bot holds an authenticated IMAP connection to a
   dedicated inbox and watches for payment-confirmation emails from the providers' real sender
   domains. Each provider has a parser that extracts `{ amount, name }`.
2. **Crypto rail.** A transaction hash (or explorer link) is resolved against the relevant chain,
   priced in USD, and matched to your configured receiving addresses.
3. **Ledger.** Every detected payment is written once to a local SQLite ledger (idempotent — the same
   email or tx can't double-count).
4. **Dashboard.** A pinned `/dashboard` embed shows totals by method and by period and live-updates
   as money lands.

## Engineering & design decisions

- **Permissive, multi-pattern parsers.** Payment-confirmation email formats vary by bank and change
  over time (Zelle especially), so each parser tries several patterns and returns `null` for anything
  that isn't a genuine *inbound* payment — outbound notices, refunds, and disputes are filtered out so
  they never pollute the ledger.
- **Null-amount handling.** Some providers now omit the amount from the notification entirely; the
  parser still captures the sender and flags amount-unknown rather than guessing, so the ledger stays
  honest.
- **IMAP IDLE + safety re-poll.** The monitor uses push (IDLE) for instant detection but also sweeps
  on an interval as a backstop in case a push is ever dropped — no missed payments, no busy-polling.
- **Reconnect with backoff.** The mail connection self-heals on drop with capped exponential backoff.
- **Config-driven rails.** Any rail with no credentials configured simply disables itself; the bot
  warns at startup instead of crashing.
- **No sensitive data in the repo.** Receiving addresses and inbox credentials live only in `.env`;
  the ledger DB is gitignored.

## Architecture

```
src/
├── monitor.js      # IMAP IDLE connection per provider + safety re-poll + reconnect
├── providers.js    # per-provider sender filters + email parsers (Zelle/Venmo/PayPal)
├── blockchain.js   # multi-chain tx lookup + USD pricing (BTC/ETH/LTC/SOL/… + ERC-20 tokens)
├── ledger.js       # idempotent SQLite ledger
├── embeds.js       # /dashboard rendering (totals by method + period)
├── commands.js     # /dashboard, /cashout, /refund, /crypto, /minus, /purge (admin-gated)
└── index.js        # boot: env → db+migrations → Discord → monitors
```

Built on `@platform/bot-core` (config, db+migrations, Discord router, http, logging).

## Setup

```bash
cp .env.example .env     # add Discord token + channel, IMAP creds per rail, receiving addresses
```

Key settings (see `.env.example` for the full list): `DISCORD_TOKEN`, `DISCORD_PAYMENT_CHANNEL_ID`,
`GMAIL_ADDRESS_*` / `GMAIL_APP_PASSWORD_*` per rail (any can be blank to disable it),
`CRYPTO_ADDRESS_*` per chain, `ADMIN_ROLE_NAME`. Start it via the platform's PM2 config or `start.bat`.
Run `/dashboard` in the target channel to deploy the live revenue panel.
