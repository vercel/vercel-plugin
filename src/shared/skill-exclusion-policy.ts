/**
 * Unified skill exclusion policy.
 *
 * Single source of truth for which skills are test-only fixtures that must
 * never appear in the runtime manifest or be surfaced as live candidates in
 * CLI diagnostics.
 *
 * Consumers: scripts/build-manifest.ts, src/cli/explain.ts, src/commands/doctor.ts
 */

/**
 * Skills matching this pattern are test-only fixtures. The pattern matches
 * slugs prefixed with "fake-" or suffixed with "-test-skill".
 */
export const EXCLUDED_SKILL_PATTERN = /^fake-|-test-skill$/;

export type SkillExclusionReason = "test-only-pattern";

export interface SkillExclusion {
  slug: string;
  reason: SkillExclusionReason;
}

/**
 * Check whether a single skill slug is excluded by policy.
 * Returns the exclusion record or null if the skill is not excluded.
 */
export function getSkillExclusion(slug: string): SkillExclusion | null {
  return EXCLUDED_SKILL_PATTERN.test(slug)
    ? { slug, reason: "test-only-pattern" }
    : null;
}

/**
 * Partition a skill map into included (runtime) and excluded (test-only) sets.
 * Excluded entries are sorted by slug for deterministic output.
 */
export function filterExcludedSkillMap<T>(
  skills: Record<string, T>,
): { included: Record<string, T>; excluded: SkillExclusion[] } {
  const included: Record<string, T> = {};
  const excluded: SkillExclusion[] = [];

  for (const [slug, value] of Object.entries(skills)) {
    const hit = getSkillExclusion(slug);
    if (hit) {
      excluded.push(hit);
      continue;
    }
    included[slug] = value;
  }

  excluded.sort((a, b) => a.slug.localeCompare(b.slug));
  return { included, excluded };
}
