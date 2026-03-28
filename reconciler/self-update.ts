/**
 * Self-update — the orchestrator can download a new version of itself,
 * then spawn a shell script to swap the symlink and restart via systemd.
 */

import type { Log } from "@joyautomation/coral";
import type { OrchestratorConfig } from "../types/config.ts";
import { installVersion, updateSymlink, isVersionInstalled } from "./install.ts";

const SELF_MODULE_ID = "tentacle-orchestrator";

const SELF_ENTRY = {
  repo: "tentacle-orchestrator",
  moduleId: SELF_MODULE_ID,
  description: "Service orchestrator",
  category: "core" as const,
  runtime: "deno" as const,
};

/**
 * Perform a self-update. Downloads the new version, writes an updater script,
 * and executes it (fire-and-forget). The script swaps the symlink and restarts
 * the orchestrator via systemd.
 */
export async function selfUpdate(
  version: string,
  config: OrchestratorConfig,
  log: Log,
): Promise<boolean> {
  // Download the new version if not already present
  if (!await isVersionInstalled(SELF_MODULE_ID, version, config)) {
    log.info(`Downloading orchestrator v${version}...`);
    const ok = await installVersion(SELF_ENTRY, version, config, log);
    if (!ok) {
      log.error(`Failed to download orchestrator v${version}`);
      return false;
    }
  }

  // Update the symlink
  const symlinkOk = await updateSymlink(SELF_ENTRY, version, config, log);
  if (!symlinkOk) {
    log.error("Failed to update orchestrator symlink");
    return false;
  }

  // Write and execute an updater script that restarts us via systemd
  const scriptPath = `${config.binDir}/update-orchestrator.sh`;
  const script = `#!/bin/bash
set -e
sleep 1
systemctl daemon-reload
systemctl restart tentacle-tentacle-orchestrator.service
rm -f "$0"
`;

  try {
    await Deno.writeTextFile(scriptPath, script);
    await Deno.chmod(scriptPath, 0o755);

    log.info(`Self-update to v${version}: spawning restart script...`);

    // Fire-and-forget
    const proc = new Deno.Command("bash", {
      args: [scriptPath],
      stdout: "null",
      stderr: "null",
      stdin: "null",
    });
    proc.spawn();

    return true;
  } catch (err) {
    log.error(`Failed to execute self-update script: ${err}`);
    return false;
  }
}
