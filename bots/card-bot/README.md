# card-bot

**Hand out single-use cards to a team — one at a time, with tracking — instead of a shared spreadsheet.**

A Discord bot that holds a pool of single-use cards and hands them out on demand via `/card`. The
canonical use case is a company issuing **employee expense cards** for purchases, but it works for any
resource handed out one at a time with an audit trail.

---

## The problem it solves

Distributing cards by hand is slow and leaky: numbers get copied into DMs and spreadsheets, the same
card gets handed to two people, no one can say which card went where, and there's no record when
something goes wrong. card-bot replaces that with a single self-serve flow where **every claim is
tracked and a card is never handed out twice.**

## Who it's for

Admins who need to distribute cards to a team without manual tracking, and team members who just need
one card, on demand, without pinging anyone.

## How it works

1. An admin loads cards into a **provider** (`/load`, CSV/text upload) — providers group cards by
   issuer and carry a default zip / expiry.
2. A team member runs `/card` and is handed exactly one card; it's **removed from the pool** so it
   can't be reissued.
3. They resolve it with a button:
   - **Used** — done, the card stays consumed
   - **Return** — puts it back at the head of the pool (re-arms low-stock alerts)
   - **Error** — flags it; the claim is closed
4. A live **stock panel** and low-stock alerts keep admins aware of inventory.

## Engineering & design decisions

- **Consume-on-claim.** A claimed card is deleted from the pool inside a transaction, so a restart or
  a double-click can never hand the same card to two people.
- **Three selection modes, persisted.** `all` (round-robin every provider), `single` (pin one
  provider, fall through if empty), and `mix` (round-robin a chosen subset). The mode + a round-robin
  pointer live in a settings table so rotation survives restarts.
- **Idempotent loads.** `INSERT OR IGNORE` against a `UNIQUE(provider_id, card_number)` index means
  re-uploading a file silently dedups instead of creating duplicates.
- **Restart-safe interactions.** Buttons use stable, namespaced custom IDs (`cardbot:cardact:…`) so
  an in-flight card's buttons keep working across a redeploy.
- **Low-stock alerts, de-duped.** A per-count alert key fires once as stock crosses each threshold and
  re-arms on load/return — no alert spam.
- **Session reaper.** Users often claim a card and forget to click a button; a periodic reaper trims
  abandoned session rows (cards are *not* auto-returned, since most were used).
- **Channel whitelisting + admin gating.** `/card` only works in whitelisted channels; pool/admin
  commands require the configured admin role.
- **No card data at rest beyond the pool.** Claimed-card details live only in the short-lived session
  row; nothing sensitive is logged.

## Commands

| Command | Who | Description |
|---|---|---|
| `/card` | team | Claim one card |
| `/load` | admin | Upload cards to a provider (append/replace) |
| `/export` | admin | Download a provider's cards |
| `/providers` | admin | Manage providers + selection mode (panel) |
| `/whitelist` | admin | Whitelist the current channel for `/card` |
| `/stats` | admin | Per-member claim counts (today / week) |
| `/setprice` | admin | Set the per-card value used in stats |
| `/purge` | admin | Wipe all bot data (guarded) |

## Architecture

```
src/
├── inventory.js   # all persistence: pool, providers, sessions, whitelist, stock pointer, stats
├── embeds.js      # /card, stock panel, and stats Components-V2 builders
├── commands.js    # slash-command builders + interaction handlers
└── index.js       # boot: env → db+migrations → Discord → command wiring + session reaper
migrations/        # schema, applied automatically on first start
```

Built on `@platform/bot-core` (config, db+migrations, Discord router, logging).

## Setup

```bash
cp .env.example .env     # Discord token + client/guild id + admin role
```

Start via the platform's PM2 config or `start.bat`. Then, in Discord: `/whitelist` the channel where
`/card` should work, `/providers` to create a provider, `/load` to fill it, and the team can `/card`.
The card export format (`number,mm,yy,cvv[,zip]`) round-trips with `/load`.
