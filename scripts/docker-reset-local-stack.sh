#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REMOVE_IMAGES=false

if [[ "${1:-}" == "--images" ]]; then
  REMOVE_IMAGES=true
fi

echo "Stopping Compose stack and removing service state..."
docker compose -f "$ROOT_DIR/docker-compose.yml" down -v --remove-orphans

echo "Removing local Wrangler state..."
rm -rf "$ROOT_DIR/packages/control-plane/.wrangler/state"

echo "Removing local sandbox containers..."
if $REMOVE_IMAGES; then
  bash "$ROOT_DIR/scripts/docker-clean-local-sandboxes.sh" --images
else
  bash "$ROOT_DIR/scripts/docker-clean-local-sandboxes.sh"
fi

echo "Local stack reset complete."
echo "Start fresh with: docker compose up --build"
