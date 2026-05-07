#!/usr/bin/env bash
set -euo pipefail

FRAMEWORK_LABEL="openinspect_framework=open-inspect"
SANDBOX_KIND_LABEL="openinspect_kind=sandbox"
IMAGE_KIND_LABEL="openinspect_kind=sandbox-image"
LOCAL_ENV_LABEL="openinspect_env=local"

remove_containers() {
  local container_ids=()
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then
      container_ids+=("$line")
    fi
  done < <(
    docker ps -aq \
      --filter "label=${FRAMEWORK_LABEL}" \
      --filter "label=${SANDBOX_KIND_LABEL}" \
      --filter "label=${LOCAL_ENV_LABEL}"
  )

  if [[ ${#container_ids[@]} -eq 0 ]]; then
    echo "No local sandbox containers found."
    return
  fi

  echo "Removing ${#container_ids[@]} local sandbox container(s)..."
  docker rm -f "${container_ids[@]}"
}

remove_images() {
  local image_ids=()
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then
      image_ids+=("$line")
    fi
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

if [[ "${1:-}" == "--images" ]]; then
  remove_images
else
  echo "Skipping image cleanup. Re-run with --images to remove local sandbox images too."
fi
