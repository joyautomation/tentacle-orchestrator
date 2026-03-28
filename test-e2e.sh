#!/usr/bin/env bash
#
# End-to-end integration test for tentacle platform + orchestrator
#
# Creates a fresh incus container, runs install.sh, verifies the platform,
# then tests the orchestrator's ability to manage services via NATS KV.
#
# Usage:
#   ./test-e2e.sh                    # Full test (create container, install, test, destroy)
#   ./test-e2e.sh --keep             # Keep the container after tests (for debugging)
#   ./test-e2e.sh --container <name> # Use an existing container (skip create/destroy)
#
set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
CONTAINER_NAME="tentacle-e2e-$$"
IMAGE="images:ubuntu/noble"
KEEP=false
EXISTING_CONTAINER=""
INSTALL_SH_URL="https://raw.githubusercontent.com/joyautomation/tentacle/main/install.sh"
TENTACLE_DIR="/home/joyja/Development/joyautomation/kraken/tentacle"

# Modules to install (optional modules with known releases)
OPTIONAL_MODULES="tentacle-mqtt,tentacle-snmp"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }
skip() { echo -e "  ${YELLOW}SKIP${NC} $1"; SKIP=$((SKIP + 1)); }
step() { echo -e "\n${BOLD}${CYAN}$1${NC}"; }
info() { echo -e "  ${DIM}$1${NC}"; }

# ─── Parse arguments ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)       KEEP=true; shift ;;
    --container)  EXISTING_CONTAINER="$2"; KEEP=true; shift 2 ;;
    *)            shift ;;
  esac
done

if [ -n "$EXISTING_CONTAINER" ]; then
  CONTAINER_NAME="$EXISTING_CONTAINER"
fi

# ─── Helper: run command in container ───────────────────────────────────────
run_in() {
  incus exec "$CONTAINER_NAME" -- bash -c "$1"
}

# ─── Cleanup ────────────────────────────────────────────────────────────────
cleanup() {
  if [ "$KEEP" = "true" ]; then
    echo -e "\n${YELLOW}Container kept: ${CONTAINER_NAME}${NC}"
    echo -e "  incus exec ${CONTAINER_NAME} -- bash"
    echo -e "  incus delete ${CONTAINER_NAME} --force"
  elif [ -z "$EXISTING_CONTAINER" ]; then
    step "Cleaning up..."
    incus delete "$CONTAINER_NAME" --force 2>/dev/null || true
    echo "  Done."
  fi
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Container Setup
# ═══════════════════════════════════════════════════════════════════════════════
if [ -z "$EXISTING_CONTAINER" ]; then
  step "PHASE 1: Creating fresh container ($CONTAINER_NAME)"

  incus launch "$IMAGE" "$CONTAINER_NAME" -c security.nesting=true 2>&1
  info "Waiting for container to boot..."
  sleep 3

  # Wait for network
  for i in $(seq 1 30); do
    if run_in "ping -c1 -W1 api.github.com" &>/dev/null; then
      break
    fi
    sleep 1
  done

  # Install prerequisites
  info "Installing prerequisites (curl, unzip, jq)..."
  run_in "apt-get update -qq && apt-get install -y -qq curl unzip jq >/dev/null 2>&1"
  pass "Container created and ready"
else
  step "PHASE 1: Using existing container ($CONTAINER_NAME)"
  pass "Container exists"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Install tentacle via install.sh
# ═══════════════════════════════════════════════════════════════════════════════
step "PHASE 2: Installing tentacle platform"

# Copy install.sh from local repo (more reliable than downloading from GitHub
# since the repo might not have the latest changes pushed)
incus file push "$TENTACLE_DIR/tentacle/install.sh" "$CONTAINER_NAME/tmp/install.sh"
run_in "chmod +x /tmp/install.sh"
pass "Copied install.sh to container"

# Run install with auto-yes and selected optional modules
info "Running install.sh (this downloads from GitHub, may take a minute)..."
if run_in "bash /tmp/install.sh install --yes --modules ${OPTIONAL_MODULES}" 2>&1; then
  pass "install.sh completed successfully"
else
  fail "install.sh failed (exit code $?)"
  echo "    Attempting to show last output..."
  run_in "journalctl --no-pager -n 20" 2>/dev/null || true
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Verify installation
# ═══════════════════════════════════════════════════════════════════════════════
step "PHASE 3: Verifying installation"

# Check directory structure
for dir in bin services config data/nats cache/deno; do
  if run_in "test -d /opt/tentacle/$dir"; then
    pass "Directory exists: /opt/tentacle/$dir"
  else
    fail "Missing directory: /opt/tentacle/$dir"
  fi
done

# Check NATS binary
if run_in "test -x /opt/tentacle/bin/nats-server"; then
  NATS_VER=$(run_in "/opt/tentacle/bin/nats-server --version 2>&1 | head -1" || echo "?")
  pass "NATS server binary installed ($NATS_VER)"
else
  fail "NATS server binary not found"
fi

# Check Deno binary
if run_in "test -x /opt/tentacle/bin/deno"; then
  DENO_VER=$(run_in "/opt/tentacle/bin/deno --version 2>&1 | head -1" || echo "?")
  pass "Deno runtime installed ($DENO_VER)"
else
  fail "Deno runtime not found"
fi

# Check core modules
for mod in tentacle-graphql tentacle-web tentacle-orchestrator; do
  if run_in "test -d /opt/tentacle/services/$mod"; then
    pass "Core module installed: $mod"
  else
    fail "Core module missing: $mod"
  fi
done

# Check Go binaries (optional modules)
for mod in tentacle-snmp; do
  if run_in "test -x /opt/tentacle/bin/$mod"; then
    pass "Go binary installed: $mod"
  else
    fail "Go binary missing: $mod"
  fi
done

# Check Deno services (optional modules)
for mod in tentacle-mqtt; do
  if run_in "test -d /opt/tentacle/services/$mod"; then
    pass "Deno service installed: $mod"
  else
    fail "Deno service missing: $mod"
  fi
done

# Check config file
if run_in "test -f /opt/tentacle/config/tentacle.env"; then
  pass "Config file exists"
else
  fail "Config file missing"
fi

# Check systemd units exist
for unit in tentacle-nats tentacle-graphql tentacle-web tentacle-orchestrator tentacle-mqtt tentacle-snmp; do
  if run_in "test -f /etc/systemd/system/${unit}.service"; then
    pass "Systemd unit exists: ${unit}.service"
  else
    fail "Systemd unit missing: ${unit}.service"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Verify services are running
# ═══════════════════════════════════════════════════════════════════════════════
step "PHASE 4: Verifying services are running"

# Give services time to start
info "Waiting for services to start..."
sleep 5

# Check NATS is running
if run_in "systemctl is-active tentacle-nats.service --quiet"; then
  pass "NATS server is running"
else
  fail "NATS server is not running"
  run_in "journalctl -u tentacle-nats.service --no-pager -n 10" 2>/dev/null || true
fi

# Check core services
for svc in tentacle-graphql tentacle-web tentacle-orchestrator; do
  # These may take a moment to start (Deno cold start)
  sleep 2
  STATUS=$(run_in "systemctl is-active ${svc}.service 2>/dev/null || echo 'not-running'")
  if [ "$STATUS" = "active" ]; then
    pass "Service running: ${svc}"
  else
    fail "Service not running: ${svc} (status: $STATUS)"
    run_in "journalctl -u ${svc}.service --no-pager -n 10" 2>/dev/null || true
  fi
done

# Check optional services
for svc in tentacle-mqtt tentacle-snmp; do
  STATUS=$(run_in "systemctl is-active ${svc}.service 2>/dev/null || echo 'not-running'")
  if [ "$STATUS" = "active" ]; then
    pass "Service running: ${svc}"
  else
    # Optional services may fail due to missing config (e.g., MQTT needs broker URL)
    info "Service ${svc} status: $STATUS (may need config)"
    skip "Service ${svc} not active (expected — needs config)"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Verify GraphQL API
# ═══════════════════════════════════════════════════════════════════════════════
step "PHASE 5: Verifying GraphQL API"

# Wait a bit for graphql to fully start
sleep 5

GQL_RESULT=$(run_in 'curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '"'"'{"query":"{ services { serviceType moduleId } }"}'"'"' 2>/dev/null' || echo "")

if echo "$GQL_RESULT" | grep -q '"services"'; then
  SVC_COUNT=$(echo "$GQL_RESULT" | jq '.data.services | length' 2>/dev/null || echo "?")
  pass "GraphQL API responding ($SVC_COUNT services in heartbeat)"
else
  fail "GraphQL API not responding"
  info "Response: $GQL_RESULT"
fi

# Check web dashboard
WEB_RESULT=$(run_in "curl -s -o /dev/null -w '%{http_code}' http://localhost:3012/ 2>/dev/null" || echo "000")
if [ "$WEB_RESULT" = "200" ]; then
  pass "Web dashboard accessible (HTTP 200)"
else
  fail "Web dashboard not accessible (HTTP $WEB_RESULT)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 6: Test orchestrator via NATS KV
# ═══════════════════════════════════════════════════════════════════════════════
step "PHASE 6: Testing orchestrator service management"

# Install NATS CLI for testing (use .deb package — most reliable)
info "Installing NATS CLI..."
run_in 'TMPDIR=$(mktemp -d) && \
  curl -fsSL "https://github.com/nats-io/natscli/releases/latest/download/nats-0.3.2-amd64.deb" -o "$TMPDIR/nats.deb" && \
  dpkg -i "$TMPDIR/nats.deb" >/dev/null 2>&1 && \
  rm -rf "$TMPDIR"' 2>/dev/null || true

if run_in "command -v nats" &>/dev/null; then
  pass "NATS CLI installed"
else
  fail "NATS CLI not available — remaining tests may fail"
fi

# Verify orchestrator heartbeat
HB=$(run_in "nats kv get service_heartbeats orchestrator --raw 2>/dev/null" || echo "")
if echo "$HB" | grep -q '"serviceType":"orchestrator"'; then
  pass "Orchestrator heartbeat present"
else
  fail "Orchestrator heartbeat not found"
fi

# Test: Write desired_services to start a new module version
info "Testing orchestrator reconciliation..."

# The orchestrator is already running. Let's test by stopping tentacle-mqtt via systemd,
# then telling the orchestrator to start it via desired_services KV.
run_in "systemctl stop tentacle-mqtt.service 2>/dev/null || true"
sleep 2

# Verify it's stopped
MQTT_STATUS=$(run_in "systemctl is-active tentacle-mqtt.service 2>/dev/null || echo 'stopped'")
if [ "$MQTT_STATUS" != "active" ]; then
  pass "Stopped tentacle-mqtt for orchestrator test"
else
  skip "tentacle-mqtt still active, orchestrator test may be ambiguous"
fi

# Write desired state: tentacle-mqtt should be running
NOW=$(date +%s000)
run_in "nats kv put desired_services tentacle-mqtt '{\"moduleId\":\"tentacle-mqtt\",\"version\":\"latest\",\"running\":true,\"updatedAt\":${NOW}}' 2>/dev/null"
pass "Wrote desired_services entry for tentacle-mqtt"

# Wait for orchestrator to reconcile
info "Waiting for orchestrator to reconcile (up to 15s)..."
sleep 15

# Check if orchestrator wrote status
ORCH_STATUS=$(run_in "nats kv get service_status tentacle-mqtt --raw 2>/dev/null" || echo "")
if [ -n "$ORCH_STATUS" ]; then
  RECONCILE_STATE=$(echo "$ORCH_STATUS" | jq -r '.reconcileState' 2>/dev/null || echo "?")
  ACTIVE_VERSION=$(echo "$ORCH_STATUS" | jq -r '.activeVersion' 2>/dev/null || echo "?")
  pass "Orchestrator reported status: reconcileState=$RECONCILE_STATE, version=$ACTIVE_VERSION"
else
  fail "Orchestrator did not report status for tentacle-mqtt"
fi

# Test: Set running=false to stop a module
run_in "nats kv put desired_services tentacle-mqtt '{\"moduleId\":\"tentacle-mqtt\",\"version\":\"latest\",\"running\":false,\"updatedAt\":$(date +%s000)}' 2>/dev/null"
sleep 10

MQTT_AFTER=$(run_in "systemctl is-active tentacle-mqtt.service 2>/dev/null || echo 'stopped'")
if [ "$MQTT_AFTER" != "active" ]; then
  pass "Orchestrator stopped tentacle-mqtt (running=false)"
else
  fail "tentacle-mqtt still running after setting running=false"
fi

# Test: Delete desired service
run_in "nats kv del desired_services tentacle-mqtt -f 2>/dev/null"
pass "Deleted desired_services entry"

# Test: Query orchestrator status via GraphQL
GQL_DS=$(run_in 'curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '"'"'{"query":"{ desiredServices { moduleId version running } }"}'"'"' 2>/dev/null' || echo "")

if echo "$GQL_DS" | grep -q '"desiredServices"'; then
  pass "GraphQL desiredServices query works"
else
  fail "GraphQL desiredServices query failed"
fi

GQL_SS=$(run_in 'curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '"'"'{"query":"{ serviceStatuses { moduleId reconcileState activeVersion } }"}'"'"' 2>/dev/null' || echo "")

if echo "$GQL_SS" | grep -q '"serviceStatuses"'; then
  pass "GraphQL serviceStatuses query works"
else
  fail "GraphQL serviceStatuses query failed"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 7: install.sh status command
# ═══════════════════════════════════════════════════════════════════════════════
step "PHASE 7: Verify install.sh status"

STATUS_OUTPUT=$(run_in "bash /tmp/install.sh status 2>&1" || echo "")
if echo "$STATUS_OUTPUT" | grep -q "nats"; then
  pass "install.sh status runs successfully"
else
  fail "install.sh status failed"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Results
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$SKIP skipped${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo -e "${RED}Some tests failed.${NC} Debug with:"
  echo "  incus exec $CONTAINER_NAME -- bash"
  echo "  incus exec $CONTAINER_NAME -- journalctl -u tentacle-orchestrator -f"
  exit 1
fi
