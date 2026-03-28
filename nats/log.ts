/**
 * NATS log streaming — wraps a coral logger to also publish log entries to NATS
 */

import type { Log } from "@joyautomation/coral";
import type { NatsConnection } from "@nats-io/transport-deno";
import type { ServiceLogEntry } from "@joyautomation/nats-schema";

const SERVICE_TYPE = "orchestrator";
const MODULE_ID = "orchestrator";

export function createNatsLogger(
  coralLog: Log,
  nc: NatsConnection,
  loggerName: string,
): Log {
  const subject = `service.logs.${SERVICE_TYPE}.${MODULE_ID}`;
  const encoder = new TextEncoder();

  const formatArgs = (args: unknown[]): string =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  const publish = (level: string, msg: string, ...args: unknown[]) => {
    try {
      const message = args.length > 0 ? `${msg} ${formatArgs(args)}` : msg;
      const entry: ServiceLogEntry = {
        timestamp: Date.now(),
        level: level as ServiceLogEntry["level"],
        message,
        serviceType: SERVICE_TYPE,
        moduleId: MODULE_ID,
        logger: loggerName,
      };
      nc.publish(subject, encoder.encode(JSON.stringify(entry)));
    } catch { /* never break the service for logging */ }
  };

  return {
    info: (m: string, ...a: unknown[]) => { coralLog.info(m, ...a); publish("info", m, ...a); },
    warn: (m: string, ...a: unknown[]) => { coralLog.warn(m, ...a); publish("warn", m, ...a); },
    error: (m: string, ...a: unknown[]) => { coralLog.error(m, ...a); publish("error", m, ...a); },
    debug: (m: string, ...a: unknown[]) => { coralLog.debug(m, ...a); publish("debug", m, ...a); },
  } as Log;
}
