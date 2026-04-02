#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Services live in sibling directories under the tentacle/ mount
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDFILE="$SCRIPT_DIR/.dev-pids"
LOGDIR="$SCRIPT_DIR/.dev-logs"

ALL_SERVICES=(tentacle-orchestrator tentacle-graphql tentacle-web)

# Read enabled services from dev.yaml if it exists, otherwise use all
DEV_YAML="$SCRIPT_DIR/dev.yaml"
if [[ -f "$DEV_YAML" ]]; then
  SERVICES=()
  while IFS= read -r line; do
    svc=$(echo "$line" | sed -n 's/^[[:space:]]*-[[:space:]]*\([a-zA-Z0-9_-]*\).*/\1/p')
    if [[ -n "$svc" ]]; then
      SERVICES+=("$svc")
    fi
  done < "$DEV_YAML"
  echo "Using dev.yaml: ${SERVICES[*]}"
else
  SERVICES=("${ALL_SERVICES[@]}")
fi

start_service() {
  local svc="$1"
  local dir="$ROOT/$svc"
  local logfile="$LOGDIR/$svc.log"
  local svc_pidfile="$LOGDIR/$svc.pid"

  mkdir -p "$LOGDIR"

  if [[ "$svc" == "tentacle-web" ]]; then
    setsid bash -c "echo \$\$ > \"$svc_pidfile\"; cd \"$dir\" && exec npm run dev > \"$logfile\" 2>&1" </dev/null &
  else
    setsid bash -c "echo \$\$ > \"$svc_pidfile\"; cd \"$dir\" && exec deno task dev > \"$logfile\" 2>&1" </dev/null &
  fi

  sleep 0.15
  local real_pid
  real_pid=$(cat "$svc_pidfile" 2>/dev/null || echo "$!")

  echo "$real_pid $svc" >> "$PIDFILE"
  echo "  $svc started (pid $real_pid)"
}

stop_all() {
  if [[ ! -f "$PIDFILE" ]]; then
    echo "No running services found."
    return
  fi

  echo "Stopping services..."
  while IFS=' ' read -r pid svc; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null && echo "  $svc stopped (pgid $pid)" || true
    fi
  done < "$PIDFILE"
  rm -f "$PIDFILE"

  # Wait for graceful shutdown, then SIGKILL any survivors
  sleep 2
  pgrep -f "deno.*(task dev|run.*main.ts)" 2>/dev/null | while read -r p; do
    cwd=$(readlink -f /proc/"$p"/cwd 2>/dev/null) || continue
    if [[ "$cwd" == "$ROOT"/* ]]; then
      kill -9 "$p" 2>/dev/null && echo "  force-killed lingering deno pid $p ($cwd)"
    fi
  done || true
  pgrep -f "node.*vite dev" 2>/dev/null | while read -r p; do
    cwd=$(readlink -f /proc/"$p"/cwd 2>/dev/null) || continue
    if [[ "$cwd" == "$ROOT"/* ]]; then
      kill -9 "$p" 2>/dev/null && echo "  force-killed lingering vite pid $p ($cwd)"
    fi
  done || true
}

start_all() {
  echo "Starting services..."
  for svc in "${SERVICES[@]}"; do
    start_service "$svc"
  done
  echo ""
  echo "Logs: $LOGDIR/"
  echo "  tail -f $LOGDIR/*.log"
}

status() {
  if [[ ! -f "$PIDFILE" ]]; then
    echo "No services tracked."
    return
  fi

  while IFS=' ' read -r pid svc; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  $svc: running (pid $pid)"
    else
      echo "  $svc: dead (pid $pid)"
    fi
  done < "$PIDFILE"
}

stop_one() {
  local svc="$1"
  if [[ ! -f "$PIDFILE" ]]; then
    echo "No running services found."
    return
  fi
  while IFS=' ' read -r pid s; do
    if [[ "$s" == "$svc" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null && echo "  $svc stopped (pgid $pid)" || true
    fi
  done < "$PIDFILE"
  grep -v " $svc$" "$PIDFILE" > "$PIDFILE.tmp" 2>/dev/null || true
  mv "$PIDFILE.tmp" "$PIDFILE" 2>/dev/null || true
}

restart_one() {
  local svc="$1"
  stop_one "$svc"
  start_service "$svc"
}

case "${1:-start}" in
  start)
    if [[ -n "${2:-}" ]]; then
      start_service "$2"
    else
      stop_all 2>/dev/null || true
      start_all
    fi
    ;;
  stop)
    if [[ -n "${2:-}" ]]; then
      stop_one "$2"
    else
      stop_all
    fi
    ;;
  restart)
    if [[ -n "${2:-}" ]]; then
      restart_one "$2"
    else
      stop_all
      start_all
    fi
    ;;
  status)
    status
    ;;
  logs)
    if [[ -n "${2:-}" ]]; then
      tail -f "$LOGDIR/$2.log"
    else
      tail -f "$LOGDIR/"*.log
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs} [service-name]"
    exit 1
    ;;
esac
