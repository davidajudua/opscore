import { spawn } from 'node:child_process';

// `pm2 restart all` includes the requesting bot itself, so we get SIGTERM'd
// shortly after the child process is spawned. If the child is in our process
// group, it dies with us — and pm2 may have only partially received the
// request, leaving nothing actually restarted. detached + unref makes the
// child independent: even after we exit, it keeps running and tells pm2 to
// finish the job.
//
// We avoid shell:true (it triggers Node's DEP0190 deprecation when args are
// passed alongside) and instead resolve the platform-specific binary up
// front — pm2 ships as `pm2.cmd` on Windows and plain `pm2` on POSIX.
const PM2_CMD = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';

function pm2(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PM2_CMD, args, {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function pm2RestartAll() {
  return pm2(['restart', 'all']);
}
