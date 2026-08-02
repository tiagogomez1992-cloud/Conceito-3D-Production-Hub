#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_DIR="/srv/containers/backups"
STAMP="$(date +%F-%H%M%S)"
PROJECT="conceito3d-production-hub"
APP_DIR="/srv/containers/apps/conceito3d-production-hub"
mkdir -p "$BACKUP_DIR"

docker compose -f "$APP_DIR/compose.yml" exec -T database sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$BACKUP_DIR/${PROJECT}-database-${STAMP}.sql"

# The legacy volumes stay backed up while the portal data is migrated.
for volume in "${PROJECT}_production-hub-data" "${PROJECT}_farm-data" "${PROJECT}_farm-gcode" "${PROJECT}_spoolman-data" "${PROJECT}_hub-data"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker run --rm -v "$volume:/source:ro" -v "$BACKUP_DIR:/backup" alpine:3.20 \
      tar -czf "/backup/${volume}-${STAMP}.tar.gz" -C /source .
  fi
done

find "$BACKUP_DIR" -type f \( -name '*.tar.gz' -o -name '*.sql' \) -mtime +14 -delete
echo "[$(date -Is)] Backup concluído: $STAMP"
