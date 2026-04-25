#!/usr/bin/env bash
# Schemathesis contract test for message-box-http
# Usage: BASE_URL=https://your-server.example.com bash schemathesis.sh
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
schemathesis run \
  ../../message-box-http.yaml \
  --base-url "$BASE_URL" \
  --checks all \
  --stateful=links \
  --junit-xml results.xml
