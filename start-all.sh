#!/bin/bash
# Start the full K.O.V.E. local stack: Python analysis engine, OmniRoute, and web.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${KOVE_LOG_DIR:-$ROOT/logs/dev}"
PYTHON_ENGINE_DIR="$ROOT/packages/python-engine"
WEB_PORT="${KOVE_WEB_PORT:-5391}"
ENGINE_PORT="${KOVE_ENGINE_PORT:-8000}"
OMNI_PORT="${KOVE_OMNI_PORT:-20128}"

mkdir -p "$LOG_DIR"

say() { printf '%s\n' "$*"; }

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

wait_for_url() {
  local url="$1" label="$2"
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null -m 2 "$url" 2>/dev/null; then
      say "  $label ready"
      return 0
    fi
    sleep 1
  done
  say "  $label did not become ready; see $LOG_DIR"
  return 1
}

start_engine() {
  if port_in_use "$ENGINE_PORT"; then
    say "Python analysis engine already running on :$ENGINE_PORT"
    return 0
  fi
  local uvicorn="$PYTHON_ENGINE_DIR/.venv/bin/uvicorn"
  if [ ! -x "$uvicorn" ]; then
    say "Missing $uvicorn - create packages/python-engine/.venv first."
    return 1
  fi
  say "Starting Python analysis engine on :$ENGINE_PORT"
  (
    cd "$PYTHON_ENGINE_DIR" || exit 1
    nohup env PYTHONPATH=src "$uvicorn" server:app --host 127.0.0.1 --port "$ENGINE_PORT" \
      >>"$LOG_DIR/python-engine.log" 2>&1 </dev/null &
    echo $! >"$LOG_DIR/python-engine.pid"
  )
  wait_for_url "http://127.0.0.1:$ENGINE_PORT/health" "Python analysis engine"
}

start_omni() {
  if port_in_use "$OMNI_PORT"; then
    say "OmniRoute already running on :$OMNI_PORT"
    return 0
  fi
  if ! command -v omniroute >/dev/null 2>&1; then
    say "omniroute not found on PATH; skipping (AI features will fall back)"
    return 1
  fi
  say "Starting OmniRoute on :$OMNI_PORT"
  omniroute serve --daemon --no-open >>"$LOG_DIR/omniroute.log" 2>&1
  wait_for_url "http://localhost:$OMNI_PORT/" "OmniRoute"
}

start_web() {
  if port_in_use "$WEB_PORT"; then
    say "Web dev server already running on :$WEB_PORT"
    return 0
  fi
  if [ ! -d "$ROOT/node_modules" ]; then
    say "Installing dependencies"
    (cd "$ROOT" && pnpm install)
  fi
  if [ ! -f "$ROOT/packages/core/src/wasm/fft/build/fft.wasm" ]; then
    say "Building WASM modules"
    (cd "$ROOT" && pnpm build:wasm)
  fi
  say "Starting web dev server on :$WEB_PORT"
  (
    cd "$ROOT" || exit 1
    nohup pnpm dev >>"$LOG_DIR/web.log" 2>&1 </dev/null &
    echo $! >"$LOG_DIR/web.pid"
  )
  wait_for_url "http://localhost:$WEB_PORT/" "Web dev server"
}

say "K.O.V.E. local stack"
say "Logs: $LOG_DIR"
start_engine
start_omni
start_web
say ""
say "Web:    http://localhost:$WEB_PORT"
say "Engine: http://127.0.0.1:$ENGINE_PORT/health"
say "Omni:   http://localhost:$OMNI_PORT"
