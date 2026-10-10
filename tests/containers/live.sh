#!/usr/bin/env bash
set -euo pipefail

: "${LIVE_CERT_DOMAIN:?Set LIVE_CERT_DOMAIN to a multi-IP hostname to test}"

TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_COMPOSE=(docker compose -f "$TASK_DIR/compose.yaml" -f "$TASK_DIR/compose.live.yaml")

# Run the isolated suite first to build the app and start its database and mocks.
"${TASK_COMPOSE[@]}" up --detach --no-deps --wait --wait-timeout 120 app
"${TASK_COMPOSE[@]}" run --rm --no-deps live-certificates
"${TASK_COMPOSE[@]}" restart app
"${TASK_COMPOSE[@]}" up --detach --no-deps --wait --wait-timeout 120 app
"${TASK_COMPOSE[@]}" run --rm --no-deps live-certificates --persistence
"${TASK_COMPOSE[@]}" run --rm --no-deps --entrypoint node browser /fixtures/live-certificates-browser.cjs
