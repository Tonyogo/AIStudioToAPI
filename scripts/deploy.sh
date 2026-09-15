#!/usr/bin/env bash
set -e

# Load user environment variables (e.g. NVM, Node, PM2 paths)
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"
[ -s "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
[ -s "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null || true

# Determine PM2 executable (prefer global pm2, fallback to npx pm2)
PM2_CMD="pm2"
if ! command -v pm2 &>/dev/null; then
  PM2_CMD="npx pm2"
fi

echo "=========================================="
echo "Deployment Directory : $(pwd)"
echo "Node Version         : $(node -v 2>/dev/null || echo 'not found')"
echo "NPM Version          : $(npm -v 2>/dev/null || echo 'not found')"
echo "PM2 Version          : $($PM2_CMD -v 2>/dev/null || echo 'not found')"
echo "=========================================="

# Record current commit hash before pull to detect dependency changes
PREV_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")

echo "===> [1/4] Pulling latest code from origin/dev..."
git fetch origin dev
git reset --hard origin/dev

NEW_COMMIT=$(git rev-parse HEAD)

# Fast NPM flags: skip security audit & skip fund & prefer offline cache
NPM_FLAGS="--no-audit --no-fund --prefer-offline --include=dev"

# Check if dependencies changed or node_modules/vite is missing
DEPS_CHANGED=false
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/vite" ]; then
  DEPS_CHANGED=true
elif [ -n "$PREV_COMMIT" ] && [ "$PREV_COMMIT" != "$NEW_COMMIT" ]; then
  if git diff --name-only "$PREV_COMMIT" "$NEW_COMMIT" | grep -qE '^(package\.json|package-lock\.json)$'; then
    DEPS_CHANGED=true
  fi
fi

echo "===> [2/4] Checking and installing dependencies..."
if [ "$DEPS_CHANGED" = true ]; then
  echo "-> Dependencies changed (or missing vite), installing with speed flags..."
  NODE_ENV=development npm install $NPM_FLAGS
else
  echo "-> Dependencies unchanged, skipping npm install (instant ⚡)"
fi

# Fallback check: ensure vite binary is present before building UI
if [ ! -f "node_modules/.bin/vite" ]; then
  echo "-> Warning: vite binary missing, performing fallback installation..."
  NODE_ENV=development npm install $NPM_FLAGS
fi

echo "===> [3/4] Building frontend UI..."
npm run build:ui

echo "===> [4/4] Reloading PM2 process..."
$PM2_CMD reload ecosystem.config.js || $PM2_CMD start ecosystem.config.js

echo "===> Process Status:"
$PM2_CMD status aistudio-to-api

echo "=========================================="
echo "✅ Deployment completed successfully!"
echo "=========================================="
