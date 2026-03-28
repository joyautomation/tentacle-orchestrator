/**
 * Static module registry — mirrors install.sh's MODULES array.
 * The orchestrator uses this to know how to download, install, and
 * create systemd units for each module.
 */

import type { ModuleRuntime, ModuleCategory } from "@joyautomation/nats-schema";

export type ModuleRegistryEntry = {
  /** GitHub repo name (e.g., "tentacle-mqtt") */
  repo: string;
  /** Asset/service name used in systemd, bin dir, etc. (e.g., "tentacle-mqtt") */
  moduleId: string;
  /** Human-readable description */
  description: string;
  /** Core or optional */
  category: ModuleCategory;
  /** Runtime type determines download/install/systemd behavior */
  runtime: ModuleRuntime;
  /** Extra systemd Environment lines (e.g., PKI dir for opcua) */
  extraEnv?: string;
};

export const MODULE_REGISTRY: ModuleRegistryEntry[] = [
  {
    repo: "tentacle-graphql",
    moduleId: "tentacle-graphql",
    description: "GraphQL API gateway",
    category: "core",
    runtime: "deno",
  },
  {
    repo: "tentacle-web",
    moduleId: "tentacle-web",
    description: "Web dashboard",
    category: "core",
    runtime: "deno-web",
  },
  {
    repo: "tentacle-ethernetip-go",
    moduleId: "tentacle-ethernetip",
    description: "EtherNet/IP scanner (Allen-Bradley, etc.)",
    category: "optional",
    runtime: "go",
  },
  {
    repo: "tentacle-opcua-go",
    moduleId: "tentacle-opcua",
    description: "OPC UA client",
    category: "optional",
    runtime: "go",
    extraEnv: "OPCUA_PKI_DIR=/opt/tentacle/data/opcua/pki",
  },
  {
    repo: "tentacle-snmp",
    moduleId: "tentacle-snmp",
    description: "SNMP scanner & trap listener",
    category: "optional",
    runtime: "go",
  },
  {
    repo: "tentacle-mqtt",
    moduleId: "tentacle-mqtt",
    description: "MQTT Sparkplug B bridge",
    category: "optional",
    runtime: "deno",
  },
  {
    repo: "tentacle-history",
    moduleId: "tentacle-history",
    description: "Edge historian (TimescaleDB)",
    category: "optional",
    runtime: "deno",
  },
  {
    repo: "tentacle-modbus",
    moduleId: "tentacle-modbus",
    description: "Modbus TCP scanner",
    category: "optional",
    runtime: "deno",
  },
  {
    repo: "tentacle-modbus-server",
    moduleId: "tentacle-modbus-server",
    description: "Modbus TCP server",
    category: "optional",
    runtime: "deno",
  },
  {
    repo: "tentacle-network",
    moduleId: "tentacle-network",
    description: "Network interface manager",
    category: "optional",
    runtime: "deno",
  },
  {
    repo: "tentacle-nftables",
    moduleId: "tentacle-nftables",
    description: "Firewall manager",
    category: "optional",
    runtime: "deno",
  },
];

/** Look up a module by its moduleId */
export function getRegistryEntry(moduleId: string): ModuleRegistryEntry | undefined {
  return MODULE_REGISTRY.find((m) => m.moduleId === moduleId);
}
