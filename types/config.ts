/**
 * Configuration for the orchestrator, loaded from environment variables.
 */

export type OrchestratorConfig = {
  nats: {
    servers: string | string[];
    user?: string;
    pass?: string;
    token?: string;
  };
  installDir: string;
  binDir: string;
  servicesDir: string;
  versionsDir: string;
  cacheDir: string;
  configDir: string;
  systemdDir: string;
  /** Systemd unit name for NATS (without .service suffix) */
  natsUnitName: string;
  ghOrg: string;
  /** Reconcile interval in milliseconds */
  reconcileIntervalMs: number;
  /** How long to cache "latest" version resolution (ms) */
  latestCacheTtlMs: number;
};

export function loadConfig(): OrchestratorConfig {
  const installDir = Deno.env.get("TENTACLE_INSTALL_DIR") || "/opt/tentacle";

  return {
    nats: {
      servers: Deno.env.get("NATS_SERVERS") || "localhost:4222",
      user: Deno.env.get("NATS_USER"),
      pass: Deno.env.get("NATS_PASS"),
      token: Deno.env.get("NATS_TOKEN"),
    },
    installDir,
    binDir: `${installDir}/bin`,
    servicesDir: `${installDir}/services`,
    versionsDir: `${installDir}/versions`,
    cacheDir: `${installDir}/cache`,
    configDir: `${installDir}/config`,
    systemdDir: Deno.env.get("TENTACLE_SYSTEMD_DIR") || "/etc/systemd/system",
    natsUnitName: Deno.env.get("TENTACLE_NATS_UNIT") || "tentacle-nats",
    ghOrg: Deno.env.get("TENTACLE_GH_ORG") || "joyautomation",
    reconcileIntervalMs: parseInt(Deno.env.get("TENTACLE_RECONCILE_INTERVAL") || "30000"),
    latestCacheTtlMs: parseInt(Deno.env.get("TENTACLE_LATEST_CACHE_TTL") || "300000"),
  };
}
