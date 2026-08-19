# opscore

Edits belong in `career/opscore` of the private [davidajudua/workspace](https://github.com/davidajudua/workspace) repo.
This GitHub repo is a public mirror.
Do not commit here.

**One shared Node runtime that runs a fleet of single-purpose internal-ops bots on Discord, all supervised under PM2.**

Most "Discord bots" are one giant file that does everything and falls over on restart. This one goes
the other way. A thin shared core (`@platform/bot-core`) handles the parts that are easy to get wrong:
config, database, logging, the Discord command/button/modal router, HTTP, a fair work queue, and
process supervision. Each bot is left with just its own business logic, so adding the next internal
tool takes hours, not days.

It runs real operations: the bots here hand out single-use cards, track business revenue, and retrieve
verification codes for shared accounts, end to end, with no manual spreadsheet step.

---

## Why it's built this way

- **Shared core, thin bots.** Every bot imports `@platform/bot-core`. A fix to logging, the router,
  or migrations lands once and every bot gets it. New bots start at "business logic only."
- **Convention-based routing.** Interactions are dispatched by a `<botPrefix>:<action>:<args>`
  custom-ID convention, so buttons and modals survive restarts and route without a giant switch.
- **Migrations are code, applied on boot.** Each bot owns a `migrations/*.sql` folder; the core runs
  pending migrations automatically at startup. No manual DB steps on deploy.
- **Crash-only, supervised.** Bots run under PM2 (`pm2.config.cjs`) with auto-restart and backoff;
  in-flight Discord components are addressed by stable IDs so a restart doesn't strand a user.
- **Secrets never in the repo.** Only `.env.example` templates are committed; real `.env` files and
  all runtime data/DBs are gitignored. Each bot fails fast at boot if required config is missing
  (validated with a zod schema).
- **One management surface.** PM2 on Linux (`install.sh`) and a `start.bat` control panel on Windows
  give the same start/stop/restart/logs story on either host.

## Repository layout

```
.
├── packages/
│   └── bot-core/          # shared: env, db+migrations, logger, Discord router, http, queue, supervisor
├── bots/
│   ├── card-bot/          # single-use card pool + /card claim flow
│   ├── payment-bot/       # multi-rail revenue tracker
│   └── code-bot/          # verification-code retrieval
├── pm2.config.cjs         # one process per bot
├── install.sh             # Linux/PM2 deploy (idempotent)
└── start.bat              # Windows control-panel REPL
```

## The bots

| Bot | What it does | Deep dive |
|---|---|---|
| **card-bot** | A pool of single-use cards handed out one-at-a-time via `/card`, with providers, channel whitelisting, load/export, and a live stock panel | [README](bots/card-bot/README.md) |
| **payment-bot** | Aggregates incoming payments across rails (Zelle/Venmo/PayPal email + on-chain) and posts daily/weekly/monthly revenue totals to a Discord dashboard | [README](bots/payment-bot/README.md) |
| **code-bot** | Retrieves one-time verification codes from a dedicated inbox (IMAP, with a webhook fallback) and hands them out on request, one at a time | [README](bots/code-bot/README.md) |

## `@platform/bot-core`: what the shared core provides

| Module | Responsibility |
|---|---|
| `env` | zod-validated config loading; fail-fast on missing keys |
| `db` | SQLite open + automatic migration runner |
| `discord` | command/button/modal/select router + role-gating helpers |
| `http` | undici fetch wrapper: timeouts, JSON helpers, keep-alive, proxy support |
| `queue` | fair single-active-worker queue (idle timeout, promotion) |
| `supervisor` / `lockdown` | lifecycle + a global "lockdown" kill-switch |
| `logger` | structured logging |

## Running it

**Prerequisites:** Node 22+, PM2 (the launchers install it if missing).

```bash
npm install                         # installs the workspace
cp .env.example .env                # shared settings
for b in card-bot payment-bot code-bot; do cp bots/$b/.env.example bots/$b/.env; done
# fill in each bots/<bot>/.env
```

- **Linux:** `bash install.sh` (idempotent: runs `npm install` + `pm2 startOrReload`, preserves `.env`).
- **Windows:** run `start.bat` for a status + `start`/`stop`/`restart`/`logs` control panel.

Each bot's SQLite DB is created automatically by migrations on first start.

## Tech

`Node.js (ESM)` · `npm workspaces` · `discord.js` · `node:sqlite` · `undici` · `zod` · `PM2`
