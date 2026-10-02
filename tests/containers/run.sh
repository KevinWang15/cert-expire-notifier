#!/usr/bin/env bash
set -euo pipefail

TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_COMPOSE=(docker compose -f "$TASK_DIR/compose.yaml")
mkdir -p "$TASK_DIR/artifacts"

"${TASK_COMPOSE[@]}" stop cron-worker >/dev/null 2>&1 || true
trap '"${TASK_COMPOSE[@]}" stop cron-worker >/dev/null 2>&1 || true' EXIT
"${TASK_COMPOSE[@]}" build app
"${TASK_COMPOSE[@]}" up --detach --wait --wait-timeout 180 app email webhook certificate gateway
"${TASK_COMPOSE[@]}" run --rm --no-deps test
"${TASK_COMPOSE[@]}" up --detach --no-build --wait --wait-timeout 120 cron-worker
"${TASK_COMPOSE[@]}" run --rm --no-deps test node /fixtures/run.mjs --cron
"${TASK_COMPOSE[@]}" stop cron-worker
"${TASK_COMPOSE[@]}" restart app
"${TASK_COMPOSE[@]}" up --detach --no-deps --wait --wait-timeout 120 app
"${TASK_COMPOSE[@]}" run --rm --no-deps test node /fixtures/run.mjs --persistence

printf '\nContainer test stack is still running for inspection.\n'
printf 'App: http://localhost:%s\n' "${CONTAINER_TEST_APP_PORT:-23800}"
printf 'Webhook requests: http://localhost:%s/__admin/requests\n' "${CONTAINER_TEST_WEBHOOK_PORT:-23801}"
printf 'Email requests: http://localhost:%s/__admin/requests\n' "${CONTAINER_TEST_EMAIL_PORT:-23802}"
printf 'Certificate mock requests: http://localhost:%s/__admin/requests\n' "${CONTAINER_TEST_WEBSITE_PORT:-23803}"
printf 'Report and demo login: %s/artifacts/report.json\n' "$TASK_DIR"
printf 'Stop: docker compose -f tests/containers/compose.yaml --profile cron down\n'
