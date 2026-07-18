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

# Escape hostname for use in grep -E / sed -E (] must be first in the class).
escape_regex() {
  printf '%s' "$1" | sed -e 's/[][\\.^$*+?(){}|]/g' '\\&'
}

# True if a site file's server_name line claims this hostname (quoted/unquoted, multi-name).
file_claims_server_name() {
  local file="$1"
  local domain="$2"
  local escaped
  escaped="$(escape_regex "${domain}")"
  grep -Eiq "server_name[[:space:]]+[^;#]*${escaped}([\"[:space:];]|$)" "${file}" 2>/dev/null
}

# Frontend / other app vhosts — never delete these when applying the API site.
is_protected_vhost() {
  case "$1" in
    hrms-fe.conf|MF-FE.conf|hrms.conf) return 0 ;;
    *) return 1 ;;
  esac
}

# Remove only this hostname from server_name lines — do NOT delete whole FE vhosts.
# Deleting MF-FE.conf / hrms-fe.conf wholesale breaks hrms.devcognito.tech TLS (wrong default cert).
strip_server_name_from_file() {
  local file="$1"
  local domain="$2"
  local escaped tmp
  escaped="$(escape_regex "${domain}")"
  tmp="$(mktemp)"
  sed -E \
    -e "s/([\"[:space:]])${escaped}([\"[:space:];])/\\1\\2/g" \
    -e "s/server_name[[:space:]]+${escaped}([\"[:space:];])/server_name\\1/g" \
    -e "s/server_name[[:space:]]+\"${escaped}\"([\"[:space:];])/server_name\\1/g" \
    "${file}" >"${tmp}"
  sed -E -i \
    -e 's/server_name[[:space:]]*;/# server_name removed (conflict purge);/g' \
    -e 's/server_name[[:space:]]+;/# server_name removed (conflict purge);/g' \
    "${tmp}"
  cat "${tmp}" >"${file}"
  rm -f "${tmp}"
}

# When another site file also claims our API domain, strip that name only.
# Never delete protected FE vhosts (that caused ERR_CERT_COMMON_NAME_INVALID for hrms.devcognito.tech).
purge_conflicting_server_names() {
  local domain="$1"
  local keep_base="$2"
  local file base

  for dir in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
    [[ -d "${dir}" ]] || continue
    for file in "${dir}"/*; do
      [[ -e "${file}" ]] || continue
      base="$(basename "${file}")"
      [[ "${base}" == "${keep_base}" ]] && continue
      if file_claims_server_name "${file}" "${domain}"; then
        echo "WARN: stripping ${domain} from conflicting nginx site ${file}"
        cp -a "${file}" "${file}.bak-strip-$(date +%s)" 2>/dev/null || true
        strip_server_name_from_file "${file}" "${domain}"
        if is_protected_vhost "${base}"; then
          echo "WARN: keeping protected vhost ${base} (FE TLS)"
          continue
        fi
        if ! grep -Eq 'server_name[[:space:]]+[^;#]+;' "${file}" 2>/dev/null; then
          echo "WARN: ${file} has no remaining server_name — disabling"
          rm -f "${file}"
        fi
      fi
    done
  done

  if [[ -d /etc/nginx/sites-available ]]; then
    for file in /etc/nginx/sites-available/*; do
      [[ -e "${file}" ]] || continue
      base="$(basename "${file}")"
      [[ "${base}" == "${keep_base}" ]] && continue
      case "${base}" in
        *.bak-conflict-*|*.bak-strip-*) continue ;;
      esac
      if file_claims_server_name "${file}" "${domain}"; then
        echo "WARN: stripping ${domain} from sites-available ${file}"
        cp -a "${file}" "${file}.bak-strip-$(date +%s)" 2>/dev/null || true
        strip_server_name_from_file "${file}" "${domain}"
      fi
    done
  fi
}

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
  local ssl_extra=""
  if [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
    ssl_extra="${ssl_extra}
    include /etc/letsencrypt/options-ssl-nginx.conf;"
  fi
  if [[ -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    ssl_extra="${ssl_extra}
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
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
    ssl_certificate_key ${CERT_DIR}/privkey.pem;${ssl_extra}

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

purge_conflicting_server_names "${DOMAIN}" "${APP_NAME}.conf"

write_http_only
ln -sfn "${CONF_AVAILABLE}" "${CONF_ENABLED}"
# Re-purge in case certbot / another process recreated a duplicate.
purge_conflicting_server_names "${DOMAIN}" "${APP_NAME}.conf"
nginx -t
systemctl reload nginx

if [[ ! -f "${CERT_DIR}/fullchain.pem" ]]; then
  certbot certonly --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" || true
fi

if [[ -f "${CERT_DIR}/fullchain.pem" ]]; then
  write_http_redirect_and_https
  ln -sfn "${CONF_AVAILABLE}" "${CONF_ENABLED}"
  purge_conflicting_server_names "${DOMAIN}" "${APP_NAME}.conf"
  nginx -t
  systemctl reload nginx
else
  echo "WARN: TLS cert missing for ${DOMAIN}; left HTTP-only proxy on :80"
fi

# Verify upstream container directly (not via nginx Host/redirect).
UPSTREAM_BODY=""
for attempt in $(seq 1 30); do
  UPSTREAM_BODY="$(curl -fsS -m 5 "http://127.0.0.1:${PROXY_PORT}/" 2>/dev/null || true)"
  if [[ "${APP_NAME}" == "hrms-be" ]]; then
    if echo "${UPSTREAM_BODY}" | grep -q 'APTO Hono API'; then
      break
    fi
  elif [[ -n "${UPSTREAM_BODY}" ]]; then
    break
  fi
  echo "Waiting for upstream :${PROXY_PORT} (attempt ${attempt}/30)..."
  sleep 2
done

if [[ -z "${UPSTREAM_BODY}" ]]; then
  echo "ERROR: upstream 127.0.0.1:${PROXY_PORT} is not responding"
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
  docker logs --tail 80 hrms-be-prod 2>/dev/null || true
  exit 1
fi
echo "OK: upstream :${PROXY_PORT} reachable for ${DOMAIN}"

if [[ "${APP_NAME}" == "hrms-be" ]]; then
  if echo "${UPSTREAM_BODY}" | grep -qiE '<html|hrms-ui|<!doctype'; then
    echo "ERROR: upstream :${PROXY_PORT} returned frontend HTML"
    echo "${UPSTREAM_BODY}" | head -c 200
    exit 1
  fi
  if ! echo "${UPSTREAM_BODY}" | grep -q 'APTO Hono API'; then
    echo "ERROR: upstream :${PROXY_PORT} did not return API ok payload"
    echo "${UPSTREAM_BODY}" | head -c 200
    exit 1
  fi

  verify_local_nginx_api() {
    local body=""
    if [[ -f "${CERT_DIR}/fullchain.pem" ]]; then
      body="$(curl -fsSk -m 15 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/" 2>/dev/null || true)"
    else
      body="$(curl -fsS -m 15 --resolve "${DOMAIN}:80:127.0.0.1" "http://${DOMAIN}/" 2>/dev/null || true)"
    fi
    echo "${body}"
  }

  LOCAL_PUB="$(verify_local_nginx_api)"
  echo "local-nginx body: ${LOCAL_PUB:0:200}"

  # One repair pass if another vhost (e.g. MF-FE.conf) still steals this Host.
  if echo "${LOCAL_PUB}" | grep -qiE '<html|hrms-ui|<!doctype' \
    || ! echo "${LOCAL_PUB}" | grep -q 'APTO Hono API'; then
    echo "WARN: local nginx not serving API yet — forcing conflict purge + reload"
    purge_conflicting_server_names "${DOMAIN}" "${APP_NAME}.conf"
    if [[ -f "${CERT_DIR}/fullchain.pem" ]]; then
      write_http_redirect_and_https
    else
      write_http_only
    fi
    ln -sfn "${CONF_AVAILABLE}" "${CONF_ENABLED}"
    nginx -t
    systemctl reload nginx
    sleep 1
    LOCAL_PUB="$(verify_local_nginx_api)"
    echo "local-nginx body (after repair): ${LOCAL_PUB:0:200}"
  fi

  if echo "${LOCAL_PUB}" | grep -qiE '<html|hrms-ui|<!doctype'; then
    echo "ERROR: local nginx still serving frontend HTML for ${DOMAIN}"
    echo "---- nginx sites claiming ${DOMAIN} ----"
    grep -RIn "server_name.*${DOMAIN}" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true
    ls -la /etc/nginx/sites-enabled/ || true
    exit 1
  fi
  if ! echo "${LOCAL_PUB}" | grep -q 'APTO Hono API'; then
    echo "ERROR: local nginx did not return API ok payload for ${DOMAIN}"
    grep -RIn "server_name.*${DOMAIN}" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true
    exit 1
  fi
  echo "OK: local nginx serves API for ${DOMAIN}"
fi

echo "OK: nginx site applied for ${DOMAIN} -> 127.0.0.1:${PROXY_PORT}"
