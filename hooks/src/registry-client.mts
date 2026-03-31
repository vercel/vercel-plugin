/**
 * Registry Client — fetch and cache skill manifests from the skills.sh registry.
 *
 * Loads a cached manifest when fresh and falls back to stale cache when
 * refresh fails. installSkills() downloads SKILL.md files into a destination
 * cache directory without adding new runtime dependencies.
 *
 * No test performs a real network call — registry fetches are injectable
 * and mockable via the `fetchImpl` option.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistrySkillRecord {
  downloadUrl: string;
  version?: string;
  summary?: string;
}

export interface RegistryManifest {
  schemaVersion: 1;
  generatedAt: string;
  skills: Record<string, RegistrySkillRecord>;
}

export interface InstallSkillsResult {
  installed: string[];
  reused: string[];
  missing: string[];
}

export interface RegistryClientOptions {
  registryManifestUrl?: string;
  cacheDir?: string;
  cacheTtlMs?: number;
  /** Injectable fetch for testing — no live registry access in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface RegistryClient {
  loadManifest(mode?: "prefer-cache" | "refresh"): Promise<RegistryManifest>;
  installSkills(
    skillNames: string[],
    destinationDir: string,
  ): Promise<InstallSkillsResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function safeReadJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function safeReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function isSafeSkillDestination(
  destinationRoot: string,
  skillName: string,
): boolean {
  if (!skillName || skillName === "." || skillName === "..") {
    return false;
  }

  if (skillName.includes("\0")) {
    return false;
  }

  const root = resolve(destinationRoot);
  const target = resolve(root, skillName);
  return target.startsWith(`${root}${sep}`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistryClient(
  options: RegistryClientOptions = {},
): RegistryClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestUrl =
    options.registryManifestUrl ??
    process.env.VERCEL_PLUGIN_SKILL_REGISTRY_URL ??
    "";
  const cacheDir = resolve(
    options.cacheDir ?? join(homedir(), ".vercel-plugin", "registry"),
  );
  const manifestPath = join(cacheDir, "manifest.json");
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());

  async function loadManifest(
    mode: "prefer-cache" | "refresh" = "prefer-cache",
  ): Promise<RegistryManifest> {
    const cached = safeReadJson<RegistryManifest>(manifestPath);
    const cachedAt = cached ? Date.parse(cached.generatedAt) : Number.NaN;
    const cachedFresh =
      !!cached &&
      Number.isFinite(cachedAt) &&
      now() - cachedAt <= ttlMs;

    if (mode !== "refresh" && cachedFresh) {
      return cached as RegistryManifest;
    }

    // No URL configured — return stale cache or error
    if (!manifestUrl) {
      if (cached) return cached;
      throw new Error(
        "Missing VERCEL_PLUGIN_SKILL_REGISTRY_URL and no cached registry manifest is available.",
      );
    }

    try {
      const response = await fetchImpl(manifestUrl);
      if (!response.ok) {
        throw new Error(`registry-manifest:${response.status}`);
      }
      const manifest = (await response.json()) as RegistryManifest;

      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        manifestPath,
        JSON.stringify(manifest, null, 2) + "\n",
        "utf-8",
      );

      return manifest;
    } catch (error) {
      // Graceful offline fallback — use stale cache
      if (cached) return cached;
      throw error;
    }
  }

  async function installSkills(
    skillNames: string[],
    destinationDir: string,
  ): Promise<InstallSkillsResult> {
    const manifest = await loadManifest("prefer-cache");
    const installed: string[] = [];
    const reused: string[] = [];
    const missing: string[] = [];

    for (const skillName of [...new Set(skillNames)].sort()) {
      if (!isSafeSkillDestination(destinationDir, skillName)) {
        missing.push(skillName);
        continue;
      }

      const record = manifest.skills[skillName];
      if (!record?.downloadUrl) {
        missing.push(skillName);
        continue;
      }

      const response = await fetchImpl(record.downloadUrl);
      if (!response.ok) {
        missing.push(skillName);
        continue;
      }

      const markdown = await response.text();
      const skillDir = join(destinationDir, skillName);
      const skillFile = join(skillDir, "SKILL.md");

      mkdirSync(skillDir, { recursive: true });

      const existing = safeReadText(skillFile);
      if (existing === markdown) {
        reused.push(skillName);
        continue;
      }

      writeFileSync(skillFile, markdown, "utf-8");
      installed.push(skillName);
    }

    return { installed, reused, missing };
  }

  return { loadManifest, installSkills };
}
