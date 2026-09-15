#!/usr/bin/env bash

set -euo pipefail

echo "========================================"
echo " AIStudioToAPI"
echo " Ubuntu 24.04 Server Dependency Installer"
echo "========================================"

# ------------------------------------------------------------
# 1. Update apt
# ------------------------------------------------------------

echo
echo "[1/6] Updating apt package index..."

sudo apt-get update

# ------------------------------------------------------------
# 2. Install system dependencies
# ------------------------------------------------------------

echo
echo "[2/6] Installing system dependencies..."

sudo apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    libgtk-3-0 \
    libdbus-glib-1-2 \
    libxt6 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxrandr2 \
    libasound2t64 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libfontconfig1 \
    libfreetype6 \
    libglib2.0-0 \
    libpango-1.0-0 \
    libxrender1 \
    libxss1

# ------------------------------------------------------------
# 3. Add Cloudflare repository
# ------------------------------------------------------------

echo
echo "[3/6] Configuring Cloudflare repository..."

sudo mkdir -p --mode=0755 /usr/share/keyrings

curl -fsSL \
    https://pkg.cloudflare.com/cloudflare-main.gpg \
    | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null

# ------------------------------------------------------------
# 4. Install cloudflared
# ------------------------------------------------------------

echo
echo "[4/6] Installing cloudflared..."

sudo apt-get update

sudo apt-get install -y cloudflared

# ------------------------------------------------------------
# 5. Install and start cloudflared service (optional)
# ------------------------------------------------------------

echo
echo "[5/6] Configuring cloudflared service..."

TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-${1:-}}"

if [ -n "$TUNNEL_TOKEN" ]; then
    echo "Installing cloudflared service with provided tunnel token..."
    sudo cloudflared service install "$TUNNEL_TOKEN"
else
    echo "Notice: No tunnel token provided via \$CLOUDFLARE_TUNNEL_TOKEN or \$1."
    echo "To install cloudflared service manually, run:"
    echo "  sudo cloudflared service install <TUNNEL_TOKEN>"
fi

# ------------------------------------------------------------
# 6. Install PM2 globally
# ------------------------------------------------------------

echo
echo "[6/6] Installing PM2 process manager globally..."

# Load user environment variables (e.g. NVM, Node paths)
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"
[ -s "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
[ -s "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null || true

if ! command -v npm >/dev/null 2>&1; then
    echo "Warning: npm is not found in PATH. Please ensure Node.js & npm are installed."
else
    # Try user-level install first, fallback to sudo if needed
    npm install -g pm2 || sudo npm install -g pm2
fi

# ------------------------------------------------------------
# Verify
# ------------------------------------------------------------

echo
echo "========================================"
echo " Installation completed successfully"
echo "========================================"

echo
echo "cloudflared version:"
cloudflared --version

echo
echo "cloudflared path:"
command -v cloudflared

echo
echo "pm2 version:"
pm2 -v 2>/dev/null || echo "pm2 not installed or not in PATH"

echo
echo "pm2 path:"
command -v pm2 || true

echo
echo "Done."
