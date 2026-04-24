#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Maxxag WA Ops — VPS bootstrap script
# Target: Ubuntu 22.04 / 24.04 LTS (Debian 12 also works)
# Run: bash scripts/install-vps.sh
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
cd "$ROOT"

log() { echo -e "\033[1;34m[install]\033[0m $*"; }
err() { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

# ── 1. Checks ───────────────────────────────────────────────────
if [[ $EUID -eq 0 ]]; then
    err "Do NOT run as root. Run as a regular user with sudo."
    exit 1
fi

if ! command -v sudo &>/dev/null; then
    err "sudo is required."
    exit 1
fi

# ── 2. Install Docker ───────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    log "Installing Docker Engine..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    log "Docker installed. You may need to log out/in for group changes to take effect."
fi

if ! docker compose version &>/dev/null; then
    err "Docker Compose plugin not found. Install the newer 'docker compose' (v2+) CLI."
    exit 1
fi

# ── 3. Firewall (UFW) ───────────────────────────────────────────
if command -v ufw &>/dev/null; then
    log "Configuring UFW firewall (SSH + HTTP + HTTPS only)..."
    sudo ufw --force default deny incoming
    sudo ufw --force default allow outgoing
    sudo ufw allow 22/tcp
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw --force enable
fi

# ── 4. Generate .env if missing ─────────────────────────────────
if [[ ! -f .env ]]; then
    log "Generating .env with random secrets..."
    cp .env.example .env

    # Use openssl to generate hex secrets; replace placeholders in-place
    replace_secret() {
        local var="$1" bytes="$2"
        local val
        val=$(openssl rand -hex "$bytes")
        # sed -i with backup for portability
        sed -i.bak "s|${var}=<GENERATE_WITH_openssl_rand_hex_${bytes}>|${var}=${val}|" .env
    }

    replace_secret POSTGRES_PASSWORD       24
    replace_secret CHATWOOT_DB_PASSWORD    24
    replace_secret EVOLUTION_DB_PASSWORD   24
    replace_secret KPI_DB_PASSWORD         24
    replace_secret EVOLUTION_API_KEY       32
    replace_secret JWT_SECRET              32

    rm -f .env.bak
    log "Secrets generated. Remaining placeholders to fill manually in .env:"
    log "  - DOMAIN (when you decide the domain)"
    log "  - ANTHROPIC_API_KEY (sk-ant-...)"
    log "  - KPI_ADMIN_PASSWORD_HASH (run: python scripts/hash-admin-password.py)"
else
    log ".env already exists — keeping it."
fi

# ── 5. Generate Chatwoot env ────────────────────────────────────
if [[ ! -f .env.chatwoot ]]; then
    log "Generating .env.chatwoot..."
    # shellcheck disable=SC1091
    set -a
    source .env
    set +a

    cp .env.chatwoot.example .env.chatwoot
    SECRET_KEY_BASE=$(openssl rand -hex 64)
    sed -i.bak "s|SECRET_KEY_BASE=<GENERATE>|SECRET_KEY_BASE=${SECRET_KEY_BASE}|" .env.chatwoot
    sed -i.bak "s|POSTGRES_PASSWORD=<CHATWOOT_DB_PASSWORD from main .env>|POSTGRES_PASSWORD=${CHATWOOT_DB_PASSWORD}|" .env.chatwoot
    sed -i.bak "s|<YOUR_DOMAIN>|${DOMAIN}|g" .env.chatwoot
    rm -f .env.chatwoot.bak
fi

# ── 6. Prepare Chatwoot DB (migrate) ────────────────────────────
log "Pulling images (may take a few min)..."
docker compose pull

log "Preparing Chatwoot database..."
docker compose run --rm chatwoot-rails bundle exec rails db:chatwoot_prepare || {
    log "First-time setup may fail if DB already seeded — ignoring."
}

# ── 7. Start everything ─────────────────────────────────────────
log "Starting all services..."
docker compose up -d

log "Waiting for services to come up..."
sleep 15
docker compose ps

cat <<-EOF

══════════════════════════════════════════════════════════════════
Installation complete!

Next steps:
  1. Point DNS A records to this server's IP for:
       admin.\${DOMAIN}
       kpi.\${DOMAIN}

  2. Wait 2-3 min for Caddy to issue HTTPS certs (Let's Encrypt).

  3. Visit https://admin.\${DOMAIN}
     - Create superadmin account
     - Settings > Inboxes > Add Inbox > WhatsApp (Evolution API)
     - Use Evolution API URL: http://evolution:8080
     - Use Evolution API Key from .env (\${EVOLUTION_API_KEY})
     - Scan QR with the house's WhatsApp

  4. Visit https://kpi.\${DOMAIN}
     - Login with \${KPI_ADMIN_EMAIL} + your chosen password

Logs:        docker compose logs -f
Stop:        docker compose stop
Restart:     docker compose restart
Update:      docker compose pull && docker compose up -d

══════════════════════════════════════════════════════════════════
EOF
