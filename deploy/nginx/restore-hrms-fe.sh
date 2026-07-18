#!/usr/bin/env bash
# Restore HRMS frontend TLS/vhost after an API nginx conflict purge.
# Run on the VPS as root:
#   bash /home/source/prod/hrms-be/deploy/nginx/restore-hrms-fe.sh
set -euo pipefail

FE_DOMAIN="${FE_DOMAIN:-hrms.devcognito.tech}"
FE_PORT="${FE_PORT:-8082}"
FE_APP="${FE_APP:-hrms-fe}"
API_DOMAIN="${API_DOMAIN:-hrms-be.devcognito.tech}"
API_PORT="${API_PORT:-3202}"

echo "== nginx sites =="
ls -la /etc/nginx/sites-enabled/ || true
echo
echo "== who claims ${FE_DOMAIN} / ${API_DOMAIN} =="
grep -RIn "server_name.*${FE_DOMAIN}\|server_name.*${API_DOMAIN}" \
  /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true

echo
echo "== restore backups if present =="
shopt -s nullglob
for bak in /etc/nginx/sites-available/MF-FE.conf.bak-conflict-* \
           /etc/nginx/sites-available/hrms-fe.conf.bak-conflict-* \
           /etc/nginx/sites-available/*.bak-strip-*; do
  echo "found backup: ${bak}"
done

# Prefer official FE apply-site from deployed source.
if [[ -x /home/source/prod/hrms-fe/deploy/nginx/apply-site.sh ]]; then
  echo "== re-applying FE site ${FE_DOMAIN} -> :${FE_PORT} =="
  sed -i 's/\r$//' /home/source/prod/hrms-fe/deploy/nginx/apply-site.sh
  /home/source/prod/hrms-fe/deploy/nginx/apply-site.sh "${FE_APP}" "${FE_DOMAIN}" "${FE_PORT}"
elif [[ -x /home/source/prod/hrms-fe/deploy/nginx/apply-site.sh ]]; then
  /home/source/prod/hrms-fe/deploy/nginx/apply-site.sh "${FE_APP}" "${FE_DOMAIN}" "${FE_PORT}"
else
  echo "WARN: FE apply-site.sh missing — writing minimal ${FE_APP}.conf"
  CERT_DIR="/etc/letsencrypt/live/${FE_DOMAIN}"
  cat >"/etc/nginx/sites-available/${FE_APP}.conf" <<EOF
server {
    listen 80;
    server_name ${FE_DOMAIN};
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    server_name ${FE_DOMAIN};
    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:${FE_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sfn "/etc/nginx/sites-available/${FE_APP}.conf" "/etc/nginx/sites-enabled/${FE_APP}.conf"
  nginx -t
  systemctl reload nginx
fi

# Ensure API host is not claimed by FE, without deleting FE vhost.
if [[ -x /home/source/prod/hrms-be/deploy/nginx/apply-site.sh ]]; then
  echo "== re-asserting API site ${API_DOMAIN} -> :${API_PORT} =="
  sed -i 's/\r$//' /home/source/prod/hrms-be/deploy/nginx/apply-site.sh
  /home/source/prod/hrms-be/deploy/nginx/apply-site.sh hrms-be "${API_DOMAIN}" "${API_PORT}"
fi

echo
echo "== verify cert names =="
echo | openssl s_client -servername "${FE_DOMAIN}" -connect 127.0.0.1:443 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null || true
curl -fsSk --resolve "${FE_DOMAIN}:443:127.0.0.1" "https://${FE_DOMAIN}/" -o /dev/null -w "FE HTTPS %{http_code}\n" || true
curl -fsSk --resolve "${API_DOMAIN}:443:127.0.0.1" "https://${API_DOMAIN}/" | head -c 120 || true
echo
echo "OK: restore finished — open https://${FE_DOMAIN} (hard refresh)"
