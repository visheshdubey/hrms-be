#!/usr/bin/env bash
# Idempotent nginx + TLS setup for one app hostname.
# Usage: apply-site.sh <app_name> <domain> <proxy_port>
set -euo pipefail

APP_NAME="${1:?app name required}"
DOMAIN="${2:?domain required}"
PROXY_PORT="${3:?proxy port required}"
EMAIL="${CERTBOT_EMAIL:-admin@devcognito.tech}"

CONF_AVAILABLE="/etc/nginx/sites-available/${APP_NAME}.conf"
CONF_ENABLED="/etc/nginx/sites-enabled/${APP_NAME}.conf"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"

write_http_only() {
  cat >"${CONF_AVAILABLE}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    access_log /var/log/nginx/${APP_NAME}.access.log;
    error_log /var/log/nginx/${APP_NAME}.error.log;

    location / {
        proxy_pass http://127.0.0.1:${PROXY_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
    }
}
EOF
}

write_http_redirect_and_https() {
  local ssl_options=""
  local ssl_dh=""
  if [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
    ssl_options="include /etc/letsencrypt/options-ssl-nginx.conf;"
  fi
  if [[ -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    ssl_dh="ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
  fi

  cat >"${CONF_AVAILABLE}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ${ssl_options}
    ${ssl_dh}

    access_log /var/log/nginx/${APP_NAME}.access.log;
    error_log /var/log/nginx/${APP_NAME}.error.log;

    location / {
        proxy_pass http://127.0.0.1:${PROXY_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
    }
}
EOF
}

write_http_only
ln -sfn "${CONF_AVAILABLE}" "${CONF_ENABLED}"
# Drop broken default that steals unknown hosts onto FE (if present as catch-all).
nginx -t
systemctl reload nginx

if [[ ! -f "${CERT_DIR}/fullchain.pem" ]]; then
  # certonly does not permanently rewrite our site proxy_pass the way `certbot --nginx` install does.
  certbot certonly --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" || true
fi

if [[ -f "${CERT_DIR}/fullchain.pem" ]]; then
  write_http_redirect_and_https
  ln -sfn "${CONF_AVAILABLE}" "${CONF_ENABLED}"
  nginx -t
  systemctl reload nginx
else
  echo "WARN: TLS cert missing for ${DOMAIN}; left HTTP-only proxy on :80"
fi

if curl -fsS -m 5 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1 || \
   curl -fsS -m 5 "http://127.0.0.1:${PROXY_PORT}/" >/dev/null 2>&1; then
  echo "OK: upstream :${PROXY_PORT} reachable for ${DOMAIN}"
else
  echo "ERROR: upstream 127.0.0.1:${PROXY_PORT} is not responding"
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
  exit 1
fi

BODY="$(curl -fsS -m 5 -H "Host: ${DOMAIN}" "http://127.0.0.1/" || true)"
if [[ "${APP_NAME}" == "hrms-be" ]]; then
  if echo "${BODY}" | grep -qi '<html\|hrms-ui\|<!doctype'; then
    echo "ERROR: ${DOMAIN} is serving frontend HTML instead of API"
    echo "${BODY}" | head -c 200
    exit 1
  fi
fi

echo "OK: nginx site applied for ${DOMAIN} -> 127.0.0.1:${PROXY_PORT}"
