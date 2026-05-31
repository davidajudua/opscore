/**
 * Fleet-wide kill switch. When the marker file exists at <repoRoot>/data/fleet-lockdown,
 * worker-facing commands across all bots should refuse with a "bot disabled" message.
 *
 * Marker file is just a presence flag — its contents (a timestamp) are informational.
 * Filesystem existence is the source of truth, so any process can check without
 * needing a database connection.
 */

import fs from 'node:fs';
import path from 'node:path';

function lockfilePath(repoRoot) {
  return path.join(repoRoot, 'data', 'fleet-lockdown');
}

export function isLockedDown(repoRoot) {
  return fs.existsSync(lockfilePath(repoRoot));
}

export function setLockdown(repoRoot, locked) {
  const dir = path.join(repoRoot, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = lockfilePath(repoRoot);
  if (locked) {
    fs.writeFileSync(file, String(Date.now()));
  } else if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}
