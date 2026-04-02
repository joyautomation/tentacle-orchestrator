/**
 * tentacle-orchestrator — bare-metal service orchestrator
 *
 * Watches desired_services NATS KV and reconciles with systemd.
 * Manages versions via symlinks for instant rollback.
 * Only needed on bare-metal Linux deployments (not k8s/docker).
 */

import { createLogger, LogLevel } from "@joyautomation/coral";
import { loadConfig } from "./types/config.ts";
import { connectToNats, publishHeartbeat } from "./nats/client.ts";
import { createNatsLogger } from "./nats/log.ts";
import { runMigration } from "./reconciler/migration.ts";
import { startReconciler } from "./reconciler/reconciler.ts";
import { startCommandListener } from "./nats/listener.ts";

let log = createLogger("orchestrator", LogLevel.info);

async function main() {
  try {
    log.info("=== tentacle-orchestrator: Bare-Metal Service Orchestrator ===");

    // Load config
    const config = loadConfig();
    log.info(`NATS Servers: ${Array.isArray(config.nats.servers) ? config.nats.servers.join(", ") : config.nats.servers}`);
    log.info(`Install dir: ${config.installDir}`);
    log.info(`Reconcile interval: ${config.reconcileIntervalMs}ms`);

    // Connect to NATS
    const nats = await connectToNats(config);
    log.info("Connected to NATS");

    // Enable NATS log streaming
    log = createNatsLogger(log, nats.nc, "orchestrator");

    // Ensure directories exist
    await Deno.mkdir(config.versionsDir, { recursive: true });
    await Deno.mkdir(`${config.cacheDir}/deno/versions`, { recursive: true });

    // Run bootstrap migration if needed (first boot)
    await runMigration(nats.desiredServicesKv, config, log);

    // Start heartbeat
    const startedAt = Date.now();
    await publishHeartbeat(nats.heartbeatsKv, startedAt, {
      reconcileIntervalMs: config.reconcileIntervalMs,
    });
    const heartbeatInterval = setInterval(async () => {
      try {
        await publishHeartbeat(nats.heartbeatsKv, startedAt, {
          reconcileIntervalMs: config.reconcileIntervalMs,
        });
      } catch (err) {
        log.warn(`Failed to publish heartbeat: ${err}`);
      }
    }, 10000);
    log.info("Service heartbeat started (moduleId: orchestrator)");

    // Start command listener (request/reply for registry, internet check, versions)
    const commandListener = startCommandListener(nats.nc, config, log);

    // Start the reconciliation loop
    const reconciler = startReconciler({
      desiredServicesKv: nats.desiredServicesKv,
      serviceStatusKv: nats.serviceStatusKv,
      config,
      log,
    });
    log.info("Reconciler started");

    // Shutdown handler
    const shutdown = async () => {
      log.info("Shutting down...");
      commandListener.stop();
      reconciler.stop();
      clearInterval(heartbeatInterval);
      await nats.nc.close();
      log.info("Goodbye!");
      Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    log.info("Orchestrator running. Press Ctrl+C to stop.");
  } catch (error) {
    log.error("Fatal error:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
