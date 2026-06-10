#!/bin/bash
# BreakoutIntel — Production Deployment Script
# Supports: Ubuntu 22.04+ VPS, or use Render/Railway (see README)
#
# Usage: chmod +x deploy.sh && ./deploy.sh
#
# Prerequisites:
#   - Ubuntu 22.04 VPS (Hetzner €4/mo, DigitalOcean $6/mo, Oracle Free Tier)
#   - Domain pointed to server IP
#   - .env file created from .env.example

set -e

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

log()   { echo -e "${GREEN}[✓]${RESET} $1"; }
warn()  { echo -e "${YELLOW}[!]${RESET} $1"; }
error() { echo -e "${RED}[✗]${RESET} $1"; exit 1; }
info()  { echo -e "${BOLD}$1${RESET}"; }

# ── 1. Check prerequisites ────────────────────────────────────────────────────
info "=== BreakoutIntel Deployment ==="

if [ ! -f .env ]; then
  error ".env file not found! Copy .env.example to .env and fill in values."
fi

source .env

if [ -z "$DOMAIN" ]; then error "DOMAIN not set in .env"; fi
if [ -z "$POSTGRES_PASSWORD" ]; then error "POSTGRES_PASSWORD not set in .env"; fi
if [ -z "$JWT_SECRET" ]; then error "JWT_SECRET not set in .env"; fi

# ── 2. Install Docker if not present ──────────────────────────────────────────
if ! command -v docker &> /dev/null; then
  warn "Docker not found. Installing..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  log "Docker installed"
fi

if ! command -v docker-compose &> /dev/null; then
  warn "docker-compose not found. Installing..."
  sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
  sudo chmod +x /usr/local/bin/docker-compose
  log "docker-compose installed"
fi

# ── 3. Create SSL directory ────────────────────────────────────────────────────
mkdir -p nginx/ssl

# ── 4. Build and start services (HTTP first for certbot) ──────────────────────
info "Building Docker images..."
docker-compose build --no-cache

info "Starting services (HTTP mode for SSL setup)..."
docker-compose up -d postgres redis backend frontend

# Wait for services to be healthy
log "Waiting for services to be ready..."
sleep 10

# ── 5. SSL Certificate (Let's Encrypt — FREE) ─────────────────────────────────
if [ ! -f "nginx/ssl/live/${DOMAIN}/fullchain.pem" ]; then
  info "Obtaining SSL certificate from Let's Encrypt..."
  
  # Start nginx in HTTP-only mode temporarily
  docker-compose up -d nginx
  
  docker-compose run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "${SSL_EMAIL}" \
    --agree-tos \
    --no-eff-email \
    -d "${DOMAIN}"
  
  log "SSL certificate obtained!"
else
  log "SSL certificate already exists, skipping..."
fi

# ── 6. Start full stack with HTTPS ────────────────────────────────────────────
info "Starting full stack with HTTPS..."
docker-compose up -d

# ── 7. Set up auto-renewal (cron) ─────────────────────────────────────────────
(crontab -l 2>/dev/null; echo "0 12 * * * docker-compose run --rm certbot renew --quiet && docker-compose exec nginx nginx -s reload") | crontab -
log "Auto-renewal configured"

# ── 8. Set up log rotation ────────────────────────────────────────────────────
cat > /etc/logrotate.d/breakoutintel << 'EOF'
/var/lib/docker/containers/*/*.log {
  daily
  missingok
  rotate 7
  compress
  delaycompress
  notifempty
}
EOF

# ── 9. Set up firewall ────────────────────────────────────────────────────────
if command -v ufw &> /dev/null; then
  sudo ufw allow 22
  sudo ufw allow 80
  sudo ufw allow 443
  sudo ufw --force enable
  log "Firewall configured"
fi

# ── 10. Health check ──────────────────────────────────────────────────────────
info "Running health checks..."
sleep 5

BACKEND_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/health || echo "000")
if [ "$BACKEND_HEALTH" = "200" ]; then
  log "Backend API: healthy"
else
  warn "Backend API returned $BACKEND_HEALTH — check logs: docker-compose logs backend"
fi

FRONTEND_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 || echo "000")
if [ "$FRONTEND_HEALTH" = "200" ]; then
  log "Frontend: healthy"
else
  warn "Frontend returned $FRONTEND_HEALTH — check logs: docker-compose logs frontend"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
info "🎯 BreakoutIntel is LIVE!"
echo ""
echo -e "  Dashboard URL: ${GREEN}https://${DOMAIN}${RESET}"
echo -e "  API Base URL:  ${GREEN}https://${DOMAIN}/api${RESET}"
echo -e "  WebSocket:     ${GREEN}wss://${DOMAIN}/ws${RESET}"
echo ""
echo -e "  Logs:   docker-compose logs -f"
echo -e "  Stop:   docker-compose down"
echo -e "  Update: git pull && docker-compose up -d --build"
echo ""
warn "IMPORTANT: Change admin password at https://${DOMAIN}/settings"
