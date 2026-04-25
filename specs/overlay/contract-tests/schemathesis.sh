#!/usr/bin/env bash
# Schemathesis contract test for overlay-http
# Usage: BASE_URL=https://your-server.example.com bash schemathesis.sh
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
schemathesis run \
  ../../overlay-http.yaml \
  --base-url "$BASE_URL" \
  --checks all \
  --stateful=links \
  --junit-xml results.xml
