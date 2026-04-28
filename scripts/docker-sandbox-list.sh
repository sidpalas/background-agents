#!/usr/bin/env bash
set -euo pipefail

FRAMEWORK_LABEL="openinspect_framework=open-inspect"
SANDBOX_KIND_LABEL="openinspect_kind=sandbox"
LOCAL_ENV_LABEL="openinspect_env=local"

docker ps -a \
  --filter "label=${FRAMEWORK_LABEL}" \
  --filter "label=${SANDBOX_KIND_LABEL}" \
  --filter "label=${LOCAL_ENV_LABEL}" \
  --format 'table {{.ID}}\t{{.Status}}\t{{.Label "openinspect_session_id"}}\t{{.Label "openinspect_repo"}}\t{{.Label "openinspect_expires_at"}}\t{{.Names}}'
