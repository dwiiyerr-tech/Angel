#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Do not `source .env`: dotenv values are data, not shell commands. In
# particular, model names may contain spaces and caused "command not found".
# The ML service only needs these two optional settings.
read_dotenv_value() {
  local key="$1"
  local line
  line="$(sed -n "s/^${key}=//p" .env 2>/dev/null | tail -n 1)"
  line="${line%$'\r'}"
  if [[ "$line" == \"*\" && "$line" == *\" ]]; then
    line="${line:1:${#line}-2}"
  elif [[ "$line" == \'*\' && "$line" == *\' ]]; then
    line="${line:1:${#line}-2}"
  fi
  printf '%s' "$line"
}

ML_PORT="${ML_SERVICE_PORT:-$(read_dotenv_value ML_SERVICE_PORT)}"
ML_HOST="${ML_SERVICE_HOST:-$(read_dotenv_value ML_SERVICE_HOST)}"
PORT="${ML_PORT:-8001}"
HOST="${ML_HOST:-127.0.0.1}"
echo "Starting ML Service on port $PORT"
exec python3 -m uvicorn src.ml_service.server:app --host "$HOST" --port "$PORT" --workers 2
