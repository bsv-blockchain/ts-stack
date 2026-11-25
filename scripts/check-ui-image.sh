#!/usr/bin/env bash
set -euo pipefail

image="${1:?Provide the built frontend image}"
container=$(docker run -d --platform linux/amd64 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m \
  --publish 127.0.0.1::8080 "$image")
files=$(mktemp -d)
cleanup() {
  docker logs "$container" >&2
  docker rm -f "$container" >/dev/null
  rm -rf "$files"
}
trap cleanup EXIT

base="http://$(docker port "$container" 8080/tcp)"
for ((attempt = 0; attempt < 40; attempt++)); do
  if [[ "$(curl --silent --fail "$base/health" || true)" == ok ]]; then break; fi
  sleep 0.25
done
[[ "$(curl --silent --show-error --fail "$base/health")" == ok ]]
[[ "$(docker exec "$container" id -u)" != 0 ]]
curl --silent --show-error --fail --dump-header "$files/headers" "$base/" > "$files/index"
grep -qi '^Cache-Control: no-cache' "$files/headers"
curl --silent --show-error --fail "$base/browser-route/example" > "$files/deep-link"
cmp "$files/index" "$files/deep-link"
asset=$(sed -nE 's/.*src="(\/?assets\/[^"]+\.js)".*/\1/p' "$files/index" | head -n 1)
test -n "$asset"
curl --silent --show-error --fail --dump-header "$files/headers" "$base/${asset#/}" > "$files/asset"
grep -Eqi '^Content-Type: (application|text)/javascript' "$files/headers"
grep -qi '^Cache-Control: public, max-age=31536000, immutable' "$files/headers"
test -s "$files/asset"
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$base/assets/absent.js")" == 404 ]]
