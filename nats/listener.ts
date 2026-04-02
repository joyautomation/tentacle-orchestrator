/**
 * NATS request/reply listener for orchestrator commands.
 * Handles: get-registry, check-internet, get-module-versions
 */

import type { Log } from "@joyautomation/coral";
import type { NatsConnection, Subscription } from "@nats-io/transport-deno";
import type { OrchestratorConfig } from "../types/config.ts";
import type {
  OrchestratorCommandRequest,
  OrchestratorCommandResponse,
  ModuleRegistryInfo,
  ModuleVersionInfo,
} from "@joyautomation/nats-schema";
import { NATS_TOPICS } from "@joyautomation/nats-schema";
import { MODULE_REGISTRY, getRegistryEntry } from "../types/registry.ts";
import { checkInternet, resolveLatestVersion } from "../reconciler/download.ts";
import { listInstalledVersions, getActiveVersion } from "../reconciler/install.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function respond(data: OrchestratorCommandResponse): Uint8Array {
  return encoder.encode(JSON.stringify(data));
}

async function handleGetRegistry(
  requestId: string,
): Promise<OrchestratorCommandResponse> {
  const modules: ModuleRegistryInfo[] = MODULE_REGISTRY.map((m) => ({
    moduleId: m.moduleId,
    repo: m.repo,
    description: m.description,
    category: m.category,
    runtime: m.runtime,
  }));
  return {
    requestId,
    success: true,
    modules,
    timestamp: Date.now(),
  };
}

async function handleCheckInternet(
  requestId: string,
): Promise<OrchestratorCommandResponse> {
  const online = await checkInternet();
  return {
    requestId,
    success: true,
    online,
    timestamp: Date.now(),
  };
}

async function handleGetModuleVersions(
  requestId: string,
  moduleId: string | undefined,
  config: OrchestratorConfig,
  log: Log,
): Promise<OrchestratorCommandResponse> {
  if (!moduleId) {
    return {
      requestId,
      success: false,
      error: "moduleId is required for get-module-versions",
      timestamp: Date.now(),
    };
  }

  const entry = getRegistryEntry(moduleId);
  if (!entry) {
    return {
      requestId,
      success: false,
      error: `Unknown module: ${moduleId}`,
      timestamp: Date.now(),
    };
  }

  const [installedVersions, activeVersion, latestVersion] = await Promise.all([
    listInstalledVersions(moduleId, config),
    getActiveVersion(entry, config),
    resolveLatestVersion(entry, config, log),
  ]);

  const versions: ModuleVersionInfo = {
    moduleId,
    installedVersions,
    latestVersion,
    activeVersion,
  };

  return {
    requestId,
    success: true,
    versions,
    timestamp: Date.now(),
  };
}

/**
 * Start the NATS request/reply listener for orchestrator commands.
 * Returns a cleanup function to unsubscribe.
 */
export function startCommandListener(
  nc: NatsConnection,
  config: OrchestratorConfig,
  log: Log,
): { stop: () => void } {
  const sub: Subscription = nc.subscribe(NATS_TOPICS.orchestrator.command);

  log.info(`Listening on ${NATS_TOPICS.orchestrator.command}`);

  // Process messages in background
  (async () => {
    for await (const msg of sub) {
      try {
        const request: OrchestratorCommandRequest = JSON.parse(
          decoder.decode(msg.data),
        );

        let response: OrchestratorCommandResponse;

        switch (request.action) {
          case "get-registry":
            response = await handleGetRegistry(request.requestId);
            break;
          case "check-internet":
            response = await handleCheckInternet(request.requestId);
            break;
          case "get-module-versions":
            response = await handleGetModuleVersions(
              request.requestId,
              request.moduleId,
              config,
              log,
            );
            break;
          default:
            response = {
              requestId: request.requestId,
              success: false,
              error: `Unknown action: ${(request as OrchestratorCommandRequest).action}`,
              timestamp: Date.now(),
            };
        }

        msg.respond(respond(response));
      } catch (err) {
        log.warn(`Error handling orchestrator command: ${err}`);
        try {
          msg.respond(
            respond({
              requestId: "unknown",
              success: false,
              error: String(err),
              timestamp: Date.now(),
            }),
          );
        } catch {
          // Can't respond, message may have timed out
        }
      }
    }
  })();

  return {
    stop: () => {
      sub.unsubscribe();
      log.info("Orchestrator command listener stopped");
    },
  };
}
