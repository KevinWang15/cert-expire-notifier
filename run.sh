#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if [ ! -f ".env" ] && [ -f ".env.sample" ]; then
  cp .env.sample .env
fi

npm run dev
