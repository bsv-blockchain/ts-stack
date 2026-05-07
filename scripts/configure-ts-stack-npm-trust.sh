#!/usr/bin/env bash
set -euo pipefail

REPO='bsv-blockchain/ts-stack'
FILE='release.yaml'
PKGS=(
  "@bsv/amountinator"
  "@bsv/wallet-helper"
  "@bsv/did-client"
  "@bsv/fund-wallet"
  "@bsv/simple"
  "@bsv/templates"
  "@bsv/authsocket-client"
  "@bsv/authsocket"
  "@bsv/message-box-client"
  "@bsv/paymail"
  "@bsv/402-pay"
  "@bsv/auth-express-middleware"
  "@bsv/payment-express-middleware"
  "@bsv/teranode-listener"
  "@bsv/gasp"
  "@bsv/overlay-discovery-services"
  "@bsv/overlay-express"
  "@bsv/overlay"
  "@bsv/overlay-topics"
  "@bsv/sdk"
  "@bsv/btms-permission-module"
  "@bsv/btms"
  "@bsv/wallet-relay"
  "@bsv/wallet-toolbox-client"
  "@bsv/wallet-toolbox-mobile"
  "@bsv/wallet-toolbox"
)

NPM_FETCH_ARGS=(
  --fetch-retries=0
  --fetch-timeout=5000
  --fetch-retry-mintimeout=1000
  --fetch-retry-maxtimeout=1000
  --fetch-retry-factor=1
)
DRY_RUN="${NPM_DRY_RUN:-0}"

package_exists() {
  local pkg="$1"
  if npm view "$pkg" version --json "${NPM_FETCH_ARGS[@]}" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

run_npm_capture() {
  local desc="$1"
  shift

  local out_file=/tmp/ts-stack-trust-out.txt
  local err_file=/tmp/ts-stack-trust-err.txt
  local otp="${NPM_OTP:-}"
  local otp_attempts=0
  local rate_limit_attempts=0

  while true; do
    if [ -z "$otp" ]; then
      read -r -s -p "Enter npm OTP for ${desc}: " otp
      echo
    fi

    rm -f "$out_file" "$err_file"
    npm "$@" "${NPM_FETCH_ARGS[@]}" --otp="$otp" >"$out_file" 2>"$err_file"
    local status=$?

    if [ $status -eq 0 ]; then
      if [ -s "$out_file" ]; then
        cat "$out_file"
      fi
      rm -f "$out_file"
      return 0
    fi

    if [ -f "$err_file" ] && rg -q 'EOTP|This operation requires a one-time password|Please provide a one-time password' "$err_file"; then
      cat "$err_file"
      echo "OTP rejected/expired for ${desc}."
      if [ "${NPM_OTP:-}" != "" ]; then
        return 1
      fi
      otp=""
      otp_attempts=$((otp_attempts + 1))
      if [ "$otp_attempts" -ge 3 ]; then
        echo "Too many OTP retries for ${desc}."
        return 1
      fi
      otp=""
      continue
    fi

    if [ -f "$err_file" ] && rg -q 'E429|Too Many Requests' "$err_file"; then
      rate_limit_attempts=$((rate_limit_attempts + 1))
      if [ "$rate_limit_attempts" -ge 3 ]; then
        cat "$err_file"
        return 1
      fi
      sleep 3
      continue
    fi

    if [ -f "$err_file" ] && rg -q 'E409' "$err_file"; then
      if [[ "$desc" == *"trust github"* ]]; then
        if rg -q 'already exists|already exists in trusted list|existing trust|already granted' "$err_file" 2>/dev/null; then
          echo "Ignoring duplicate trust; treating as success"
          return 0
        fi
      fi
    fi

    if [ -s "$err_file" ]; then
      cat "$err_file"
    fi
    return 1
  done
}

trust_json_for() {
  local pkg="$1"
  local out

  if ! out="$(run_npm_capture "trust list for ${pkg}" trust list "$pkg" --json)"; then
    return 1
  fi

  if [ -z "$out" ] || [ "$out" = "null" ]; then
    echo "[]"
  else
    # Normalize single object into array for robust jq processing.
    echo "$out" | jq 'if type=="object" then [.] else . end'
  fi
}

for pkg in "${PKGS[@]}"; do
  echo "=== $pkg ==="
  rm -f /tmp/ts-stack-trust-err.txt

  if ! package_exists "$pkg"; then
    echo "SKIP: package does not yet exist in npm registry"
    echo
    continue
  fi

  if ! trust="$(trust_json_for "$pkg")"; then
    if [ -s /tmp/ts-stack-trust-err.txt ] && rg -q 'E404' /tmp/ts-stack-trust-err.txt 2>/dev/null; then
      echo "No trust entries found"
      trust='[]'
    else
      echo "WARN: trust list failed"
      [ -s /tmp/ts-stack-trust-err.txt ] && cat /tmp/ts-stack-trust-err.txt
      rm -f /tmp/ts-stack-trust-err.txt
      echo
      continue
    fi
  fi

  has_target=0
  ids_to_revoke=""
  if [ -n "${trust:-}" ] && [ "$trust" != "[]" ]; then
    has_target=$(echo "$trust" | jq -r --arg repo "$REPO" --arg file "$FILE" 'map(select(.repository == $repo and .file == $file and .type == "github")) | length')
    ids_to_revoke=$(echo "$trust" | jq -r '.[].id')
  else
    echo "No trust entries found (creating new one)"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    if [ "$has_target" -gt 0 ]; then
      echo "[dry-run] trust already present for ${pkg}; no changes"
    else
      if [ -n "$ids_to_revoke" ]; then
        echo "[dry-run] would revoke: ${ids_to_revoke//$'\n'/, }"
      fi
      echo "[dry-run] would add: trust github ${pkg} --repository ${REPO} --file ${FILE} --yes"
    fi
    rm -f /tmp/ts-stack-trust-err.txt
    echo
    continue
  fi

  if [ "$has_target" -gt 0 ]; then
    echo "Already has target trust; skipping"
    rm -f /tmp/ts-stack-trust-err.txt
    echo
    continue
  fi

  if [ -n "$ids_to_revoke" ]; then
    while IFS= read -r tid; do
      [ -z "$tid" ] && continue
      echo "Revoking existing trust id=$tid"
      if ! run_npm_capture "trust revoke for ${pkg}" trust revoke "$pkg" --id "$tid" >/dev/null; then
        echo "WARN: failed to revoke id=$tid"
      fi
    done <<< "$ids_to_revoke"
  fi

  echo "Applying target trust"
  if run_npm_capture "trust github for ${pkg}" trust github "$pkg" --repository "$REPO" --file "$FILE" --yes >/dev/null; then
    echo "OK"
  else
    echo "FAILED"
  fi

  rm -f /tmp/ts-stack-trust-err.txt
  echo
  sleep 1
done
