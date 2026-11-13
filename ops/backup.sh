#!/usr/bin/env bash
# Encrypted full-cluster dump (roles + data). Output stays outside the repo.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-$HOME/sales-backups}"
PASS_FILE="${PASS_FILE:-$HOME/.config/sales-backup/passphrase}"
KEEP="${KEEP:-14}"
umask 077
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/sales-$(date +%Y%m%d-%H%M%S).sql.gpg"
docker exec sales-postgres pg_dumpall -U sales_admin \
  | gzip -9 \
  | gpg --batch --yes --quiet --pinentry-mode loopback --symmetric --cipher-algo AES256 \
        --passphrase-file "$PASS_FILE" -o "$out.partial"
mv "$out.partial" "$out"
tables=$(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASS_FILE" -d "$out" | gunzip | grep -c '^CREATE TABLE')
[ "$tables" -ge 9 ] || { echo "backup looks incomplete ($tables tables)"; exit 1; }
ls -1t "$BACKUP_DIR"/sales-*.sql.gpg | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "backup ok: $out ($(du -h "$out" | cut -f1), $tables tables)"