/**
 * NATS connection and KV bucket handles for the orchestrator
 */

import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-deno";
import type { OrchestratorConfig } from "../types/config.ts";
import type { DesiredServiceKV, ServiceStatusKV, ServiceHeartbeat } from "@joyautomation/nats-schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type NatsClient = {
  nc: NatsConnection;
  desiredServicesKv: KV;
  serviceStatusKv: KV;
  heartbeatsKv: KV;
  serviceEnabledKv: KV;
};

export async function connectToNats(config: OrchestratorConfig): Promise<NatsClient> {
  const nc = await connect({
    servers: config.nats.servers,
    user: config.nats.user,
    pass: config.nats.pass,
    token: config.nats.token,
  });

  const js = jetstream(nc);
  const kvm = new Kvm(js);

  const desiredServicesKv = await kvm.create("desired_services", {
    history: 1,
    ttl: 0,
  });

  const serviceStatusKv = await kvm.create("service_status", {
    history: 1,
    ttl: 120 * 1000, // 2 minutes
  });

  const heartbeatsKv = await kvm.create("service_heartbeats", {
    history: 1,
    ttl: 60 * 1000,
  });

  const serviceEnabledKv = await kvm.create("service_enabled", {
    history: 1,
    ttl: 0,
  });

  return { nc, desiredServicesKv, serviceStatusKv, heartbeatsKv, serviceEnabledKv };
}

// ─── Desired Services ────────────────────────────────────────────────────────

export async function getAllDesiredServices(kv: KV): Promise<DesiredServiceKV[]> {
  const results: DesiredServiceKV[] = [];
  try {
    const keys = await kv.keys();
    for await (const key of keys) {
      try {
        const entry = await kv.get(key);
        if (entry?.value) {
          results.push(JSON.parse(decoder.decode(entry.value)) as DesiredServiceKV);
        }
      } catch { /* expired or invalid */ }
    }
  } catch { /* bucket may not exist */ }
  return results;
}

export async function getDesiredService(kv: KV, moduleId: string): Promise<DesiredServiceKV | null> {
  try {
    const entry = await kv.get(moduleId);
    if (entry?.value) {
      return JSON.parse(decoder.decode(entry.value)) as DesiredServiceKV;
    }
  } catch { /* key doesn't exist */ }
  return null;
}

export async function putDesiredService(kv: KV, desired: DesiredServiceKV): Promise<void> {
  await kv.put(desired.moduleId, encoder.encode(JSON.stringify(desired)));
}

// ─── Service Status ──────────────────────────────────────────────────────────

export async function putServiceStatus(kv: KV, status: ServiceStatusKV): Promise<void> {
  await kv.put(status.moduleId, encoder.encode(JSON.stringify(status)));
}

export async function getAllServiceStatuses(kv: KV): Promise<ServiceStatusKV[]> {
  const results: ServiceStatusKV[] = [];
  try {
    const keys = await kv.keys();
    for await (const key of keys) {
      try {
        const entry = await kv.get(key);
        if (entry?.value) {
          results.push(JSON.parse(decoder.decode(entry.value)) as ServiceStatusKV);
        }
      } catch { /* expired or invalid */ }
    }
  } catch { /* bucket may not exist */ }
  return results;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

export async function publishHeartbeat(kv: KV, startedAt: number, metadata?: Record<string, unknown>): Promise<void> {
  const heartbeat: ServiceHeartbeat = {
    serviceType: "orchestrator",
    moduleId: "orchestrator",
    lastSeen: Date.now(),
    startedAt,
    metadata,
  };
  await kv.put("orchestrator", encoder.encode(JSON.stringify(heartbeat)));
}
