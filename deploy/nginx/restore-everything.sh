#!/usr/bin/env bash
# Restore nginx sites that were removed/archived during hrms-be conflict purge.
# Run on VPS as root. Safe: only restores backups; then re-asserts FE + API cleanly.
set -euo pipefail

echo "========== 1) What is enabled now =========="
ls -la /etc/nginx/sites-enabled/ || true

echo
echo "========== 2) Find backups from purge =========="
ls -la /etc/nginx/sites-available/*.bak-conflict-* /etc/nginx/sites-available/*.bak-strip-* \
  /etc/nginx/sites-enabled/*.bak-strip-* 2>/dev/null || echo "(no bak files found in usual paths)"

echo
echo "========== 3) Restore latest MF-FE / hrms-fe backups if present =========="
restore_latest() {
  local base="$1"   # e.g. MF-FE.conf or hrms-fe.conf
  local latest
  latest="$(ls -1t /etc/nginx/sites-available/${base}.bak-conflict-* \
                   /etc/nginx/sites-available/${base}.bak-strip-* 2>/dev/null | head -1 || true)"
  if [[ -z "${latest}" ]]; then
    echo "No backup for ${base}"
    return 0
  fi
  echo "Restoring ${base} from ${latest}"
  cp -a "${latest}" "/etc/nginx/sites-available/${base}"
  # Enable only if not already a symlink/file in sites-enabled
  if [[ ! -e "/etc/nginx/sites-enabled/${base}" ]]; then
    ln -sfn "/etc/nginx/sites-available/${base}" "/etc/nginx/sites-enabled/${base}"
  fi
}

restore_latest "MF-FE.conf"
restore_latest "MF-FF.conf"
restore_latest "hrms-fe.conf"

echo
echo "========== 4) CRITICAL: remove API hostname from FE configs (keep FE domain) =========="
# Do NOT leave hrms-be.devcognito.tech on FE/MF-FE — that was the original bug.
for f in /etc/nginx/sites-available/MF-FE.conf \
         /etc/nginx/sites-available/MF-FF.conf \
         /etc/nginx/sites-available/hrms-fe.conf \
         /etc/nginx/sites-enabled/MF-FE.conf \
         /etc/nginx/sites-enabled/MF-FF.conf \
         /etc/nginx/sites-enabled/hrms-fe.conf; do
  [[ -f "$f" ]] || continue
  # Fix empty server_name left by broken conflict-strip sed (nginx -t fails otherwise).
  sed -E -i \
    -e 's/^([[:space:]]*)server_name[[:space:]]*;/\1# server_name removed (invalid empty);/g' \
    -e 's/^([[:space:]]*)server_name[[:space:]]+"[[:space:]]*";/\1# server_name removed (invalid empty);/g' \
    "$f" || true
  if grep -Eiq 'server_name[^;]*hrms-be\.devcognito\.tech' "$f"; then
    echo "Stripping hrms-be.devcognito.tech from $f (keeps other server_names)"
    cp -a "$f" "${f}.pre-fix-$(date +%s)"
    sed -E -i \
      -e 's/[[:space:]]hrms-be\.devcognito\.tech//g' \
      -e 's/hrms-be\.devcognito\.tech[[:space:]]+//g' \
      -e 's/"hrms-be\.devcognito\.tech"//g' \
      "$f"
  else
    echo "OK: $f does not claim API domain"
  fi
done

echo
echo "========== 5) Re-apply official FE + API sites (correct certs) =========="
if [[ -x /home/source/prod/hrms-fe/deploy/nginx/apply-site.sh ]]; then
  sed -i 's/\r$//' /home/source/prod/hrms-fe/deploy/nginx/apply-site.sh
  /home/source/prod/hrms-fe/deploy/nginx/apply-site.sh hrms-fe hrms.devcognito.tech 8082
fi

# Prefer FIXED apply-site from git if you copied it; otherwise skip BE apply if still old/deleting.
if [[ -x /home/source/prod/hrms-be/deploy/nginx/apply-site.sh ]]; then
  if grep -q 'is_protected_vhost' /home/source/prod/hrms-be/deploy/nginx/apply-site.sh 2>/dev/null; then
    sed -i 's/\r$//' /home/source/prod/hrms-be/deploy/nginx/apply-site.sh
    /home/source/prod/hrms-be/deploy/nginx/apply-site.sh hrms-be hrms-be.devcognito.tech 3202
  else
    echo "SKIP BE apply-site: server still has OLD script that deletes FE."
    echo "Only ensure hrms-be.conf exists:"
    ls -la /etc/nginx/sites-enabled/hrms-be.conf || true
  fi
fi

sed -i 's/\r$//' /etc/nginx/sites-available/hrms-fe.conf /etc/nginx/sites-available/hrms-be.conf 2>/dev/null || true
nginx -t
systemctl reload nginx

echo
echo "========== 6) Verify (manager-safe state) =========="
ls -la /etc/nginx/sites-enabled/
echo "--- FE cert (must be hrms.devcognito.tech) ---"
echo | openssl s_client -servername hrms.devcognito.tech -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -subject
echo "--- API cert (must be hrms-be.devcognito.tech) ---"
echo | openssl s_client -servername hrms-be.devcognito.tech -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -subject
echo "--- API body ---"
curl -fsSk --resolve hrms-be.devcognito.tech:443:127.0.0.1 https://hrms-be.devcognito.tech/ | head -c 100
echo
echo "DONE. Browser: hard refresh https://hrms.devcognito.tech"
