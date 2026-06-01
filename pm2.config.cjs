// PM2 ecosystem file. Brings up each bot as an independent process.
//
// Usage:
//   npm install -g pm2          (one-time)
//   npm start                    (alias: pm2 start pm2.config.cjs)
//   npm run logs                 (alias: pm2 logs)
//   npm run status               (alias: pm2 status)
//
// Each bot has its own log files under logs/<bot-name>/. PM2's log files
// (pm2 stdout/stderr capture) live alongside as <bot>-pm2.{out,err}.log.

const path = require('path');

const repoRoot = __dirname;
const logsDir = path.join(repoRoot, 'logs');

function botApp(name) {
  return {
    name,
    cwd: path.join(repoRoot, 'bots', name),
    script: 'src/index.js',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '60s',
    exp_backoff_restart_delay: 100,
    out_file: path.join(logsDir, name, `${name}-pm2.out.log`),
    error_file: path.join(logsDir, name, `${name}-pm2.err.log`),
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: 'production',
    },
  };
}

module.exports = {
  apps: [botApp('code-bot'), botApp('payment-bot'), botApp('card-bot')],
};
