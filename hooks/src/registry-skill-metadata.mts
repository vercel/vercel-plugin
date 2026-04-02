import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot as resolvePluginRoot } from "./hook-env.mjs";

export interface RegistrySkillMetadata {
  registry: string;
  registrySlug: string;
}

interface RawManifestSkill {
  registry?: unknown;
  registrySlug?: unknown;
}

interface RawManifest {
  skills?: Record<string, RawManifestSkill>;
}

export function loadRegistrySkillMetadata(
  rootDir: string = resolvePluginRoot(),
): Map<string, RegistrySkillMetadata> {
  const metadata = new Map<string, RegistrySkillMetadata>();
  const manifestPaths = [
    join(rootDir, "generated", "skill-rules.json"),
    join(rootDir, "..", "generated", "skill-rules.json"),
  ];

  const manifestPath = manifestPaths.find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    return metadata;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as RawManifest;
    for (const [skill, raw] of Object.entries(manifest.skills ?? {})) {
      if (typeof raw.registry !== "string" || raw.registry.trim() === "") continue;
      metadata.set(skill, {
        registry: raw.registry,
        registrySlug:
          typeof raw.registrySlug === "string" && raw.registrySlug.trim() !== ""
            ? raw.registrySlug
            : skill,
      });
    }
  } catch {
    return metadata;
  }

  return metadata;
}

export function buildRegistryAliasMap(
  rootDir: string = resolvePluginRoot(),
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [skill, metadata] of loadRegistrySkillMetadata(rootDir)) {
    if (metadata.registrySlug !== skill) {
      aliases.set(metadata.registrySlug, skill);
    }
  }
  return aliases;
}

export function canonicalizeInstalledSkillNames(
  skillNames: string[],
  rootDir: string = resolvePluginRoot(),
): string[] {
  const aliases = buildRegistryAliasMap(rootDir);
  return [...new Set(skillNames.map((skill) => aliases.get(skill) ?? skill))].sort();
}
