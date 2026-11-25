#!/usr/bin/env bash
set -euo pipefail

case "$UI_PROJECT:$CARS_TARGET" in
  uhrp-ui:1|wui:1) ;;
  *) echo "Unsupported CARS project and target" >&2; exit 1 ;;
esac

if [[ ! "$CARS_ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Invalid staged CARS archive digest" >&2
  exit 1
fi
project="$PWD/packages/ui/$UI_PROJECT"
jq -e '
  .frontend.language == "react" and
  .frontend.sourceDirectory == "./frontend" and
  .configs[1].deploy == ["frontend"] and
  (.configs[1].projectID | type == "string" and length > 0) and
  (.configs[1].CARSCloudURL | type == "string" and startswith("https://"))
' "$project/deployment-info.json" > /dev/null

archive_name=cars_artifact_1.tgz
archive="$RUNNER_TEMP/cars-candidate/$archive_name"
if [[ ! -f "$archive" || -L "$archive" ]]; then
  echo "Expected a regular staged CARS archive" >&2
  exit 1
fi
release_dir="$(mktemp -d "$RUNNER_TEMP/cars-release.XXXXXX")"
trap 'rm -rf -- "$release_dir"' EXIT
cp "$archive" "$release_dir/$archive_name"
cp "$project/deployment-info.json" "$release_dir/"
cd "$release_dir"
printf '%s  %s\n' "$CARS_ARCHIVE_SHA256" "$archive_name" | sha256sum --check --strict

: "${CARS_PRIVATE_KEY:?Configure the selected CARS release environment secret}"
"$project/node_modules/.bin/cars" release now "$CARS_TARGET" --key "$CARS_PRIVATE_KEY" |
  tee cars-release.log
grep -Eq '^CARS_RELEASE_SUCCESS deploymentId=[^[:space:]]+$' cars-release.log
