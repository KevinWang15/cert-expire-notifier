#!/usr/bin/env bash
set -euo pipefail

TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_COMPOSE=(docker compose -f "$TASK_DIR/compose.yaml" -f "$TASK_DIR/compose.scenario.yaml")
mkdir -p "$TASK_DIR/artifacts"

"${TASK_COMPOSE[@]}" stop cron-worker >/dev/null 2>&1 || true
"${TASK_COMPOSE[@]}" build app
"${TASK_COMPOSE[@]}" up --detach --wait --wait-timeout 180 app gateway
# Recreate the local certificate servers to reset the renewal scenario each run.
"${TASK_COMPOSE[@]}" up --detach --force-recreate --wait --wait-timeout 90 certificate-node-1 certificate-node-2 certificate-node-3
"${TASK_COMPOSE[@]}" run --rm --no-deps scenario
"${TASK_COMPOSE[@]}" run --rm --no-deps --entrypoint node browser /fixtures/scenario-browser.cjs
