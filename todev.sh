#!/usr/bin/env bash
#
# Quick wrapper for tentacle-orchestrator-dev container commands.
#
# Usage:
#   ./todev.sh start   — start all services
#   ./todev.sh stop    — stop all services
#   ./todev.sh restart — restart all services
#   ./todev.sh logs    — tail all logs
#   ./todev.sh status  — show service status
#   ./todev.sh shell   — open a bash shell
#   ./todev.sh ip      — print container IP
#   ./todev.sh <cmd>   — run arbitrary command in container
#
set -euo pipefail

CONTAINER="tentacle-orchestrator-dev"
MOUNT="/root/tentacle/tentacle-orchestrator"

HOST_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Kill any deno/node dev processes running on the HOST for this repo
kill_host_orphans() {
  local found=0
  for p in $(pgrep -f "deno.*(task dev|run.*main.ts)" 2>/dev/null); do
    local cwd
    cwd=$(readlink -f /proc/"$p"/cwd 2>/dev/null) || continue
    if [[ "$cwd" == "$HOST_ROOT"/* ]]; then
      kill -9 "$p" 2>/dev/null && echo "  killed host orphan pid $p ($cwd)" && found=1
    fi
  done
  for p in $(pgrep -f "node.*vite dev" 2>/dev/null); do
    local cwd
    cwd=$(readlink -f /proc/"$p"/cwd 2>/dev/null) || continue
    if [[ "$cwd" == "$HOST_ROOT"/* ]]; then
      kill -9 "$p" 2>/dev/null && echo "  killed host orphan pid $p ($cwd)" && found=1
    fi
  done
  [[ $found -eq 0 ]] || true
}

case "${1:-help}" in
  start|stop|restart|status|logs)
    incus exec "$CONTAINER" -- "$MOUNT/dev.sh" "$@"
    if [[ "$1" == "stop" || "$1" == "restart" ]]; then
      kill_host_orphans
    fi
    ;;
  shell)
    incus exec "$CONTAINER" -- bash
    ;;
  ip)
    incus list "$CONTAINER" -f csv -c 4 | head -1 | cut -d' ' -f1
    ;;
  help|-h|--help)
    echo "Usage: $0 {start|stop|restart|status|logs|shell|ip|<cmd>}"
    ;;
  *)
    incus exec "$CONTAINER" -- "$@"
    ;;
esac
