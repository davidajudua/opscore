#!/usr/bin/env bash
# Idempotent deploy for Linux hosts. Safe to re-run: installs deps and
# (re)starts every bot under PM2 without touching your .env files.
#
#   bash install.sh
#
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "[error] Node.js 22+ not installed"; exit 1; }
command -v pm2  >/dev/null 2>&1 || { echo "installing pm2..."; npm install -g pm2; }

echo "installing dependencies..."
npm install

# Warn (don't fail) on any bot missing its .env, so a partial host still starts the rest.
for d in bots/*/; do
  b="$(basename "$d")"
  [ -f "$d/.env" ] || echo "[warn] $b is missing bots/$b/.env (copy from .env.example)"
done

echo "starting bots..."
pm2 startOrReload pm2.config.cjs --update-env
pm2 save
echo "done. 'pm2 status' to view, 'pm2 logs' to tail."
