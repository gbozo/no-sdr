#!/bin/sh
# Portable launcher for the Rust backend (Linux/macOS).
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CONFIG_PATH="${CONFIG_PATH:-$DIR/config/config.yaml}"
export STATIC_DIR="${STATIC_DIR:-$DIR/static}"
exec "$DIR/serverrs" "$@"
