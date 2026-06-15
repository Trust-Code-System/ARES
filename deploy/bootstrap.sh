#!/usr/bin/env bash
# One-shot ARES bootstrap for a fresh Ubuntu/Debian VPS.
#
# After you've created the server and pointed DNS (ares.<domain> and
# api.ares.<domain>) at it, run this AS ROOT on the box:
#
#   curl -fsSL https://raw.githubusercontent.com/Trust-Code-System/ARES/feat/jarvis-voice-hud/deploy/bootstrap.sh -o bootstrap.sh
#   bash bootstrap.sh
#
# It installs Docker, opens the firewall, clones the repo, and (once your .env
# exists) brings the whole stack up. Re-running it safely updates an existing
# install.
set -euo pipefail

REPO="${ARES_REPO:-https://github.com/Trust-Code-System/ARES.git}"
BRANCH="${ARES_BRANCH:-feat/jarvis-voice-hud}"
DIR="${ARES_DIR:-/opt/ares}"

log() { printf '\n\033[1;36m[ares]\033[0m %s\n' "$*"; }

# 1. Docker (with the compose plugin) — official convenience script.
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
else
  log "Docker already present: $(docker --version)"
fi

# 2. Firewall — allow SSH + HTTP/HTTPS only.
if command -v ufw >/dev/null 2>&1; then
  log "Configuring firewall (22/80/443)..."
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22 >/dev/null 2>&1 || true
  ufw allow 80 >/dev/null 2>&1 || true
  ufw allow 443 >/dev/null 2>&1 || true
  yes | ufw enable >/dev/null 2>&1 || true
fi

# 3. Clone or update the repo.
if [ -d "$DIR/.git" ]; then
  log "Updating existing checkout in $DIR..."
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout "$BRANCH"
  git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  log "Cloning $REPO ($BRANCH) into $DIR..."
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

# 4. Require a configured .env (secrets are never committed).
if [ ! -f .env ]; then
  cat >&2 <<EOF

[ares] No .env found in $DIR.

Create $DIR/.env with at least:
  ARES_API_KEY=<openssl rand -base64 32>
  ANTHROPIC_API_KEY=...   and/or  GEMINI_API_KEY=...
  DATABASE_URL=postgres://...      (reachable from this server, with pgvector)
  ARES_DOMAIN=ares.yourdomain.com

Then re-run:  bash deploy/bootstrap.sh
EOF
  exit 1
fi

if ! grep -q '^ARES_DOMAIN=' .env; then
  echo "[ares] WARNING: ARES_DOMAIN is not set in .env — TLS/routing will not work." >&2
fi

# 5. Build + launch.
log "Building and starting the stack..."
docker compose up -d --build
docker compose ps

log "Done. Tail the API with:  docker compose -C $DIR logs -f api"
log "Open: https://$(grep '^ARES_DOMAIN=' .env | cut -d= -f2-)"
