#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(dirname "$0")
CONTROL_PLANE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
MIGRATIONS_DIR="$CONTROL_PLANE_DIR/../../terraform/d1/migrations"
PERSIST_DIR="$CONTROL_PLANE_DIR/.wrangler/state"
MARKER_FILE="$PERSIST_DIR/.local-d1-applied-migrations"

mkdir -p "$PERSIST_DIR"

bootstrap_existing_state() {
  local output
  output=$(npx wrangler d1 execute DB \
    --local \
    --persist-to "$PERSIST_DIR" \
    --config "$CONTROL_PLANE_DIR/wrangler.jsonc" \
    --command "PRAGMA table_info(sessions);" 2>/dev/null || true)

  if grep -Fq "reasoning_effort" <<<"$output"; then
    echo "Existing migrated local D1 schema detected; bootstrapping applied migration marker"
    for file in "$MIGRATIONS_DIR"/*.sql; do
      basename "$file"
    done > "$MARKER_FILE"
    return 0
  fi

  return 1
}

# Bootstrap old local state created before we tracked applied migrations.
# If persisted state already has migrated schema but no marker file does, mark
# the current migration set as applied and avoid replaying ALTER TABLEs.
if [[ ! -f "$MARKER_FILE" ]]; then
  bootstrap_existing_state || true
fi

touch "$MARKER_FILE"

for file in "$MIGRATIONS_DIR"/*.sql; do
  migration_name=$(basename "$file")
  if grep -Fxq "$migration_name" "$MARKER_FILE"; then
    echo "Skipping already applied D1 migration: $migration_name"
    continue
  fi

  echo "Applying D1 migration: $migration_name"
  npx wrangler d1 execute DB \
    --local \
    --persist-to "$PERSIST_DIR" \
    --config "$CONTROL_PLANE_DIR/wrangler.jsonc" \
    --file "$file"
  printf '%s\n' "$migration_name" >> "$MARKER_FILE"
done
