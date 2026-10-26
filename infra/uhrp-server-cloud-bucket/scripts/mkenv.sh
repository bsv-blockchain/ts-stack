#!/bin/bash
set -eu
umask 077

SCRIPT_DIRECTORY="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIRECTORY/mkenv.cjs" "$@"
