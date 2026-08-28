#!/usr/bin/env bash
# Atualiza apenas o Conceito 3D Production Hub a partir da branch main.
# O Production Hub é atualizado como serviço autónomo; serviços antigos não são
# iniciados, alterados ou removidos por este processo.
set -Eeuo pipefail

APP_DIR="/srv/containers/apps/conceito3d-production-hub"
BACKUP_DIR="/srv/containers/backups"
BRANCH="main"
STAMP="$(date +%F-%H%M%S)"

log() { echo "[$(date -Is)] $*"; }
rollback() {
  log "Falha na atualização; a repor a revisão anterior ${LOCAL_REV}."
  git -C "$APP_DIR" reset --hard "$LOCAL_REV"
  docker compose -f "$APP_DIR/compose.yml" up -d --build hub
}

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

git fetch --quiet origin "$BRANCH"
LOCAL_REV="$(git rev-parse HEAD)"
REMOTE_REV="$(git rev-parse "origin/$BRANCH")"

if [[ "$LOCAL_REV" == "$REMOTE_REV" ]]; then
  log "Sem atualização disponível."
  exit 0
fi

log "Nova revisão encontrada: ${REMOTE_REV}."
tar --exclude=.git -czf "$BACKUP_DIR/conceito3d-hub-before-update-$STAMP.tar.gz" .

git reset --hard "$REMOTE_REV"
if ! docker compose -f "$APP_DIR/compose.yml" up -d --build hub; then
  rollback
  exit 1
fi

sleep 5
if ! docker compose -f "$APP_DIR/compose.yml" ps --status running --services | grep -qx hub; then
  rollback
  exit 1
fi

log "Atualização concluída: ${LOCAL_REV} -> ${REMOTE_REV}."
