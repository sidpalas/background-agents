#!/usr/bin/env bash
set -euo pipefail

DATABASE_NAME="${1:-open-inspect-test}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${2:-$SCRIPT_DIR/../terraform/d1/migrations}"
CONFIG_PATH="$SCRIPT_DIR/../packages/control-plane/wrangler.jsonc"

WRANGLER="npx wrangler"

$WRANGLER d1 execute "$DATABASE_NAME" --local --config "$CONFIG_PATH" \
  --command "CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )"

APPLIED=$($WRANGLER d1 execute "$DATABASE_NAME" --local --config "$CONFIG_PATH" \
  --command "SELECT version FROM _schema_migrations ORDER BY version" \
  --json | jq -r '.[0].results[].version // empty' 2>/dev/null || true)

COUNT=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  FILENAME=$(basename "$file")
  VERSION=$(printf "%s" "$FILENAME" | grep -oE '^[0-9]+')

  if printf "%s\n" "$APPLIED" | grep -qxF "$VERSION"; then
    printf "Skip (already applied): %s\n" "$FILENAME"
    continue
  fi

  printf "Applying: %s\n" "$FILENAME"
  $WRANGLER d1 execute "$DATABASE_NAME" --local --config "$CONFIG_PATH" --file "$file"

  SAFE_FILENAME=$(printf "%s" "$FILENAME" | sed "s/'/''/g")
  $WRANGLER d1 execute "$DATABASE_NAME" --local --config "$CONFIG_PATH" \
    --command "INSERT INTO _schema_migrations (version, name) VALUES ('$VERSION', '$SAFE_FILENAME')"

  COUNT=$((COUNT + 1))
done

printf "Done. Applied %d migration(s).\n" "$COUNT"
