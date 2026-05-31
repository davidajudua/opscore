import { spawnSync } from 'node:child_process';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const DOT = '●';

const BOT_NAMES = new Set(['card-bot', 'code-bot', 'payment-bot']);
const TRANSIENT = new Set(['launching', 'stopping', 'restarting', 'waiting restart']);

function colorFor(status) {
  if (status === 'online') return GREEN;
  if (TRANSIENT.has(status)) return YELLOW;
  return RED;
}

const msg = process.argv[2] ?? '';
const out = process.stdout;

const result = spawnSync('pm2 jlist', { encoding: 'utf8', shell: true });

if (result.error || result.status !== 0) {
  const why = result.error?.message ?? `exit ${result.status}`;
  out.write(`     ${RED}(pm2 status unavailable: ${why})${RESET}\n`);
} else {
  try {
    const apps = JSON.parse(result.stdout);
    const bots = apps
      .filter((p) => BOT_NAMES.has(p?.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (bots.length === 0) {
      out.write(`     ${DIM}(no bots registered)${RESET}\n`);
    } else {
      for (const p of bots) {
        const s = p.pm2_env?.status ?? 'unknown';
        const c = colorFor(s);
        out.write(`     ${c}${DOT}${RESET}  ${p.name}\n`);
      }
    }
  } catch (err) {
    out.write(`     ${RED}(could not parse pm2 output: ${err.message})${RESET}\n`);
  }
}

out.write('\n');

if (msg) {
  out.write(`     ${DIM}${msg}${RESET}\n`);
  out.write('\n');
}

out.write(`     ${DIM}start    restart    stop    cleanup    quit${RESET}\n`);
out.write('\n');
