/**
 * Reconciliation loop — watches desired_services KV and periodically sweeps
 * to ensure actual state matches desired state.
 */

import type { Log } from "@joyautomation/coral";
import type { KV } from "@nats-io/kv";
import type { DesiredServiceKV } from "@joyautomation/nats-schema";
import type { OrchestratorConfig } from "../types/config.ts";
import { getRegistryEntry } from "../types/registry.ts";
import { getAllDesiredServices } from "../nats/client.ts";
import { getSystemdState, systemctlStart, systemctlStop, systemctlDaemonReload, systemctlEnable, writeSystemdUnit } from "./systemd.ts";
import { resolveVersion, checkInternet } from "./download.ts";
import { isVersionInstalled, installVersion, getActiveVersion, listInstalledVersions, updateSymlink } from "./install.ts";
import { reportStatus } from "./status.ts";
import { selfUpdate } from "./self-update.ts";

const SELF_MODULE_ID = "tentacle-orchestrator";

export type ReconcilerContext = {
  desiredServicesKv: KV;
  serviceStatusKv: KV;
  config: OrchestratorConfig;
  log: Log;
};

/**
 * Reconcile a single module: ensure installed version, symlink, and systemd state
 * match the desired state.
 */
async function reconcileModule(
  desired: DesiredServiceKV,
  ctx: ReconcilerContext,
): Promise<void> {
  const { config, log } = ctx;
  const entry = getRegistryEntry(desired.moduleId);

  if (!entry) {
    log.warn(`Unknown module in desired_services: ${desired.moduleId}`);
    return;
  }

  // Self-update is handled specially
  if (desired.moduleId === SELF_MODULE_ID) {
    const currentVersion = await getActiveVersion(
      { ...entry, repo: "tentacle-orchestrator", runtime: "deno" },
      config,
    );
    const resolvedVersion = await resolveVersion(entry, desired.version, config, log);

    if (resolvedVersion && resolvedVersion !== currentVersion) {
      log.info(`Self-update requested: ${currentVersion} → ${resolvedVersion}`);
      await selfUpdate(resolvedVersion, config, log);
    }
    return;
  }

  // Step 1: Resolve version
  const resolvedVersion = await resolveVersion(entry, desired.version, config, log);
  if (!resolvedVersion) {
    await reportStatus(ctx.serviceStatusKv, entry, {
      installedVersions: await listInstalledVersions(entry.moduleId, config),
      activeVersion: await getActiveVersion(entry, config),
      systemdState: await getSystemdState(entry.moduleId),
      reconcileState: "version_unavailable",
      lastError: `Cannot resolve version "${desired.version}" (offline?)`,
    });
    return;
  }

  // Step 2: Ensure version is installed on disk
  if (!await isVersionInstalled(entry.moduleId, resolvedVersion, config)) {
    // Check internet before attempting download
    const online = await checkInternet();
    if (!online) {
      await reportStatus(ctx.serviceStatusKv, entry, {
        installedVersions: await listInstalledVersions(entry.moduleId, config),
        activeVersion: await getActiveVersion(entry, config),
        systemdState: await getSystemdState(entry.moduleId),
        reconcileState: "version_unavailable",
        lastError: `Version ${resolvedVersion} not installed and no internet`,
      });
      return;
    }

    await reportStatus(ctx.serviceStatusKv, entry, {
      installedVersions: await listInstalledVersions(entry.moduleId, config),
      activeVersion: await getActiveVersion(entry, config),
      systemdState: await getSystemdState(entry.moduleId),
      reconcileState: "downloading",
      lastError: null,
    });

    const ok = await installVersion(entry, resolvedVersion, config, log);
    if (!ok) {
      await reportStatus(ctx.serviceStatusKv, entry, {
        installedVersions: await listInstalledVersions(entry.moduleId, config),
        activeVersion: await getActiveVersion(entry, config),
        systemdState: await getSystemdState(entry.moduleId),
        reconcileState: "error",
        lastError: `Failed to download/install ${resolvedVersion}`,
      });
      return;
    }
  }

  // Step 3: Ensure correct version is active (symlinked)
  const currentActiveVersion = await getActiveVersion(entry, config);
  if (currentActiveVersion !== resolvedVersion) {
    await reportStatus(ctx.serviceStatusKv, entry, {
      installedVersions: await listInstalledVersions(entry.moduleId, config),
      activeVersion: currentActiveVersion,
      systemdState: await getSystemdState(entry.moduleId),
      reconcileState: "installing",
      lastError: null,
    });

    // Stop service if running before switching
    const currentState = await getSystemdState(entry.moduleId);
    if (currentState === "active") {
      await systemctlStop(entry.moduleId, log);
    }

    // Update symlink
    const symlinkOk = await updateSymlink(entry, resolvedVersion, config, log);
    if (!symlinkOk) {
      await reportStatus(ctx.serviceStatusKv, entry, {
        installedVersions: await listInstalledVersions(entry.moduleId, config),
        activeVersion: currentActiveVersion,
        systemdState: await getSystemdState(entry.moduleId),
        reconcileState: "error",
        lastError: "Failed to update symlink",
      });
      return;
    }

    // Regenerate systemd unit (DENO_DIR path changes per version)
    await writeSystemdUnit(entry, resolvedVersion, config, log);
    await systemctlDaemonReload(log);
    await systemctlEnable(entry.moduleId, log);
  }

  // Step 4: Ensure running state matches desired
  const systemdState = await getSystemdState(entry.moduleId);

  if (desired.running && systemdState !== "active") {
    await reportStatus(ctx.serviceStatusKv, entry, {
      installedVersions: await listInstalledVersions(entry.moduleId, config),
      activeVersion: resolvedVersion,
      systemdState,
      reconcileState: "starting",
      lastError: null,
    });

    await systemctlStart(entry.moduleId, log);
  } else if (!desired.running && systemdState === "active") {
    await reportStatus(ctx.serviceStatusKv, entry, {
      installedVersions: await listInstalledVersions(entry.moduleId, config),
      activeVersion: resolvedVersion,
      systemdState,
      reconcileState: "stopping",
      lastError: null,
    });

    await systemctlStop(entry.moduleId, log);
  }

  // Final status report
  await reportStatus(ctx.serviceStatusKv, entry, {
    installedVersions: await listInstalledVersions(entry.moduleId, config),
    activeVersion: resolvedVersion,
    systemdState: await getSystemdState(entry.moduleId),
    reconcileState: "ok",
    lastError: null,
  });
}

/**
 * Run a full reconciliation sweep — reads all desired_services entries
 * and reconciles each one.
 */
async function fullSweep(ctx: ReconcilerContext): Promise<void> {
  const desired = await getAllDesiredServices(ctx.desiredServicesKv);
  ctx.log.info(`Reconcile sweep: ${desired.length} desired services`);

  for (const d of desired) {
    try {
      await reconcileModule(d, ctx);
    } catch (err) {
      ctx.log.error(`Reconcile error for ${d.moduleId}: ${err}`);
    }
  }
}

/**
 * Start the reconciliation loop:
 * 1. KV watch for immediate response to changes
 * 2. Periodic sweep for drift detection
 *
 * Returns a cleanup function to stop the loop.
 */
export function startReconciler(ctx: ReconcilerContext): { stop: () => void } {
  const { desiredServicesKv, config, log } = ctx;
  let stopped = false;

  // Periodic sweep
  const sweepInterval = setInterval(async () => {
    if (stopped) return;
    try {
      await fullSweep(ctx);
    } catch (err) {
      log.error(`Sweep error: ${err}`);
    }
  }, config.reconcileIntervalMs);

  // KV watch for reactive reconciliation
  const startWatch = async () => {
    try {
      const watcher = await desiredServicesKv.watch();
      for await (const entry of watcher) {
        if (stopped) break;
        if (entry === null) continue;

        // On any change, reconcile the affected module
        const key = entry.key;
        if (entry.operation === "DEL" || entry.operation === "PURGE") {
          log.info(`Module removed from desired_services: ${key}`);
          // Could stop the service here — for now just log
          continue;
        }

        if (entry.value) {
          try {
            const desired = JSON.parse(new TextDecoder().decode(entry.value)) as DesiredServiceKV;
            log.info(`Desired state changed: ${desired.moduleId} → version=${desired.version}, running=${desired.running}`);
            await reconcileModule(desired, ctx);
          } catch (err) {
            log.error(`Failed to reconcile ${key}: ${err}`);
          }
        }
      }
    } catch (err) {
      if (!stopped) {
        log.error(`KV watch error: ${err}`);
        // Retry after a delay
        setTimeout(startWatch, 5000);
      }
    }
  };
  startWatch();

  // Initial sweep
  fullSweep(ctx).catch((err) => log.error(`Initial sweep error: ${err}`));

  return {
    stop: () => {
      stopped = true;
      clearInterval(sweepInterval);
    },
  };
}
