#!/bin/bash
# Apply full HRMS schema on production Postgres (idempotent — skips existing objects).
# Run on VPS as root:
#   bash deploy/apply-prod-schema.sh

set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-ats-postgres}"
DB_USER="${DB_USER:-admin}"
DB_NAME="${DB_NAME:-ats_db}"
SQL_FILE="${SQL_FILE:-drizzle/0000_init_postgres.sql}"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "Postgres container '$DB_CONTAINER' not running."
  exit 1
fi

if [ ! -f "$SQL_FILE" ]; then
  echo "SQL file not found: $SQL_FILE"
  exit 1
fi

echo "Applying HRMS schema to $DB_NAME (errors on existing objects are OK)..."
docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=0 -U "$DB_USER" -d "$DB_NAME" < "$SQL_FILE"
echo "Done. Verify with: docker exec $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c '\\dt'"
