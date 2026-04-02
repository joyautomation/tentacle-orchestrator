#!/usr/bin/env bash
#
# Provisions an Incus container (tentacle-orchestrator-dev) for hot-reload
# development of tentacle-orchestrator, tentacle-graphql, and tentacle-web.
#
# The parent tentacle/ directory is bind-mounted so edits on the host trigger
# Deno --watch and Vite HMR inside the container.
#
# Usage:
#   ./container-setup.sh          # Create and provision
#   ./container-setup.sh teardown # Delete the container
#
set -euo pipefail

CONTAINER_NAME="tentacle-orchestrator-dev"
# Mount the parent tentacle/ directory so all three projects are accessible
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOUNT_PATH="/root/tentacle"

# ═══════════════════════════════════════════════════════════════════════════════
# Teardown
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "${1:-}" == "teardown" ]]; then
  echo "Deleting container '$CONTAINER_NAME'..."
  incus stop "$CONTAINER_NAME" --force 2>/dev/null || true
  incus delete "$CONTAINER_NAME" 2>/dev/null || true
  echo "Done."
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Pre-flight checks
# ═══════════════════════════════════════════════════════════════════════════════

if incus info "$CONTAINER_NAME" &>/dev/null; then
  echo "Container '$CONTAINER_NAME' already exists."
  echo "  To recreate: ./container-setup.sh teardown && ./container-setup.sh"
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  Setting up Incus dev container: $CONTAINER_NAME"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Create container
# ═══════════════════════════════════════════════════════════════════════════════

echo "Creating Ubuntu 24.04 container..."
incus launch images:ubuntu/24.04 "$CONTAINER_NAME"

echo "Waiting for container to start..."
sleep 5

# Map host UID/GID to container root so bind-mounted files are writable
HOST_UID=$(id -u)
HOST_GID=$(id -g)
echo "Mapping host UID $HOST_UID -> container root..."
incus config set "$CONTAINER_NAME" raw.idmap "both $HOST_UID 0"
incus restart "$CONTAINER_NAME"
sleep 3

# ═══════════════════════════════════════════════════════════════════════════════
# Mount source directory
# ═══════════════════════════════════════════════════════════════════════════════

echo "Mounting source directory..."
incus config device add "$CONTAINER_NAME" tentacle-src disk \
  source="$SOURCE_DIR" \
  path="$MOUNT_PATH"

# ═══════════════════════════════════════════════════════════════════════════════
# Install dependencies inside container
# ═══════════════════════════════════════════════════════════════════════════════

echo "Installing dependencies (this may take a minute)..."
incus exec "$CONTAINER_NAME" -- bash <<'SETUP'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "--- System packages ---"
apt-get update -qq
apt-get install -y -qq curl unzip ca-certificates gnupg >/dev/null 2>&1

echo "--- Deno ---"
curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh 2>/dev/null
echo "  $(deno --version | head -1)"

echo "--- Node.js 22 ---"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null 2>&1
echo "  node $(node --version), npm $(npm --version)"

echo "--- NATS server ---"
cd /tmp
curl -sf https://binaries.nats.dev/nats-io/nats-server/v2@latest | sh 2>/dev/null
mv nats-server /usr/local/bin/
echo "  $(nats-server --version)"

echo "--- NATS CLI ---"
curl -sf https://binaries.nats.dev/nats-io/natscli/nats@latest | sh 2>/dev/null
mv nats /usr/local/bin/
echo "  nats $(nats --version 2>&1)"

echo "--- Configuring NATS systemd service ---"
mkdir -p /var/lib/nats
cat > /etc/nats-server.conf <<EOF
jetstream {
  store_dir: /var/lib/nats
}
max_payload: 33554432
EOF

cat > /etc/systemd/system/nats.service <<EOF
[Unit]
Description=NATS Server
After=network.target

[Service]
ExecStart=/usr/local/bin/nats-server -c /etc/nats-server.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nats >/dev/null 2>&1
systemctl start nats
echo "  NATS server running with JetStream"

echo "--- Orchestrator directories ---"
mkdir -p /opt/tentacle/{bin,services,versions,cache/deno/versions,config}
echo "  Created /opt/tentacle directory structure"

echo "--- npm install for tentacle-web ---"
cd /root/tentacle/tentacle-web
if [ -d "node_modules" ]; then
  echo "  node_modules exists (shared from host), skipping npm install"
  echo "  Run 'npm install' inside the container if you get module errors"
else
  npm install --loglevel=error 2>&1
  echo "  Done"
fi

echo ""
echo "All dependencies installed."
SETUP

# ═══════════════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════════════

CONTAINER_IP=$(incus list "$CONTAINER_NAME" -f csv -c 4 | head -1 | cut -d' ' -f1)

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Container '$CONTAINER_NAME' is ready!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  IP: $CONTAINER_IP"
echo ""
echo "  Start services:"
echo "    ./todev.sh start"
echo ""
echo "  View logs:"
echo "    ./todev.sh logs"
echo ""
echo "  Stop services:"
echo "    ./todev.sh stop"
echo ""
echo "  Shell:"
echo "    ./todev.sh shell"
echo ""
echo "  Web UI:  http://$CONTAINER_IP:3012"
echo "  GraphQL: http://$CONTAINER_IP:4000/graphql"
echo ""
