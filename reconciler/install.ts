/**
 * Version installation — extract, place, symlink, and Deno cache management
 */

import type { Log } from "@joyautomation/coral";
import type { OrchestratorConfig } from "../types/config.ts";
import type { ModuleRegistryEntry } from "../types/registry.ts";
import { downloadFile, getDownloadUrl } from "./download.ts";

/** Find the deno binary — prefer install dir, fall back to system PATH */
export async function findDeno(config: OrchestratorConfig): Promise<string> {
  const installDeno = `${config.binDir}/deno`;
  try {
    await Deno.stat(installDeno);
    return installDeno;
  } catch {
    // Fall back to system deno
    return "deno";
  }
}

/** Check if a version is installed on disk */
export async function isVersionInstalled(
  moduleId: string,
  version: string,
  config: OrchestratorConfig,
): Promise<boolean> {
  const versionDir = `${config.versionsDir}/${moduleId}/${version}`;
  try {
    const stat = await Deno.stat(versionDir);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

/** List all installed versions for a module */
export async function listInstalledVersions(
  moduleId: string,
  config: OrchestratorConfig,
): Promise<string[]> {
  const versionsDir = `${config.versionsDir}/${moduleId}`;
  const versions: string[] = [];
  try {
    for await (const dirEntry of Deno.readDir(versionsDir)) {
      if (dirEntry.isDirectory) {
        versions.push(dirEntry.name);
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return versions;
}

/** Get the currently active (symlinked) version for a module */
export async function getActiveVersion(
  entry: ModuleRegistryEntry,
  config: OrchestratorConfig,
): Promise<string | null> {
  const linkPath = entry.runtime === "go"
    ? `${config.binDir}/${entry.moduleId}`
    : `${config.servicesDir}/${entry.repo}`;

  try {
    const target = await Deno.readLink(linkPath);
    // Extract version from path like ../versions/tentacle-mqtt/0.0.6/ or
    // ../versions/tentacle-snmp/0.0.4/tentacle-snmp
    const parts = target.split("/");
    const versionsIdx = parts.indexOf("versions");
    if (versionsIdx >= 0 && parts.length > versionsIdx + 2) {
      return parts[versionsIdx + 2];
    }
    return null;
  } catch {
    // Not a symlink or doesn't exist
    return null;
  }
}

/**
 * Download and install a specific version of a module.
 * Creates /opt/tentacle/versions/{moduleId}/{version}/ with the appropriate content.
 */
export async function installVersion(
  entry: ModuleRegistryEntry,
  version: string,
  config: OrchestratorConfig,
  log: Log,
): Promise<boolean> {
  const versionDir = `${config.versionsDir}/${entry.moduleId}/${version}`;
  await Deno.mkdir(versionDir, { recursive: true });

  const url = getDownloadUrl(entry, version, config);

  switch (entry.runtime) {
    case "go": {
      // Download binary directly
      const binaryPath = `${versionDir}/${entry.moduleId}`;
      const ok = await downloadFile(url, binaryPath, log);
      if (!ok) {
        await Deno.remove(versionDir, { recursive: true }).catch(() => {});
        return false;
      }
      await Deno.chmod(binaryPath, 0o755);
      return true;
    }

    case "deno":
    case "deno-web": {
      // Download tarball, extract to version dir
      const tmpDir = await Deno.makeTempDir();
      const tarPath = `${tmpDir}/pkg.tar.gz`;

      try {
        const ok = await downloadFile(url, tarPath, log);
        if (!ok) {
          await Deno.remove(versionDir, { recursive: true }).catch(() => {});
          return false;
        }

        // Extract tarball
        const extract = new Deno.Command("tar", {
          args: ["xzf", tarPath, "-C", tmpDir],
          stdout: "piped",
          stderr: "piped",
        });
        const extractResult = await extract.output();
        if (!extractResult.success) {
          log.error(`Failed to extract tarball: ${new TextDecoder().decode(extractResult.stderr)}`);
          await Deno.remove(versionDir, { recursive: true }).catch(() => {});
          return false;
        }

        // Source tarballs contain repo-name/ dir; build tarballs contain build/ dir
        const repoDir = `${tmpDir}/${entry.repo}`;
        const buildDir = `${tmpDir}/build`;

        try {
          const stat = await Deno.stat(repoDir);
          if (stat.isDirectory) {
            // Move repo contents to version dir
            await moveContents(repoDir, versionDir);
          }
        } catch {
          // Try build dir (deno-web)
          try {
            const stat = await Deno.stat(buildDir);
            if (stat.isDirectory) {
              await Deno.mkdir(`${versionDir}/build`, { recursive: true });
              await moveContents(buildDir, `${versionDir}/build`);
            }
          } catch {
            log.error(`Unexpected tarball layout for ${entry.repo}`);
            await Deno.remove(versionDir, { recursive: true }).catch(() => {});
            return false;
          }
        }

        // Pre-cache Deno dependencies
        await precacheDenoDeps(entry, version, config, log);

        return true;
      } finally {
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
      }
    }

    default:
      log.error(`Unknown runtime: ${entry.runtime}`);
      return false;
  }
}

/** Move all contents from src directory to dest directory */
async function moveContents(src: string, dest: string): Promise<void> {
  const move = new Deno.Command("bash", {
    args: ["-c", `cp -a "${src}/"* "${dest}/" 2>/dev/null; cp -a "${src}/".[^.]* "${dest}/" 2>/dev/null; true`],
    stdout: "piped",
    stderr: "piped",
  });
  await move.output();
}

/** Pre-cache Deno dependencies for a version */
async function precacheDenoDeps(
  entry: ModuleRegistryEntry,
  version: string,
  config: OrchestratorConfig,
  log: Log,
): Promise<void> {
  const versionDir = `${config.versionsDir}/${entry.moduleId}/${version}`;
  const denoDir = `${config.cacheDir}/deno/versions/${entry.moduleId}/${version}`;
  await Deno.mkdir(denoDir, { recursive: true });

  // Check for deno.json
  try {
    await Deno.stat(`${versionDir}/deno.json`);
  } catch {
    return; // No deno.json, skip
  }

  const entrypoint = entry.runtime === "deno-web"
    ? `${versionDir}/build/index.js`
    : `${versionDir}/main.ts`;

  log.info(`Pre-caching deps for ${entry.moduleId}@${version}...`);
  const denoPath = await findDeno(config);
  const proc = new Deno.Command(denoPath, {
    args: ["install", "--entrypoint", entrypoint],
    env: { DENO_DIR: denoDir },
    cwd: versionDir,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await proc.output();
  if (!result.success) {
    log.warn(`Failed to cache deps for ${entry.moduleId}@${version}: ${new TextDecoder().decode(result.stderr)}`);
  }
}

/**
 * Update the symlink to point to the specified version.
 * Go: /opt/tentacle/bin/{moduleId} -> ../versions/{moduleId}/{version}/{binary}
 * Deno: /opt/tentacle/services/{repo} -> ../versions/{moduleId}/{version}/
 */
export async function updateSymlink(
  entry: ModuleRegistryEntry,
  version: string,
  config: OrchestratorConfig,
  log: Log,
): Promise<boolean> {
  let linkPath: string;
  let target: string;

  if (entry.runtime === "go") {
    linkPath = `${config.binDir}/${entry.moduleId}`;
    target = `${config.versionsDir}/${entry.moduleId}/${version}/${entry.moduleId}`;
  } else {
    linkPath = `${config.servicesDir}/${entry.repo}`;
    target = `${config.versionsDir}/${entry.moduleId}/${version}`;
  }

  try {
    // Remove existing symlink or file
    await Deno.remove(linkPath).catch(() => {});
    await Deno.symlink(target, linkPath);
    log.info(`Symlink: ${linkPath} → ${target}`);
    return true;
  } catch (err) {
    log.error(`Failed to create symlink ${linkPath} → ${target}: ${err}`);
    return false;
  }
}
