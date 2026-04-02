// hooks/src/registry-skill-metadata.mts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pluginRoot as resolvePluginRoot } from "./hook-env.mjs";
function loadRegistrySkillMetadata(rootDir = resolvePluginRoot()) {
  const metadata = /* @__PURE__ */ new Map();
  const manifestPaths = [
    join(rootDir, "generated", "skill-rules.json"),
    join(rootDir, "..", "generated", "skill-rules.json")
  ];
  const manifestPath = manifestPaths.find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    return metadata;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    for (const [skill, raw] of Object.entries(manifest.skills ?? {})) {
      if (typeof raw.registry !== "string" || raw.registry.trim() === "") continue;
      metadata.set(skill, {
        registry: raw.registry,
        registrySlug: typeof raw.registrySlug === "string" && raw.registrySlug.trim() !== "" ? raw.registrySlug : skill
      });
    }
  } catch {
    return metadata;
  }
  return metadata;
}
function buildRegistryAliasMap(rootDir = resolvePluginRoot()) {
  const aliases = /* @__PURE__ */ new Map();
  for (const [skill, metadata] of loadRegistrySkillMetadata(rootDir)) {
    if (metadata.registrySlug !== skill) {
      aliases.set(metadata.registrySlug, skill);
    }
  }
  return aliases;
}
function canonicalizeInstalledSkillNames(skillNames, rootDir = resolvePluginRoot()) {
  const aliases = buildRegistryAliasMap(rootDir);
  return [...new Set(skillNames.map((skill) => aliases.get(skill) ?? skill))].sort();
}
export {
  buildRegistryAliasMap,
  canonicalizeInstalledSkillNames,
  loadRegistrySkillMetadata
};
