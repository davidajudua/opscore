# code-bot

**Hand out one-time verification codes to a team, on demand, without sharing an inbox.** When several
people need login/2FA codes for shared business accounts, code-bot fetches the latest code from a
dedicated mailbox and serves it to whoever asked — one request at a time, with no duplicates.

---

## The problem it solves

Shared accounts send their one-time verification codes to a single inbox. If a whole team needs those
codes, you either share the mailbox password (bad) or someone becomes a human relay (slow). code-bot
sits on that inbox and turns "what's the code?" into a Discord button: a team member requests a code,
the bot pulls the freshest matching one, hands it to them, and marks it used so the next person gets a
different one.

**Who it's for:** an admin who configures which inbox/provider to watch, and team members who just
need the current code for a shared account without touching the mailbox.

## How it works

1. An admin **deploys** the bot to a channel for a given provider (`/deploy`).
2. A team member requests a code; they join a **fair queue** so only one person is served at a time.
3. The bot fetches the latest matching code — from **IMAP** (a dedicated inbox) or, optionally, a
   **Discord-webhook fallback** (e.g. an SMS-forwarder posting codes into a channel).
4. The code is delivered to the requester; it's recorded as **served** so it's never handed out twice.

## Engineering & design decisions

- **Fair, single-active queue.** Built on the platform core's worker queue: one person is served at a
  time, with an idle timeout so a no-show doesn't block everyone behind them.
- **Served-code de-duplication.** Every code handed out is recorded; the fetchers skip already-served
  codes so two requesters never get the same one.
- **Two fetch sources, same interface.** Primary IMAP fetcher with an optional webhook fallback —
  configure either or both; with both set, the bot uses IMAP and falls back automatically.
- **Per-provider deploys.** Different providers (and their distinct email/code formats) get their own
  channel deployment and parsing rules, so one bot instance can serve several account types.
- **Restart-safe.** Persistent component IDs and DB-backed sessions mean an in-flight request survives
  a redeploy.
- **Secrets stay in `.env`.** Inbox credentials are never committed; the session DB is gitignored.

## Architecture

```
src/
├── imap-fetcher.js     # pull codes from a dedicated inbox (sender/subject/code regex)
├── webhook-fetcher.js  # optional fallback: read codes from a Discord channel webhook
├── session.js          # per-request session state (DB-backed)
├── deploy.js           # per-provider channel deployment
├── handlers/           # request / get-code / release / cancel-retry-done / deploy
└── index.js            # boot: env → db+migrations → Discord → fetchers
```

Built on `@platform/bot-core` (config, db+migrations, Discord router, **worker queue**, logging).

## Setup

```bash
cp .env.example .env     # Discord token + channel, IMAP inbox creds, optional webhook fallback IDs
```

Key settings (see `.env.example`): `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `PROTON_IMAP_USER` /
`PROTON_IMAP_PASS` (+ host/port/folder) for the inbox, and optional `WEBHOOK_CODE_CHANNEL_ID` /
`WEBHOOK_CODE_AUTHOR_ID` to enable the webhook fallback. Start via the platform's PM2 config or
`start.bat`, then `/deploy` in the channel where the team should request codes.
