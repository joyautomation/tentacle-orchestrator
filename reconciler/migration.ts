/**
 * Bootstrap migration — adopts existing installs into orchestrator management.
 *
 * On first boot with an empty desired_services KV, the orchestrator:
 * 1. Scans /opt/tentacle/bin/ and /opt/tentacle/services/ for installed modules
 * 2. Moves them into /opt/tentacle/versions/{moduleId}/unknown/
 * 3. Creates symlinks from the original paths
 * 4. Populates desired_services KV with { version: "unknown", running: <systemd state> }
 * 5. Writes a marker file to prevent re-migration
 */

import type { Log } from "@joyautomation/coral";
import type { KV } from "@nats-io/kv";
import type { OrchestratorConfig } from "../types/config.ts";
import { MODULE_REGISTRY, type ModuleRegistryEntry } from "../types/registry.ts";
import { getSystemdState } from "./systemd.ts";
import { putDesiredService } from "../nats/client.ts";
import type { DesiredServiceKV } from "@joyautomation/nats-schema";

const MIGRATION_MARKER = ".orchestrator-migrated";

/** Check if migration has already been performed */
export async function isMigrated(config: OrchestratorConfig): Promise<boolean> {
  try {
    await Deno.stat(`${config.configDir}/${MIGRATION_MARKER}`);
    return true;
  } catch {
    return false;
  }
}

/** Write the migration marker file */
async function writeMigrationMarker(config: OrchestratorConfig): Promise<void> {
  await Deno.writeTextFile(
    `${config.configDir}/${MIGRATION_MARKER}`,
    `Migrated at ${new Date().toISOString()}\n`,
  );
}

/** Check if a module is installed at its legacy (non-versioned) path */
async function isLegacyInstalled(entry: ModuleRegistryEntry, config: OrchestratorConfig): Promise<boolean> {
  if (entry.runtime === "go") {
    try {
      const stat = await Deno.lstat(`${config.binDir}/${entry.moduleId}`);
      // If it's already a symlink, it's been migrated
      return stat.isFile;
    } catch {
      return false;
    }
  } else {
    try {
      const stat = await Deno.lstat(`${config.servicesDir}/${entry.repo}`);
      // If it's already a symlink, it's been migrated
      return stat.isDirectory;
    } catch {
      return false;
    }
  }
}

/**
 * Run the bootstrap migration for a single module.
 * Moves files from legacy path to versions/{moduleId}/unknown/ and creates a symlink.
 */
async function migrateModule(
  entry: ModuleRegistryEntry,
  config: OrchestratorConfig,
  log: Log,
): Promise<boolean> {
  const versionDir = `${config.versionsDir}/${entry.moduleId}/unknown`;
  await Deno.mkdir(versionDir, { recursive: true });

  if (entry.runtime === "go") {
    const legacyPath = `${config.binDir}/${entry.moduleId}`;
    const newPath = `${versionDir}/${entry.moduleId}`;

    try {
      // Move binary to versioned location
      await Deno.rename(legacyPath, newPath);
      // Create symlink
      await Deno.symlink(newPath, legacyPath);
      log.info(`Migrated ${entry.moduleId}: ${legacyPath} → ${newPath}`);
      return true;
    } catch (err) {
      log.error(`Failed to migrate ${entry.moduleId}: ${err}`);
      return false;
    }
  } else {
    const legacyPath = `${config.servicesDir}/${entry.repo}`;
    try {
      // Move directory to versioned location
      await Deno.rename(legacyPath, versionDir);
      // Create symlink
      await Deno.symlink(versionDir, legacyPath);
      log.info(`Migrated ${entry.moduleId}: ${legacyPath} → ${versionDir}`);
      return true;
    } catch (err) {
      log.error(`Failed to migrate ${entry.moduleId}: ${err}`);
      return false;
    }
  }
}

/**
 * Run the full bootstrap migration.
 * Scans for installed modules, migrates them to versioned storage,
 * and populates desired_services KV.
 */
export async function runMigration(
  desiredServicesKv: KV,
  config: OrchestratorConfig,
  log: Log,
): Promise<void> {
  if (await isMigrated(config)) {
    log.debug("Already migrated, skipping bootstrap");
    return;
  }

  log.info("Running bootstrap migration...");
  let migrated = 0;

  for (const entry of MODULE_REGISTRY) {
    const installed = await isLegacyInstalled(entry, config);
    if (!installed) continue;

    const ok = await migrateModule(entry, config, log);
    if (!ok) continue;

    // Check systemd state and populate desired_services
    const state = await getSystemdState(entry.moduleId);
    const running = state === "active";

    const desired: DesiredServiceKV = {
      moduleId: entry.moduleId,
      version: "unknown",
      running,
      updatedAt: Date.now(),
    };
    await putDesiredService(desiredServicesKv, desired);
    log.info(`Populated desired_services: ${entry.moduleId} → version=unknown, running=${running}`);
    migrated++;
  }

  await writeMigrationMarker(config);
  log.info(`Bootstrap migration complete: ${migrated} modules adopted`);
}
