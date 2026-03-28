/**
 * Service status reporting — writes ServiceStatusKV to NATS KV
 */

import type { KV } from "@nats-io/kv";
import type { ServiceStatusKV, ReconcileState } from "@joyautomation/nats-schema";
import type { ModuleRegistryEntry } from "../types/registry.ts";
import type { SystemdState } from "./systemd.ts";
import { putServiceStatus } from "../nats/client.ts";

/** Build and publish a ServiceStatusKV entry */
export async function reportStatus(
  kv: KV,
  entry: ModuleRegistryEntry,
  opts: {
    installedVersions: string[];
    activeVersion: string | null;
    systemdState: SystemdState;
    reconcileState: ReconcileState;
    lastError: string | null;
  },
): Promise<void> {
  const status: ServiceStatusKV = {
    moduleId: entry.moduleId,
    installedVersions: opts.installedVersions,
    activeVersion: opts.activeVersion,
    systemdState: normalizeSystemdState(opts.systemdState),
    reconcileState: opts.reconcileState,
    lastError: opts.lastError,
    runtime: entry.runtime,
    category: entry.category,
    repo: entry.repo,
    updatedAt: Date.now(),
  };
  await putServiceStatus(kv, status);
}

/** Normalize systemd states to the subset we store in KV */
function normalizeSystemdState(state: SystemdState): "active" | "inactive" | "failed" | "not-found" {
  switch (state) {
    case "active":
    case "inactive":
    case "failed":
    case "not-found":
      return state;
    case "activating":
      return "active";
    case "deactivating":
      return "inactive";
    default:
      return "not-found";
  }
}
