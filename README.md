# tentacle-orchestrator

Bare-metal service orchestrator for the Tentacle platform. Watches a `desired_services` NATS KV bucket and reconciles the actual state of each module against the desired state using systemd. Manages versioned installs via symlinks for instant rollback.

Only needed on bare-metal Linux deployments — not for k8s or Docker.

## How it works

The orchestrator runs a continuous reconciliation loop:

1. **Watch** — Subscribes to `desired_services` KV changes for immediate response.
2. **Sweep** — Periodically scans all desired services for drift detection.
3. **Reconcile** — For each module, ensures the correct version is downloaded, symlinked as active, and the systemd unit is in the desired running state.

### Versioned installs

Modules are installed into `/opt/tentacle/versions/{moduleId}/{version}/`. A symlink at the active path (e.g., `/opt/tentacle/services/tentacle-mqtt` or `/opt/tentacle/bin/tentacle-snmp`) points to the active version directory. Switching versions is an atomic symlink swap followed by a systemd restart.

### Module registry

The orchestrator manages these modules:

| Module | Runtime | Category |
|---|---|---|
| tentacle-graphql | deno | core |
| tentacle-web | deno-web | core |
| tentacle-ethernetip | go | optional |
| tentacle-opcua | go | optional |
| tentacle-snmp | go | optional |
| tentacle-mqtt | deno | optional |
| tentacle-history | deno | optional |
| tentacle-modbus | deno | optional |
| tentacle-modbus-server | deno | optional |
| tentacle-network | deno | optional |
| tentacle-nftables | deno | optional |

### NATS KV buckets

- **desired_services** — Desired state for each module (version, running)
- **service_status** — Current reconciliation state, installed versions, systemd state (TTL: 2 min)
- **service_heartbeats** — Orchestrator heartbeat (TTL: 60s)
- **service_enabled** — Module enabled flags

### NATS request/reply commands

The orchestrator listens on `tentacle.orchestrator.command` for:

- **get-registry** — Returns the full module registry
- **check-internet** — Tests GitHub API connectivity
- **get-module-versions** — Returns installed, active, and latest versions for a module

### Self-update

When the orchestrator's own entry appears in `desired_services` with a new version, it downloads the update, swaps its symlink, and spawns a script to restart itself via systemd.

### Bootstrap migration

On first boot with an empty KV, the orchestrator scans for pre-existing installs at legacy paths, moves them into the versioned directory structure, creates symlinks, and populates `desired_services` based on current systemd state.

## Configuration

All configuration is via environment variables (or `.env` file):

```
NATS_SERVERS=localhost:4222        # NATS server address
TENTACLE_INSTALL_DIR=/opt/tentacle # Root install directory
TENTACLE_RECONCILE_INTERVAL=30000  # Reconcile sweep interval (ms)
TENTACLE_LATEST_CACHE_TTL=300000   # Cache TTL for "latest" version resolution (ms)
TENTACLE_GH_ORG=joyautomation     # GitHub org for release downloads
TENTACLE_SYSTEMD_DIR=/etc/systemd/system
TENTACLE_NATS_UNIT=tentacle-nats  # Systemd unit name for NATS
```

## Development

### Dev container setup

The project includes scripts to run a dedicated Incus dev container (`tentacle-orchestrator-dev`) with tentacle-orchestrator, tentacle-graphql, and tentacle-web all running in dev mode with hot reload.

```bash
# Create the container (one-time)
./container-setup.sh

# Start all services
./todev.sh start

# View logs
./todev.sh logs
./todev.sh logs tentacle-orchestrator

# Restart a single service
./todev.sh restart tentacle-graphql

# Check status
./todev.sh status

# Open a shell
./todev.sh shell

# Get container IP
./todev.sh ip

# Tear down
./container-setup.sh teardown
```

Edit `dev.yaml` to enable/disable services:

```yaml
services:
  - tentacle-orchestrator
  - tentacle-graphql
  - tentacle-web
```

### Running locally

```bash
deno task dev
```

Requires a running NATS server with JetStream enabled and the `/opt/tentacle` directory structure.

## Project structure

```
main.ts                      # Entry point
types/
  config.ts                  # OrchestratorConfig type, env var loading
  registry.ts                # Static module registry
nats/
  client.ts                  # NATS connection, KV bucket handles
  listener.ts                # Request/reply command handler
  log.ts                     # NATS log streaming
reconciler/
  reconciler.ts              # Main reconciliation loop (watch + sweep)
  download.ts                # GitHub release download, version resolution
  install.ts                 # Version install, symlink management, Deno cache
  systemd.ts                 # Systemd unit generation and control
  migration.ts               # Bootstrap migration for first boot
  self-update.ts             # Self-update mechanism
  status.ts                  # Service status reporting to NATS KV
```
