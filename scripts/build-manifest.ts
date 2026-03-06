#!/usr/bin/env bun
/**
 * Build-time script that generates a static skill manifest from SKILL.md
 * frontmatter. The PreToolUse hook reads this manifest instead of scanning
 * and parsing every SKILL.md on each invocation.
 *
 * Usage:  bun run scripts/build-manifest.ts
 *         node scripts/build-manifest.ts   (also works via bun shim)
 */

import { resolve, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

// Import the canonical skill-map builder (ESM)
import { buildSkillMap, validateSkillMap } from "../hooks/skill-map-frontmatter.mjs";
import { globToRegex, importPatternToRegex } from "../hooks/patterns.mjs";

export { buildManifest };

const ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = join(ROOT, "skills");
const OUT_DIR = join(ROOT, "generated");
const OUT_FILE = join(OUT_DIR, "skill-manifest.json");

interface ManifestSkillConfig {
  priority: number;
  summary: string;
  pathPatterns: string[];
  bashPatterns: string[];
  importPatterns: string[];
}

interface ManifestSkill extends ManifestSkillConfig {
  bodyPath: string;
  pathRegexSources: string[];
  bashRegexSources: string[];
  importRegexSources: Array<{ source: string; flags: string }>;
}

interface Manifest {
  generatedAt: string;
  version: 2;
  skills: Record<string, ManifestSkill>;
}

/**
 * Compile regex sources for a skill config at build time.
 * Path globs → globToRegex().source, bash patterns → RegExp source,
 * import patterns → importPatternToRegex() source+flags.
 */
function compileRegexSources(config: ManifestSkillConfig) {
  const pathRegexSources: string[] = [];
  for (const p of config.pathPatterns) {
    try {
      pathRegexSources.push(globToRegex(p).source);
    } catch {
      // Skip invalid — validation catches these
    }
  }

  const bashRegexSources: string[] = [];
  for (const p of config.bashPatterns) {
    try {
      new RegExp(p); // validate
      bashRegexSources.push(p);
    } catch {
      // Skip invalid
    }
  }

  const importRegexSources: Array<{ source: string; flags: string }> = [];
  for (const p of config.importPatterns) {
    try {
      const re = importPatternToRegex(p);
      importRegexSources.push({ source: re.source, flags: re.flags });
    } catch {
      // Skip invalid
    }
  }

  return { pathRegexSources, bashRegexSources, importRegexSources };
}

/**
 * Build the skill manifest object from the skills directory.
 * Exported so validate.ts can reuse this without duplicating logic.
 */
function buildManifest(skillsDir: string): { manifest: Manifest; warnings: string[]; errors: string[] } {
  const built = buildSkillMap(skillsDir);
  const allWarnings: string[] = [];

  if (built.diagnostics?.length) {
    for (const d of built.diagnostics) {
      allWarnings.push(`${d.file}: ${d.message}`);
    }
  }

  const validation = validateSkillMap(built);

  if (!validation.ok) {
    return { manifest: null as any, warnings: allWarnings, errors: validation.errors };
  }

  if (validation.warnings?.length) {
    allWarnings.push(...validation.warnings);
  }

  const skills: Record<string, ManifestSkill> = {};
  for (const [slug, config] of Object.entries(validation.normalizedSkillMap.skills) as [string, ManifestSkillConfig][]) {
    const regexSources = compileRegexSources(config);
    skills[slug] = {
      ...config,
      bodyPath: `skills/${slug}/SKILL.md`,
      ...regexSources,
    };
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    version: 2,
    skills,
  };

  return { manifest, warnings: allWarnings, errors: [] };
}

// ---------------------------------------------------------------------------
// CLI entry point (only when run directly)
// ---------------------------------------------------------------------------

function isMain() {
  try {
    return resolve(process.argv[1] || "") === resolve(import.meta.filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const { manifest, warnings, errors } = buildManifest(SKILLS_DIR);

  for (const w of warnings) console.warn(`[warn] ${w}`);

  if (errors.length > 0) {
    console.error("[error] Skill map validation failed:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + "\n");

  const count = Object.keys(manifest.skills).length;
  console.log(`✓ Wrote ${count} skills to ${OUT_FILE}`);
}
