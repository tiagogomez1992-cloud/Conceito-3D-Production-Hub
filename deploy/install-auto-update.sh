#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Executa este instalador com sudo."
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 0755 "$SOURCE_DIR/c3d-hub-update.sh" /usr/local/sbin/c3d-hub-update
install -m 0644 "$SOURCE_DIR/conceito3d-hub-update.service" /etc/systemd/system/conceito3d-hub-update.service
install -m 0644 "$SOURCE_DIR/conceito3d-hub-update.timer" /etc/systemd/system/conceito3d-hub-update.timer
systemctl daemon-reload
systemctl enable --now conceito3d-hub-update.timer
echo "Atualização automática ativada. A primeira verificação será feita diariamente às 03:20 (com atraso aleatório até 15 minutos)."
