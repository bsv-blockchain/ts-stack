#!/usr/bin/env bash
set -euo pipefail

image="${1:?Provide the built frontend image}"
[[ "$image" =~ ^[a-z0-9][a-zA-Z0-9_.:/@-]*$ ]]
container=$(docker run --detach --pull never --platform linux/amd64 --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=16m --publish 127.0.0.1::8080 \
  --health-interval 1s "$image")
cleanup() {
  docker logs "$container" >&2
  docker rm -f "$container" >/dev/null
}
trap cleanup EXIT

health() {
  docker inspect --format '{{.State.Health.Status}}' "$container"
}
for ((attempt = 0; attempt < 40; attempt++)); do
  if [[ "$(health)" == healthy ]]; then break; fi
  sleep 0.25
done
[[ "$(health)" == healthy ]]
[[ "$(docker exec "$container" id -u)" != 0 ]]
node scripts/check-ui-image.mjs "$(docker port "$container" 8080/tcp)"
