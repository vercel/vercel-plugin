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
import { globToRegex, importPatternToRegex } from "../hooks/patterns.mjs";
import type { SkillEntry, ManifestSkill } from "../hooks/patterns.mjs";
import type { ChainToRule, ValidationRule } from "../hooks/skill-map-frontmatter.mjs";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";
import {
  EXCLUDED_SKILL_PATTERN,
  filterExcludedSkillMap,
  type SkillExclusion,
} from "../src/shared/skill-exclusion-policy.ts";

export { buildManifest, writeManifestFile, synthesizeChainToFromValidate, EXCLUDED_SKILL_PATTERN };

const ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = join(ROOT, "skills");
const OUT_DIR = join(ROOT, "generated");
const OUT_FILE = join(OUT_DIR, "skill-manifest.json");

interface ManifestSkillWithBody extends ManifestSkill {
  bodyPath: string;
}

interface Manifest {
  generatedAt: string;
  version: 2;
  excludedSkills: SkillExclusion[];
  skills: Record<string, ManifestSkillWithBody>;
}

/**
 * Compile regex sources for a skill config at build time.
 * Path globs → globToRegex().source, bash patterns → RegExp source,
 * import patterns → importPatternToRegex() source+flags.
 *
 * Returns paired arrays: patterns and regex sources stay in sync so that
 * index N of pathPatterns always corresponds to index N of pathRegexSources.
 * Invalid patterns are dropped from both arrays to prevent index drift.
 */
function compileRegexSources(config: SkillEntry) {
  const pathPatterns: string[] = [];
  const pathRegexSources: string[] = [];
  for (const p of config.pathPatterns) {
    try {
      pathRegexSources.push(globToRegex(p).source);
      pathPatterns.push(p);
    } catch {
      // Skip invalid — validation catches these
    }
  }

  const bashPatterns: string[] = [];
  const bashRegexSources: string[] = [];
  for (const p of config.bashPatterns) {
    try {
      new RegExp(p); // validate
      bashRegexSources.push(p);
      bashPatterns.push(p);
    } catch {
      // Skip invalid
    }
  }

  const importPatterns: string[] = [];
  const importRegexSources: Array<{ source: string; flags: string }> = [];
  for (const p of config.importPatterns) {
    try {
      const re = importPatternToRegex(p);
      importRegexSources.push({ source: re.source, flags: re.flags });
      importPatterns.push(p);
    } catch {
      // Skip invalid
    }
  }

  return { pathPatterns, pathRegexSources, bashPatterns, bashRegexSources, importPatterns, importRegexSources };
}

/**
 * Auto-synthesize chainTo entries from validate rules that have upgradeToSkill
 * with severity "error" or "recommended", unless a matching chainTo already
 * exists for that targetSkill in the same skill.
 *
 * Returns the number of synthesized entries added.
 */
function synthesizeChainToFromValidate(
  skills: Record<string, SkillEntry>,
  allSlugs: Set<string>,
): { count: number; warnings: string[] } {
  let count = 0;
  const warnings: string[] = [];

  for (const [slug, config] of Object.entries(skills)) {
    if (!config.validate?.length) continue;

    // Collect existing chainTo targets for this skill
    const existingTargets = new Set(
      (config.chainTo ?? []).map((c: ChainToRule) => c.targetSkill),
    );

    for (const rule of config.validate as ValidationRule[]) {
      if (!rule.upgradeToSkill) continue;
      if (rule.severity !== "error" && rule.severity !== "recommended") continue;
      if (existingTargets.has(rule.upgradeToSkill)) continue;
      if (!allSlugs.has(rule.upgradeToSkill)) {
        warnings.push(
          `skill "${slug}": cannot synthesize chainTo for upgradeToSkill "${rule.upgradeToSkill}" — target skill does not exist`,
        );
        continue;
      }

      const message =
        rule.upgradeWhy ||
        `${rule.message} — loading ${rule.upgradeToSkill} guidance.`;

      const synthesized: ChainToRule = {
        pattern: rule.pattern,
        targetSkill: rule.upgradeToSkill,
        message,
        synthesized: true,
      };

      if (!config.chainTo) {
        config.chainTo = [];
      }
      config.chainTo.push(synthesized);
      existingTargets.add(rule.upgradeToSkill);
      count++;
    }
  }

  return { count, warnings };
}

/**
 * Build the skill manifest object from the skills directory.
 * Exported so validate.ts can reuse this without duplicating logic.
 */
function buildManifest(skillsDir: string): { manifest: Manifest; warnings: string[]; errors: string[] } {
  const { validation, buildDiagnostics } = loadValidatedSkillMap(skillsDir);
  const allWarnings: string[] = [...buildDiagnostics];

  if (!validation.ok) {
    return { manifest: null as any, warnings: allWarnings, errors: validation.errors };
  }

  if (validation.warnings?.length) {
    allWarnings.push(...validation.warnings);
  }

  // Filter out test-only / fake skills before building the runtime manifest
  const allSkills = validation.normalizedSkillMap.skills as Record<string, SkillEntry>;
  const { included: normalizedSkills, excluded: excludedSkillEntries } =
    filterExcludedSkillMap(allSkills);
  if (excludedSkillEntries.length > 0) {
    console.error(
      JSON.stringify({
        event: "skill_manifest_exclusions",
        count: excludedSkillEntries.length,
        skills: excludedSkillEntries.map((e) => e.slug),
        reason: "test-only-pattern",
      }),
    );
  }

  // Auto-synthesize chainTo from upgradeToSkill validate rules
  const allSlugs = new Set(Object.keys(normalizedSkills));
  const { count: synthCount, warnings: synthWarnings } =
    synthesizeChainToFromValidate(normalizedSkills, allSlugs);
  allWarnings.push(...synthWarnings);
  if (synthCount > 0) {
    console.error(`  ⤳ Synthesized ${synthCount} chainTo rule(s) from upgradeToSkill validate rules`);
  }

  const skills: Record<string, ManifestSkillWithBody> = {};
  for (const [slug, config] of Object.entries(normalizedSkills) as [string, SkillEntry][]) {
    const { pathPatterns, pathRegexSources, bashPatterns, bashRegexSources, importPatterns, importRegexSources } = compileRegexSources(config);
    skills[slug] = {
      priority: config.priority,
      summary: config.summary,
      docs: config.docs,
      ...(config.sitemap ? { sitemap: config.sitemap } : {}),
      pathPatterns,
      bashPatterns,
      importPatterns,
      bodyPath: `skills/${slug}/SKILL.md`,
      pathRegexSources,
      bashRegexSources,
      importRegexSources,
      ...(config.validate?.length ? { validate: config.validate } : {}),
      ...(config.chainTo?.length ? { chainTo: config.chainTo } : {}),
      ...(config.promptSignals ? { promptSignals: config.promptSignals } : {}),
      ...(config.retrieval ? { retrieval: config.retrieval } : {}),
    };
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    version: 2,
    excludedSkills: excludedSkillEntries,
    skills,
  };

  return { manifest, warnings: allWarnings, errors: [] };
}

/**
 * Write the manifest JSON to generated/skill-manifest.json.
 * Returns the number of skills written.
 */
function writeManifestFile(manifest: Manifest, outDir = OUT_DIR, outFile = OUT_FILE): number {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
  return Object.keys(manifest.skills).length;
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

  const count = writeManifestFile(manifest);
  console.log(`✓ Wrote ${count} skills to ${OUT_FILE}`);
}
