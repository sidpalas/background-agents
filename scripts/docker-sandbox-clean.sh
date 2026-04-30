#!/usr/bin/env bash
set -euo pipefail

FRAMEWORK_LABEL="openinspect_framework=open-inspect"
SANDBOX_KIND_LABEL="openinspect_kind=sandbox"
IMAGE_KIND_LABEL="openinspect_kind=sandbox-image"
LOCAL_ENV_LABEL="openinspect_env=local"

REMOVE_ALL=false
REMOVE_EXPIRED=true
REMOVE_STOPPED=true
REMOVE_IMAGES=false

usage() {
  cat <<'EOF'
Usage: npm run docker:sandboxes:clean -- [options]

Removes local Open Inspect Docker sandbox containers by label.

Default behavior removes stopped containers and expired running containers.

Options:
  --all       Remove all local sandbox containers, including running ones
  --expired   Remove only expired containers
  --stopped   Remove only stopped containers
  --images    Also remove local sandbox images
  --help      Show this help
EOF
}

if [[ $# -gt 0 ]]; then
  REMOVE_EXPIRED=false
  REMOVE_STOPPED=false
fi

for arg in "$@"; do
  case "$arg" in
    --all)
      REMOVE_ALL=true
      ;;
    --expired)
      REMOVE_EXPIRED=true
      ;;
    --stopped)
      REMOVE_STOPPED=true
      ;;
    --images)
      REMOVE_IMAGES=true
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf "Unknown option: %s\n\n" "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

read_container_ids() {
  docker ps -aq \
    --filter "label=${FRAMEWORK_LABEL}" \
    --filter "label=${SANDBOX_KIND_LABEL}" \
    --filter "label=${LOCAL_ENV_LABEL}"
}

is_stopped() {
  local container_id="$1"
  local running
  running=$(docker inspect --format '{{.State.Running}}' "$container_id")
  [[ "$running" != "true" ]]
}

is_expired() {
  local container_id="$1"
  local expires_at
  local now_ms

  expires_at=$(docker inspect --format '{{ index .Config.Labels "openinspect_expires_at" }}' "$container_id")
  [[ "$expires_at" =~ ^[0-9]+$ ]] || return 1

  now_ms=$(($(date +%s) * 1000))
  [[ "$expires_at" -le "$now_ms" ]]
}

should_remove_container() {
  local container_id="$1"

  if $REMOVE_ALL; then
    return 0
  fi

  if $REMOVE_STOPPED && is_stopped "$container_id"; then
    return 0
  fi

  if $REMOVE_EXPIRED && is_expired "$container_id"; then
    return 0
  fi

  return 1
}

remove_containers() {
  local container_ids=()
  local selected_ids=()
  local container_id

  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] && container_ids+=("$container_id")
  done < <(read_container_ids)

  if [[ ${#container_ids[@]} -eq 0 ]]; then
    echo "No local sandbox containers found."
    return
  fi

  for container_id in "${container_ids[@]}"; do
    if should_remove_container "$container_id"; then
      selected_ids+=("$container_id")
    fi
  done

  if [[ ${#selected_ids[@]} -eq 0 ]]; then
    echo "No matching local sandbox containers to remove."
    return
  fi

  echo "Removing ${#selected_ids[@]} local sandbox container(s)..."
  docker rm -f "${selected_ids[@]}"
}

remove_images() {
  local image_ids=()
  local image_id

  while IFS= read -r image_id; do
    [[ -n "$image_id" ]] && image_ids+=("$image_id")
  done < <(
    docker images -q \
      --filter "label=${FRAMEWORK_LABEL}" \
      --filter "label=${IMAGE_KIND_LABEL}" \
      --filter "label=${LOCAL_ENV_LABEL}"
  )

  if [[ ${#image_ids[@]} -eq 0 ]]; then
    echo "No local sandbox images found."
    return
  fi

  echo "Removing ${#image_ids[@]} local sandbox image(s)..."
  docker rmi -f "${image_ids[@]}"
}

remove_containers

if $REMOVE_IMAGES; then
  remove_images
else
  echo "Skipping image cleanup. Re-run with --images to remove local sandbox images too."
fi
