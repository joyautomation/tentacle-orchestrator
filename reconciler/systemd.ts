/**
 * Systemd interaction layer — start/stop/status/unit-file generation
 */

import type { Log } from "@joyautomation/coral";
import type { OrchestratorConfig } from "../types/config.ts";
import type { ModuleRegistryEntry } from "../types/registry.ts";
import { findDeno } from "./install.ts";

export type SystemdState = "active" | "inactive" | "failed" | "not-found" | "activating" | "deactivating";

/** Run a command and return { success, stdout, stderr } */
async function run(cmd: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

/** Get the systemd unit name for a module (moduleId already includes "tentacle-" prefix) */
export function unitName(moduleId: string): string {
  return `${moduleId}.service`;
}

/** Check if a systemd unit is active */
export async function getSystemdState(moduleId: string): Promise<SystemdState> {
  const result = await run(["systemctl", "is-active", unitName(moduleId)]);
  const state = result.stdout;
  switch (state) {
    case "active":
    case "inactive":
    case "failed":
    case "activating":
    case "deactivating":
      return state as SystemdState;
    default:
      return "not-found";
  }
}

/** Start a systemd unit */
export async function systemctlStart(moduleId: string, log: Log): Promise<boolean> {
  log.info(`Starting ${unitName(moduleId)}...`);
  const result = await run(["systemctl", "start", unitName(moduleId)]);
  if (!result.success) {
    log.error(`Failed to start ${unitName(moduleId)}: ${result.stderr}`);
  }
  return result.success;
}

/** Stop a systemd unit */
export async function systemctlStop(moduleId: string, log: Log): Promise<boolean> {
  log.info(`Stopping ${unitName(moduleId)}...`);
  const result = await run(["systemctl", "stop", unitName(moduleId)]);
  if (!result.success) {
    log.error(`Failed to stop ${unitName(moduleId)}: ${result.stderr}`);
  }
  return result.success;
}

/** Reload systemd daemon (after writing/updating unit files) */
export async function systemctlDaemonReload(log: Log): Promise<boolean> {
  log.info("Reloading systemd daemon...");
  const result = await run(["systemctl", "daemon-reload"]);
  if (!result.success) {
    log.error(`Failed to reload systemd: ${result.stderr}`);
  }
  return result.success;
}

/** Enable a systemd unit */
export async function systemctlEnable(moduleId: string, log: Log): Promise<boolean> {
  const result = await run(["systemctl", "enable", unitName(moduleId)]);
  if (!result.success) {
    log.warn(`Failed to enable ${unitName(moduleId)}: ${result.stderr}`);
  }
  return result.success;
}

/**
 * Generate and write a systemd unit file for a module.
 *
 * Deno services: ExecStart = /opt/tentacle/bin/deno run -A main.ts
 *                WorkingDirectory = /opt/tentacle/services/{repo}
 *                DENO_DIR = /opt/tentacle/cache/deno/versions/{moduleId}/{version}
 *
 * Go services:   ExecStart = /opt/tentacle/bin/{moduleId}
 *
 * deno-web:      ExecStart = /opt/tentacle/bin/deno run -A build/index.js
 *                WorkingDirectory = /opt/tentacle/services/{repo}
 */
export async function writeSystemdUnit(
  entry: ModuleRegistryEntry,
  version: string,
  config: OrchestratorConfig,
  log: Log,
): Promise<boolean> {
  const unitPath = `${config.systemdDir}/${unitName(entry.moduleId)}`;
  const envFile = `${config.configDir}/tentacle.env`;
  const natsUnit = config.natsUnitName;

  // Dependencies
  const after = entry.moduleId === "tentacle-web"
    ? "tentacle-graphql.service"
    : `${natsUnit}.service`;
  const requires = `${natsUnit}.service`;

  let execStart: string;
  let workingDir = "";
  let denoDir = "";
  const denoPath = await findDeno(config);

  switch (entry.runtime) {
    case "go":
      execStart = `${config.binDir}/${entry.moduleId}`;
      break;
    case "deno":
      execStart = `${denoPath} run -A main.ts`;
      workingDir = `${config.servicesDir}/${entry.repo}`;
      denoDir = `${config.cacheDir}/deno/versions/${entry.moduleId}/${version}`;
      break;
    case "deno-web":
      execStart = `${denoPath} run -A build/index.js`;
      workingDir = `${config.servicesDir}/${entry.repo}`;
      denoDir = `${config.cacheDir}/deno/versions/${entry.moduleId}/${version}`;
      break;
    default:
      log.error(`Unknown runtime ${entry.runtime} for ${entry.moduleId}`);
      return false;
  }

  // Build environment lines
  const envLines: string[] = [];
  if (denoDir) envLines.push(`Environment=DENO_DIR=${denoDir}`);
  if (entry.extraEnv) envLines.push(`Environment=${entry.extraEnv}`);

  const unit = `[Unit]
Description=Tentacle ${entry.moduleId}
After=${after}
Requires=${requires}

[Service]
Type=simple
EnvironmentFile=${envFile}
${envLines.join("\n")}${workingDir ? `\nWorkingDirectory=${workingDir}` : ""}
ExecStart=${execStart}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${entry.moduleId}

[Install]
WantedBy=multi-user.target
`;

  try {
    await Deno.writeTextFile(unitPath, unit);
    log.info(`Wrote systemd unit: ${unitPath}`);
    return true;
  } catch (err) {
    log.error(`Failed to write systemd unit ${unitPath}: ${err}`);
    return false;
  }
}
