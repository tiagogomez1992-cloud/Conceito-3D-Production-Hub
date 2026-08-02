#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_DIR="/srv/containers/backups"
STAMP="$(date +%F-%H%M%S)"
PROJECT="conceito3d-production-hub"
mkdir -p "$BACKUP_DIR"

for volume in "${PROJECT}_farm-data" "${PROJECT}_farm-gcode" "${PROJECT}_spoolman-data" "${PROJECT}_hub-data"; do
  docker volume inspect "$volume" >/dev/null
  docker run --rm -v "$volume:/source:ro" -v "$BACKUP_DIR:/backup" alpine:3.20 \
    tar -czf "/backup/${volume}-${STAMP}.tar.gz" -C /source .
done

find "$BACKUP_DIR" -type f -name '*.tar.gz' -mtime +14 -delete
echo "[$(date -Is)] Backup concluído: $STAMP"
