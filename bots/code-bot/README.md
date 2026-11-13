# code-bot

Hands out the one-time codes that the business's card accounts send, one employee at a time, without sharing the mailbox they arrive in.
An employee joins a queue in Discord.
When it is their turn they press **Get Code**, and the bot finds the newest unused code and posts it to them.
A code is never handed out twice.

## Providers

`/deploy provider:<name>` posts a queue panel for one provider in the current channel.
Each provider has its own queue and panel.

| Provider | Where codes come from | How a code is matched |
|---|---|---|
| `amex` | Amex SafeKey emails in the Proton Mail Bridge mailbox. Optionally also a Discord channel where an SMS forwarder's webhook posts SafeKey texts. | The email body's "Your Verification Code is: 123456", or a webhook message starting "123456 is your ... SafeKey" |
| `eno` | Capital One purchase notification emails in the same mailbox | The employee types the 3-character code Google Pay shows them, and the bot looks for "at <code> <6 digits>" in the email |

## How it works

1. An employee presses **Request Code** on a panel and joins that provider's queue. Only the person at the front is served.
2. For `amex`, the employee presses **Get Code** after placing their order. The bot searches the mailbox every 2 seconds for up to 60 seconds. If the webhook source is configured, it searches the webhook channel at the same time, and the first source to find a code wins.
3. For `eno`, the employee enters their 3-character Google Pay code when they join. The search starts when their turn comes, and runs every 2 seconds for up to 3 minutes, since Capital One emails can be slow.
4. The bot records the code before it posts it. The email UID, the Discord message id and the code value each go into their own table, and a code already in any of them is skipped. Rows older than an hour are deleted on later searches.
5. An employee who does nothing for 60 seconds at the front of the queue is skipped, and the next person is served.

## Design decisions

- **One person served at a time.** The queue is bot-core's `WorkerQueue`, a SQLite table with one active entry and an idle timeout. Two employees can never race for the same code.
- **Codes are claimed atomically.** Each source claims with `INSERT OR IGNORE`, so even two fetchers running at once could not return the same email or message.
- **Deduplicated across sources.** Amex can send one code by both email and text. The `served_code_values` table keys on the code itself, so the second copy is skipped.
- **Searches by arrival time, to the second.** IMAP `SEARCH SINCE` only filters by day, so the bot searches a wider window and filters on each message's internal date.
- **State survives restarts.** The queue, the served codes and the panel locations are in SQLite, and panel buttons use stable custom ids.
- **Secrets stay in `.env`.** The mailbox password is never committed, and `data/` is gitignored.

## Code layout

```
src/
├── imap-fetcher.js     Amex SafeKey codes from the mailbox, and the shared served-code tables
├── eno-fetcher.js      Capital One codes from the mailbox, matched on the employee's hint
├── webhook-fetcher.js  Amex SafeKey codes from a Discord channel fed by an SMS forwarder
├── session.js          the panel views: your turn, fetching, code, timeout
├── deploy.js           one panel per provider
├── handlers/           request, get code, release, cancel, retry, done, /deploy, Eno modal
└── index.js            boot: env, database and migrations, queues, fetchers, Discord
```

## Setup

```bash
cp .env.example .env
```

Fill in the Discord token, client id, guild id and channel id, and the Proton Mail Bridge login.
The template already holds the Bridge's defaults, `127.0.0.1`, port `1143` and folder `INBOX`, which work for a Bridge on the same machine.
To add the SMS source, set both `WEBHOOK_CODE_CHANNEL_ID` and `WEBHOOK_CODE_AUTHOR_ID`. With either one missing, only the mailbox is used.
Start the bot with the root `install.sh` or `start.bat`.
Then run `/deploy provider:amex` or `/deploy provider:eno` in the channel where employees should request codes.
`/deploy` is limited to members with Discord's Administrator permission, unless a server admin changes that under the server's Integrations settings.
