#!/bin/bash
# One-time Hostinger VPS bootstrap for per-repo Docker deployments.
# Run as root on the VPS before the first CircleCI deploy.
set -euo pipefail

echo "==> Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

echo "==> Ensuring Docker Compose plugin..."
docker compose version

echo "==> Installing Nginx and Certbot..."
if command -v apt-get &>/dev/null; then
  apt-get update
  apt-get install -y nginx certbot python3-certbot-nginx
elif command -v dnf &>/dev/null; then
  dnf install -y nginx certbot python3-certbot-nginx
fi

echo "==> Creating shared Docker network..."
docker network inspect shared_network &>/dev/null || docker network create shared_network

echo "==> Creating source and env directories..."
REPOS=(mf-fe mf-be hrms-fe hrms-be hrms-py)
for repo in "${REPOS[@]}"; do
  mkdir -p "/home/source/prod/${repo}"
  mkdir -p "/home/env/prod/${repo}"
  touch "/home/env/prod/${repo}/prod.env"
done

echo "==> Bootstrap complete."
echo "Next steps:"
echo "  1. Point DNS A records for your domains to this VPS IP"
echo "  2. Add 147.93.18.45 and SSH key to each CircleCI project"
echo "  3. Set APP_DOMAIN in each CircleCI project (MF_FE_DOMAIN, etc.)"
echo "  4. Push to main to trigger deploy"
echo "  5. After first deploy, run: certbot --nginx -d <your-domain>"
