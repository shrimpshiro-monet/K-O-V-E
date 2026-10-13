#!/usr/bin/env bash
# K-O-V-E dev up — verify the toolchain, install what's missing, start the
# python engine (:8000) and the web app (:5173). Idempotent: anything already
# installed or already running is skipped, never duplicated.
#
#   ./dev.sh               verify + install + start engine and frontend
#   ./dev.sh --check       verify only; exit 1 on hard failures (CI-friendly)
#   ./dev.sh --engine      engine only
#   ./dev.sh --web         frontend only
#   ./dev.sh --asr         also install the ASR extra (faster-whisper) — the
#                          whisper model itself downloads on first transcribe
#   ./dev.sh --stop        stop what this script started
#
# Logs and pid files: .dev-run/ (gitignored).
#
# The classic stale-venv failure ("after git pull, pip install -e . or the
# engine breaks") is handled automatically: the engine's imports are probed
# every run and the package is reinstalled into the venv when they fail.
#
# After a pull, the whole ritual is one line:
#   git pull && ./dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ENGINE_DIR="packages/python-engine"
ENGINE_URL="http://localhost:${ENGINE_PORT:-8000}"
ENGINE_HEALTH="$ENGINE_URL/health"
WEB_PORT="${WEB_PORT:-5173}"
WEB_URL="http://localhost:${WEB_PORT}/"
RUN_DIR="$ROOT/.dev-run"
mkdir -p "$RUN_DIR"

# --- output helpers ---------------------------------------------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  G=$'\033[32m' R=$'\033[31m' Y=$'\033[33m' D=$'\033[2m' B=$'\033[1m' N=$'\033[0m'
else
  G="" R="" Y="" D="" B="" N=""
fi
say()  { printf '%s\n' "${B}==>${N} $*"; }
ok()   { printf '%s\n' "  ${G}✓${N} $*"; }
warn() { printf '%s\n' "  ${Y}!${N} $*"; }
bad()  { printf '%s\n' "  ${R}✗${N} $*"; }
die()  { bad "$*"; exit 1; }

version_gte() { [ "$(printf '%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
have() { command -v "$1" >/dev/null 2>&1; }
port_pid() { # port -> pids listening on it (empty when no tool/unknown)
  local port="$1"
  if have lsof; then
    lsof -ti tcp:"$port" 2>/dev/null || true
  elif have ss; then
    ss -tlnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  fi
}

wait_for() { # url tries
  local url="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    curl -sf -o /dev/null "$url" && return 0
    sleep 1
  done
  return 1
}

HARD_FAIL=0
NOTE_FAILURES=()

require_version() { # name current min
  if version_gte "$2" "$3"; then ok "$1 $2 (need >= $3)"; else bad "$1 $2 is too old (need >= $3)"; HARD_FAIL=1; fi
}

# --- 1. toolchain checks ----------------------------------------------------
check_toolchain() {
  say "toolchain"

  if have node; then
    require_version "node" "$(node --version | sed 's/^v//')" "18"
  else
    bad "node not found (need >= 18) — brew install node"; HARD_FAIL=1
  fi

  local want_pnpm=""
  if [ -f package.json ] && have node; then
    want_pnpm="$(node -p "try { require('./package.json').packageManager || '' } catch { '' }" 2>/dev/null || true)"
    want_pnpm="${want_pnpm#pnpm@}"
  fi

  if ! have pnpm; then
    if have corepack; then
      say "pnpm missing — activating via corepack (${want_pnpm:-latest})"
      corepack enable >/dev/null 2>&1 || true
      corepack prepare "pnpm@${want_pnpm:-latest}" --activate >/dev/null 2>&1 || true
    fi
  fi
  if have pnpm; then
    local pnpm_version; pnpm_version="$(pnpm --version)"
    if [ -n "$want_pnpm" ] && [ "$pnpm_version" != "$want_pnpm" ]; then
      warn "pnpm $pnpm_version found, repo pins $want_pnpm — attempting corepack switch"
      if have corepack; then
        corepack prepare "pnpm@$want_pnpm" --activate >/dev/null 2>&1 || true
        pnpm_version="$(pnpm --version)"
      fi
      [ "$pnpm_version" = "$want_pnpm" ] && ok "pnpm $pnpm_version (repo pin)" || warn "proceeding with pnpm $pnpm_version (repo pin $want_pnpm not enforced)"
    else
      ok "pnpm $pnpm_version"
    fi
  else
    bad "pnpm not found (need >= 8, repo pins ${want_pnpm:-11.7.0}) — npm install -g pnpm"; HARD_FAIL=1
  fi

  if have python3; then
    require_version "python3" "$(python3 --version | awk '{print $2}')" "3.11"
  else
    bad "python3 not found (need >= 3.11) — brew install python@3.11"; HARD_FAIL=1
  fi

  if have ffmpeg && have ffprobe; then
    ok "ffmpeg + ffprobe $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
  else
    warn "ffmpeg/ffprobe missing — export QC (measure_export) and ASR audio extraction need it"
    NOTE_FAILURES+=("install ffmpeg:  brew install ffmpeg")
  fi
}

# --- 2. install steps (skip when already done) ------------------------------
install_node_side() {
  say "node dependencies"
  if [ -d node_modules ]; then
    ok "node_modules present (skip pnpm install)"
  else
    say "installing workspace (pnpm install)"
    pnpm install
  fi

  if [ -f packages/core/src/wasm/fft/build/fft.wasm ] \
    && [ -f packages/core/src/wasm/wav/build/wav.wasm ] \
    && [ -f packages/core/src/wasm/beat-detection/build/beat.wasm ]; then
    ok "wasm modules built (skip build:wasm)"
  else
    say "building wasm modules"
    pnpm build:wasm
  fi
}

engine_venv_ok() {
  [ -x "$ENGINE_DIR/.venv/bin/python" ] \
    && "$ENGINE_DIR/.venv/bin/python" -c "import fastapi, uvicorn, kove_engine" >/dev/null 2>&1
}

install_python_side() {
  say "python engine venv ($ENGINE_DIR/.venv)"
  if [ ! -x "$ENGINE_DIR/.venv/bin/python" ]; then
    say "creating venv"
    python3 -m venv "$ENGINE_DIR/.venv"
    "$ENGINE_DIR/.venv/bin/pip" install -q --upgrade pip
  fi

  if engine_venv_ok; then
    ok "engine imports cleanly (skip pip install)"
  else
    say "engine deps missing or stale — pip install -e \".[dev]\""
    "$ENGINE_DIR/.venv/bin/pip" install -q -e "$ENGINE_DIR[dev]" \
      || "$ENGINE_DIR/.venv/bin/pip" install -q -e "$ENGINE_DIR" \
      || { bad "engine install failed — see output above"; HARD_FAIL=1; return 0; }
    engine_venv_ok && ok "engine imports cleanly" || { bad "engine still fails to import — run: $ENGINE_DIR/.venv/bin/pip install -e \"$ENGINE_DIR[dev]\""; HARD_FAIL=1; }
  fi

  if "$ENGINE_DIR/.venv/bin/python" -c "import faster_whisper" >/dev/null 2>&1; then
    ok "faster-whisper installed (ASR ready; model downloads on first transcribe)"
  elif [ "${WANT_ASR:-0}" = "1" ]; then
    say "installing ASR extra (faster-whisper)"
    "$ENGINE_DIR/.venv/bin/pip" install -q -e "$ENGINE_DIR[asr]" \
      && ok "faster-whisper installed — the whisper model downloads from Hugging Face on first transcribe" \
      || warn "ASR install failed — transcription is optional; everything else works"
  else
    warn "faster-whisper not installed — single-source ASR (transcribe_audio) disabled"
    NOTE_FAILURES+=("enable ASR:  ./dev.sh --asr")
  fi

  if "$ENGINE_DIR/.venv/bin/python" -c "import webrtcvad" >/dev/null 2>&1; then
    ok "webrtcvad present (VAD pauses active)"
  else
    warn "webrtcvad not built (needs C compiler; on mac: xcode-select --install) — engine runs, but VAD pauses are off"
  fi

  if [ -f .dev.vars ]; then
    ok ".dev.vars present (live model config for the web app)"
  else
    warn ".dev.vars missing at repo root — the web app will run but has no live model key configured"
    NOTE_FAILURES+=("configure the model:  cp .dev.vars.example .dev.vars   # then add your key")
  fi
}

# --- 3. start (skip what's already up) --------------------------------------
start_engine() {
  say "python engine"
  if curl -sf -o /dev/null "$ENGINE_HEALTH"; then
    ok "already running and healthy → $ENGINE_URL  (skip)"
    return 0
  fi
  # setsid (Linux) gives the daemon its own process group so --stop can take
  # the whole tree down; macOS has no setsid — plain nohup is fine there.
  if have setsid; then
    (cd "$ENGINE_DIR" && setsid nohup .venv/bin/python -m uvicorn server:app \
      --host 0.0.0.0 --port "${ENGINE_PORT:-8000}" \
      > "$RUN_DIR/engine.log" 2>&1 < /dev/null & echo $! > "$RUN_DIR/engine.pid")
  else
    (cd "$ENGINE_DIR" && nohup .venv/bin/python -m uvicorn server:app \
      --host 0.0.0.0 --port "${ENGINE_PORT:-8000}" \
      > "$RUN_DIR/engine.log" 2>&1 < /dev/null & echo $! > "$RUN_DIR/engine.pid")
  fi
  if wait_for "$ENGINE_HEALTH" 90; then
    # $! may be a wrapper (setsid forks) — record the pid actually LISTENING.
    local real_pid; real_pid="$(port_pid "${ENGINE_PORT:-8000}" | head -1)"
    [ -n "$real_pid" ] && echo "$real_pid" > "$RUN_DIR/engine.pid"
    ok "engine healthy → $ENGINE_HEALTH  (pid $(cat "$RUN_DIR/engine.pid"))"
  else
    bad "engine did not become healthy in 90s — last log lines ($RUN_DIR/engine.log):"
    tail -n 15 "$RUN_DIR/engine.log" || true
    HARD_FAIL=1
  fi
}

start_web() {
  say "web app (vite)"
  if curl -sf -o /dev/null "$WEB_URL"; then
    ok "already serving → $WEB_URL  (skip)"
    return 0
  fi
  # Launch vite directly (not via pnpm) so the recorded pid IS the server —
  # a pnpm wrapper pid orphans vite on stop.
  if have setsid; then
    (cd apps/web && setsid nohup ./node_modules/.bin/vite \
      --host 0.0.0.0 --port "$WEB_PORT" --strictPort \
      > "$RUN_DIR/web.log" 2>&1 < /dev/null & echo $! > "$RUN_DIR/web.pid")
  else
    (cd apps/web && nohup ./node_modules/.bin/vite \
      --host 0.0.0.0 --port "$WEB_PORT" --strictPort \
      > "$RUN_DIR/web.log" 2>&1 < /dev/null & echo $! > "$RUN_DIR/web.pid")
  fi
  if wait_for "$WEB_URL" 120; then
    local real_pid; real_pid="$(port_pid "$WEB_PORT" | head -1)"
    [ -n "$real_pid" ] && echo "$real_pid" > "$RUN_DIR/web.pid"
    ok "web app up → $WEB_URL  (pid $(cat "$RUN_DIR/web.pid"))"
  else
    bad "vite did not respond in 120s — last log lines ($RUN_DIR/web.log):"
    tail -n 15 "$RUN_DIR/web.log" || true
    HARD_FAIL=1
  fi
}

stop_started() {
  say "stopping"
  local pidfile pid label
  for pidfile in "$RUN_DIR/web.pid" "$RUN_DIR/engine.pid"; do
    [ -f "$pidfile" ] || continue
    label="$(basename "$pidfile" .pid)"
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # Children first (pnpm wraps vite), then the process itself.
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      # setsid-launched daemons lead their own process group — take the tree.
      kill -TERM -- "-$pid" 2>/dev/null || true
      printf '%s\n' "  stopping $label (pid $pid)"
    fi
    rm -f "$pidfile"
  done
  # The scoped hammer: if our daemons left anything bound to the dev ports
  # (orphaned vite children, graceful-shutdown stragglers), free the ports —
  # but ONLY because this script owned them just now (pidfiles existed above).
  local port pids
  for port in "${ENGINE_PORT:-8000}" "$WEB_PORT"; do
    pids="$(port_pid "$port")"
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true   # graceful first
      sleep 1
      pids="$(port_pid "$port")"
      [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
      printf '%s\n' "  freed port $port"
    fi
  done
  # fuser as a last resort where neither lsof nor ss parsed anything
  if have fuser; then
    for port in "${ENGINE_PORT:-8000}" "$WEB_PORT"; do
      fuser -k "$port/tcp" >/dev/null 2>&1 && printf '%s\n' "  freed port $port (fuser)" || true
    done
  fi
  ok "done — logs remain in $RUN_DIR/"
}

summary() {
  say "summary"
  printf '%s\n' "  engine   : $ENGINE_URL  (docs: $ENGINE_URL/docs)"
  printf '%s\n' "  web      : $WEB_URL"
  printf '%s\n' "  logs     : $RUN_DIR/{engine,web}.log"
  printf '%s\n' "  stop     : ./dev.sh --stop"
  if [ "${#NOTE_FAILURES[@]}" -gt 0 ]; then
    printf '%s\n' ""
    warn "optional gaps:"
    local note
    for note in "${NOTE_FAILURES[@]}"; do printf '%s\n' "    - $note"; done
  fi
}

# --- flag parsing -----------------------------------------------------------
MODE="up"      # up | check | stop
TARGET="all"   # all | engine | web
while [ $# -gt 0 ]; do
  case "$1" in
    --check)  MODE="check" ;;
    --engine) TARGET="engine" ;;
    --web)    TARGET="web" ;;
    --asr)    WANT_ASR=1 ;;
    --stop)   MODE="stop" ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)
      die "unknown flag: $1 (try --help)" ;;
  esac
  shift
done

if [ "$MODE" = "stop" ]; then stop_started; exit 0; fi

check_toolchain
if [ "$HARD_FAIL" = "1" ]; then
  bad "toolchain check failed — fix the ✗ items above and re-run"
  exit 1
fi

if [ "$MODE" = "check" ]; then
  install_node_side
  install_python_side
  if [ "$HARD_FAIL" = "1" ]; then
    bad "--check found hard failures above"
    exit 1
  fi
  ok "everything checks out — run ./dev.sh to start"
  exit 0
fi

case "$TARGET" in
  engine) install_python_side; start_engine ;;
  web)    install_node_side;    start_web ;;
  all)    install_node_side; install_python_side; start_engine; start_web ;;
esac

if [ "$HARD_FAIL" = "1" ]; then
  bad "one or more services failed to start — see the ✗ lines and logs in $RUN_DIR/"
  exit 1
fi

printf '%s\n' ""
summary
