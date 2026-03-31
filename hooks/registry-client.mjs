// hooks/src/registry-client.mts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
var DEFAULT_CACHE_TTL_MS = 15 * 60 * 1e3;
function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
function safeReadText(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
function isSafeSkillDestination(destinationRoot, skillName) {
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
function createRegistryClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestUrl = options.registryManifestUrl ?? process.env.VERCEL_PLUGIN_SKILL_REGISTRY_URL ?? "";
  const cacheDir = resolve(
    options.cacheDir ?? join(homedir(), ".vercel-plugin", "registry")
  );
  const manifestPath = join(cacheDir, "manifest.json");
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  async function loadManifest(mode = "prefer-cache") {
    const cached = safeReadJson(manifestPath);
    const cachedAt = cached ? Date.parse(cached.generatedAt) : Number.NaN;
    const cachedFresh = !!cached && Number.isFinite(cachedAt) && now() - cachedAt <= ttlMs;
    if (mode !== "refresh" && cachedFresh) {
      return cached;
    }
    if (!manifestUrl) {
      if (cached) return cached;
      throw new Error(
        "Missing VERCEL_PLUGIN_SKILL_REGISTRY_URL and no cached registry manifest is available."
      );
    }
    try {
      const response = await fetchImpl(manifestUrl);
      if (!response.ok) {
        throw new Error(`registry-manifest:${response.status}`);
      }
      const manifest = await response.json();
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        manifestPath,
        JSON.stringify(manifest, null, 2) + "\n",
        "utf-8"
      );
      return manifest;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  }
  async function installSkills(skillNames, destinationDir) {
    const manifest = await loadManifest("prefer-cache");
    const installed = [];
    const reused = [];
    const missing = [];
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
export {
  createRegistryClient
};
