/**
 * GitHub release download and version resolution
 */

import type { Log } from "@joyautomation/coral";
import type { OrchestratorConfig } from "../types/config.ts";
import type { ModuleRegistryEntry } from "../types/registry.ts";

/** Cache for "latest" version resolution */
const latestCache = new Map<string, { version: string; resolvedAt: number }>();

/** Detect system architecture */
function getArch(): string {
  const arch = Deno.build.arch;
  switch (arch) {
    case "x86_64": return "amd64";
    case "aarch64": return "arm64";
    default: return arch;
  }
}

/** Check if we have internet connectivity */
export async function checkInternet(): Promise<boolean> {
  try {
    const resp = await fetch("https://api.github.com", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve "latest" to an actual version tag from GitHub releases.
 * Caches the result for `config.latestCacheTtlMs` to avoid rate limiting.
 */
export async function resolveLatestVersion(
  entry: ModuleRegistryEntry,
  config: OrchestratorConfig,
  log: Log,
): Promise<string | null> {
  // Check cache
  const cached = latestCache.get(entry.repo);
  if (cached && (Date.now() - cached.resolvedAt) < config.latestCacheTtlMs) {
    return cached.version;
  }

  try {
    const url = `https://api.github.com/repos/${config.ghOrg}/${entry.repo}/releases/latest`;
    const resp = await fetch(url, {
      headers: { "Accept": "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      log.warn(`Failed to resolve latest version for ${entry.repo}: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const tag = data.tag_name as string;
    // Strip leading "v" if present
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    latestCache.set(entry.repo, { version, resolvedAt: Date.now() });
    log.info(`Resolved ${entry.repo} latest → ${version}`);
    return version;
  } catch (err) {
    log.warn(`Failed to resolve latest version for ${entry.repo}: ${err}`);
    return null;
  }
}

/**
 * Resolve the version string. If "latest", resolve from GitHub.
 * If offline and "latest", fall back to the highest local version.
 */
export async function resolveVersion(
  entry: ModuleRegistryEntry,
  desiredVersion: string,
  config: OrchestratorConfig,
  log: Log,
): Promise<string | null> {
  if (desiredVersion !== "latest") {
    return desiredVersion;
  }

  // Try GitHub first
  const resolved = await resolveLatestVersion(entry, config, log);
  if (resolved) return resolved;

  // Offline fallback: use highest local version
  const versionsDir = `${config.versionsDir}/${entry.moduleId}`;
  try {
    const versions: string[] = [];
    for await (const dirEntry of Deno.readDir(versionsDir)) {
      if (dirEntry.isDirectory && dirEntry.name !== "unknown") {
        versions.push(dirEntry.name);
      }
    }
    if (versions.length === 0) return null;
    // Sort semver-ish: simple lexicographic on split parts
    versions.sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    const highest = versions[versions.length - 1];
    log.info(`Offline fallback: ${entry.moduleId} latest → ${highest} (highest local)`);
    return highest;
  } catch {
    return null;
  }
}

/** Build the download URL for a module version */
export function getDownloadUrl(entry: ModuleRegistryEntry, version: string, config: OrchestratorConfig): string {
  const tag = `v${version}`;
  const base = `https://github.com/${config.ghOrg}/${entry.repo}/releases/download/${tag}`;

  switch (entry.runtime) {
    case "go":
      return `${base}/${entry.moduleId}-linux-${getArch()}`;
    case "deno":
      return `${base}/${entry.repo}-src.tar.gz`;
    case "deno-web":
      return `${base}/${entry.repo}-build.tar.gz`;
    default:
      throw new Error(`Unknown runtime: ${entry.runtime}`);
  }
}

/** Download a file from a URL to a local path */
export async function downloadFile(url: string, destPath: string, log: Log): Promise<boolean> {
  try {
    log.info(`Downloading ${url}...`);
    const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!resp.ok) {
      log.error(`Download failed: HTTP ${resp.status} for ${url}`);
      return false;
    }
    const data = new Uint8Array(await resp.arrayBuffer());
    await Deno.writeFile(destPath, data);
    log.info(`Downloaded ${data.length} bytes → ${destPath}`);
    return true;
  } catch (err) {
    log.error(`Download failed for ${url}: ${err}`);
    return false;
  }
}
