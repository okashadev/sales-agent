#!/usr/bin/env bash
# Restores the newest backup into a throwaway container and re-runs the DB tests on the copy.
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-$HOME/sales-backups}"
PASS_FILE="${PASS_FILE:-$HOME/.config/sales-backup/passphrase}"
latest=$(ls -1t "$BACKUP_DIR"/sales-*.sql.gpg | head -1)
echo "restoring: $latest"
name=sales-restore-test
docker rm -f "$name" >/dev/null 2>&1 || true
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --memory 256m -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" postgres:17-alpine >/dev/null
# -h 127.0.0.1: the init-time server listens on the socket only, the real one on TCP.
for _ in $(seq 1 40); do docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASS_FILE" -d "$latest" | gunzip \
  | docker exec -i "$name" psql -U postgres -q 2>&1 | grep -E 'ERROR|FATAL' || echo "restore: no errors"
q() { docker exec "$name" psql -U postgres -d sales -tA -c "$1"; }
echo "tables:    $(q "select count(*) from information_schema.tables where table_schema='public'")"
echo "triggers:  $(q "select count(*) from pg_trigger where not tgisinternal")"
echo "roles:     $(q "select string_agg(rolname, ',' order by rolname) from pg_roles where rolname like 'sales_%'")"
echo "audit_log: $(q "select count(*) from audit_log")"
pass=0; fail=0
for t in db/tests/*.sql; do
  out=$(docker exec -i "$name" psql -U postgres -d sales -v ON_ERROR_STOP=1 < "$t" 2>&1) || { echo "suite failed: $t"; echo "$out" | tail -3; }
  pass=$((pass + $(grep -c 'PASS' <<<"$out" || true)))
  fail=$((fail + $(grep -c 'FAIL' <<<"$out" || true)))
done
echo "DB tests on the restored copy: PASS=$pass FAIL=$fail (expect 22 / 0)"