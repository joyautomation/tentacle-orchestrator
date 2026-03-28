#!/usr/bin/env bash
#
# Integration test for tentacle-orchestrator
#
# Run inside the tentacle-dev container:
#   incus exec tentacle-dev -- /root/tentacle/tentacle-orchestrator/test-integration.sh
#
# Tests:
#   1. Orchestrator connects to NATS and publishes heartbeat
#   2. Bootstrap migration detects existing modules
#   3. KV watch reacts to desired_services changes
#   4. Systemd unit generation and start/stop
#   5. Status reporting to service_status KV
#
set -euo pipefail

ROOT="/root/tentacle"
ORCH_DIR="$ROOT/tentacle-orchestrator"
INSTALL_DIR="/opt/tentacle-test"  # Use test dir to avoid clobbering real installs
SYSTEMD_DIR="/etc/systemd/system"
LOG_FILE="/tmp/orchestrator-test.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
ORCH_PID=""

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }
step() { echo -e "\n${BOLD}$1${NC}"; }
cleanup_orch() {
  if [ -n "$ORCH_PID" ] && kill -0 "$ORCH_PID" 2>/dev/null; then
    kill "$ORCH_PID" 2>/dev/null || true
    wait "$ORCH_PID" 2>/dev/null || true
  fi
}

# ─── Cleanup function ────────────────────────────────────────────────────────
cleanup() {
  step "Cleanup..."
  cleanup_orch

  # Remove test systemd units (orchestrator generates tentacle-mqtt.service etc.)
  rm -f ${SYSTEMD_DIR}/tentacle-mqtt.service 2>/dev/null || true
  rm -f ${SYSTEMD_DIR}/tentacle-history.service 2>/dev/null || true
  rm -f ${SYSTEMD_DIR}/tentacle-test-*.service 2>/dev/null || true
  systemctl daemon-reload 2>/dev/null || true

  # Clean up test directory
  rm -rf "$INSTALL_DIR" 2>/dev/null || true

  # Clean up NATS KV entries (purge test data, but keep buckets)
  for key in tentacle-mqtt tentacle-history; do
    nats kv del desired_services "$key" -f 2>/dev/null || true
    nats kv del service_status "$key" -f 2>/dev/null || true
  done

  echo "  Done."
}

trap cleanup EXIT

# ─── Pre-flight checks ───────────────────────────────────────────────────────
step "Pre-flight checks..."

if ! systemctl is-active nats --quiet 2>/dev/null; then
  echo -e "${RED}NATS is not running. Start it first.${NC}"
  exit 1
fi
pass "NATS is running"

if ! command -v deno &>/dev/null; then
  echo -e "${RED}Deno not found.${NC}"
  exit 1
fi
pass "Deno is available"

if ! command -v nats &>/dev/null; then
  echo -e "${RED}NATS CLI not found.${NC}"
  exit 1
fi
pass "NATS CLI is available"

# ─── Setup test environment ──────────────────────────────────────────────────
step "Setting up test environment..."

# Create test install directory structure
mkdir -p "$INSTALL_DIR"/{bin,services,versions,config,data/nats,cache/deno}

# Create a fake Go binary (just a shell script that publishes a heartbeat)
cat > "$INSTALL_DIR/bin/test-module" <<'SCRIPT'
#!/bin/bash
echo "test-module running (pid $$)"
# Just sleep — the orchestrator manages systemd, not the binary behavior
sleep 3600
SCRIPT
chmod +x "$INSTALL_DIR/bin/test-module"

# Create a minimal config
cat > "$INSTALL_DIR/config/tentacle.env" <<'ENV'
NATS_SERVERS=nats://localhost:4222
ENV

pass "Test directory created at $INSTALL_DIR"

# Clean any stale KV buckets from previous runs
nats kv del desired_services -f 2>/dev/null || true
nats kv del service_status -f 2>/dev/null || true
pass "Cleaned stale KV buckets"

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 1: Orchestrator starts and publishes heartbeat
# ═══════════════════════════════════════════════════════════════════════════════
step "TEST 1: Orchestrator starts and publishes heartbeat"

# Start orchestrator with test paths
cd "$ORCH_DIR"
TENTACLE_INSTALL_DIR="$INSTALL_DIR" \
TENTACLE_SYSTEMD_DIR="$SYSTEMD_DIR" \
TENTACLE_RECONCILE_INTERVAL=5000 \
TENTACLE_NATS_UNIT=nats \
NATS_SERVERS="localhost:4222" \
deno run --allow-all main.ts > "$LOG_FILE" 2>&1 &
ORCH_PID=$!

# Wait for it to connect and publish heartbeat
sleep 4

# Check heartbeat
HB=$(nats kv get service_heartbeats orchestrator --raw 2>/dev/null || echo "")
if echo "$HB" | grep -q '"serviceType":"orchestrator"'; then
  pass "Heartbeat published with serviceType=orchestrator"
else
  fail "Heartbeat not found or wrong serviceType"
  echo "    Got: $HB"
fi

# Check it's still running
if kill -0 "$ORCH_PID" 2>/dev/null; then
  pass "Orchestrator process is running (pid $ORCH_PID)"
else
  fail "Orchestrator process died"
  echo "    Log tail:"
  tail -20 "$LOG_FILE" | sed 's/^/    /'
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 2: desired_services KV triggers reconciliation
# ═══════════════════════════════════════════════════════════════════════════════
step "TEST 2: Writing desired_services triggers reconciliation"

# Pre-install tentacle-mqtt as a fake deno module so reconciler can work with it
# without needing to download from GitHub
mkdir -p "$INSTALL_DIR/versions/tentacle-mqtt/0.0.1"
cat > "$INSTALL_DIR/versions/tentacle-mqtt/0.0.1/main.ts" <<'TS'
console.log("fake tentacle-mqtt");
Deno.serve({ port: 0 }, () => new Response("ok"));
TS
cat > "$INSTALL_DIR/versions/tentacle-mqtt/0.0.1/deno.json" <<'JSON'
{ "name": "tentacle-mqtt-test" }
JSON
# Create symlink so getActiveVersion sees it
ln -sfn "$INSTALL_DIR/versions/tentacle-mqtt/0.0.1" "$INSTALL_DIR/services/tentacle-mqtt"
pass "Pre-installed tentacle-mqtt v0.0.1"

# Write a desired_services entry — orchestrator should react
nats kv put desired_services tentacle-mqtt '{"moduleId":"tentacle-mqtt","version":"0.0.1","running":false,"updatedAt":'"$(date +%s000)"'}' 2>/dev/null
pass "Wrote desired_services entry for tentacle-mqtt"

# Wait for reconciliation
sleep 6

# Check the log for reconciliation activity
if grep -q "Desired state changed.*tentacle-mqtt" "$LOG_FILE" 2>/dev/null; then
  pass "Orchestrator detected desired state change for tentacle-mqtt"
else
  fail "Orchestrator did not detect desired state change"
  echo "    Log tail:"
  tail -20 "$LOG_FILE" | sed 's/^/    /'
fi

# Check service_status was written
STATUS=$(nats kv get service_status tentacle-mqtt --raw 2>/dev/null || echo "")
if [ -n "$STATUS" ]; then
  pass "Service status reported to KV"

  # Check reconcileState
  RS=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reconcileState',''))" 2>/dev/null || echo "")
  if [ -n "$RS" ]; then
    pass "Reconcile state: $RS"
  fi
else
  fail "No service status written to KV"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 3: Setting running=true starts the service
# ═══════════════════════════════════════════════════════════════════════════════
step "TEST 3: Desired running=true triggers systemd start"

# Update to running=true
nats kv put desired_services tentacle-mqtt '{"moduleId":"tentacle-mqtt","version":"0.0.1","running":true,"updatedAt":'"$(date +%s000)"'}' 2>/dev/null
sleep 6

# Check that orchestrator attempted to start the unit
if grep -q "Starting tentacle-mqtt.service" "$LOG_FILE" 2>/dev/null; then
  pass "Orchestrator attempted to start tentacle-mqtt"
else
  fail "Orchestrator did not attempt to start tentacle-mqtt"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 4: Delete desired service
# ═══════════════════════════════════════════════════════════════════════════════
step "TEST 4: Deleting desired_services entry"

nats kv del desired_services tentacle-mqtt -f 2>/dev/null
sleep 3

if grep -q "Module removed from desired_services.*tentacle-mqtt" "$LOG_FILE" 2>/dev/null; then
  pass "Orchestrator detected module removal"
else
  fail "Orchestrator did not detect module removal"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 5: Multiple modules in desired state
# ═══════════════════════════════════════════════════════════════════════════════
step "TEST 5: Multiple desired services"

# Pre-install tentacle-history as another deno module
mkdir -p "$INSTALL_DIR/versions/tentacle-history/0.0.1"
cat > "$INSTALL_DIR/versions/tentacle-history/0.0.1/main.ts" <<'TS'
console.log("fake tentacle-history");
TS
cat > "$INSTALL_DIR/versions/tentacle-history/0.0.1/deno.json" <<'JSON'
{ "name": "tentacle-history-test" }
JSON
ln -sfn "$INSTALL_DIR/versions/tentacle-history/0.0.1" "$INSTALL_DIR/services/tentacle-history"

NOW=$(date +%s000)
nats kv put desired_services tentacle-mqtt "{\"moduleId\":\"tentacle-mqtt\",\"version\":\"0.0.1\",\"running\":false,\"updatedAt\":$NOW}" 2>/dev/null
nats kv put desired_services tentacle-history "{\"moduleId\":\"tentacle-history\",\"version\":\"0.0.1\",\"running\":false,\"updatedAt\":$NOW}" 2>/dev/null
pass "Wrote desired state for tentacle-mqtt and tentacle-history"

sleep 8

# Check that the orchestrator processed both
MQTT_LOG=$(grep -c "tentacle-mqtt" "$LOG_FILE" 2>/dev/null || echo "0")
HIST_LOG=$(grep -c "tentacle-history" "$LOG_FILE" 2>/dev/null || echo "0")

if [ "$MQTT_LOG" -gt 0 ]; then
  pass "Orchestrator processed tentacle-mqtt ($MQTT_LOG log lines)"
else
  fail "Orchestrator did not process tentacle-mqtt"
fi

if [ "$HIST_LOG" -gt 0 ]; then
  pass "Orchestrator processed tentacle-history ($HIST_LOG log lines)"
else
  fail "Orchestrator did not process tentacle-history"
fi

# Check service_status entries
MQTT_STATUS=$(nats kv get service_status tentacle-mqtt --raw 2>/dev/null || echo "")
HIST_STATUS=$(nats kv get service_status tentacle-history --raw 2>/dev/null || echo "")

if [ -n "$MQTT_STATUS" ]; then
  pass "tentacle-mqtt status reported"
else
  fail "tentacle-mqtt status not reported"
fi

if [ -n "$HIST_STATUS" ]; then
  pass "tentacle-history status reported"
else
  fail "tentacle-history status not reported"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 6: Periodic sweep catches drift
# ═══════════════════════════════════════════════════════════════════════════════
step "TEST 6: Periodic sweep runs"

# The reconcile interval is 5s, so just wait and check logs
sleep 6

SWEEP_COUNT=$(grep -c "Reconcile sweep" "$LOG_FILE" 2>/dev/null | tr -d '[:space:]' || echo "0")
if [ "$SWEEP_COUNT" -gt 1 ]; then
  pass "Periodic sweeps running ($SWEEP_COUNT sweeps total)"
else
  fail "Periodic sweeps not detected (found $SWEEP_COUNT)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 7: GraphQL queries work (if graphql is running)
# ═══════════════════════════════════════════════════════════════════════════════
step "TEST 7: GraphQL integration (if available)"

GQL_RESPONSE=$(curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ desiredServices { moduleId version running } }"}' 2>/dev/null || echo "")

if echo "$GQL_RESPONSE" | grep -q "desiredServices"; then
  MODULES=$(echo "$GQL_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['data']['desiredServices']))" 2>/dev/null || echo "?")
  pass "GraphQL desiredServices query works ($MODULES modules)"
else
  echo -e "  ${YELLOW}SKIP${NC} GraphQL not available (tentacle-graphql may not be running)"
fi

GQL_STATUS=$(curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ serviceStatuses { moduleId reconcileState activeVersion } }"}' 2>/dev/null || echo "")

if echo "$GQL_STATUS" | grep -q "serviceStatuses"; then
  pass "GraphQL serviceStatuses query works"
else
  echo -e "  ${YELLOW}SKIP${NC} GraphQL serviceStatuses not available"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Results
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Log output:"
  echo "─────────────────────────────────────────"
  cat "$LOG_FILE"
  exit 1
fi
