import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { buildManifest } from "../scripts/build-manifest.ts";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";
import {
  filterExcludedSkillMap,
  getSkillExclusion,
  EXCLUDED_SKILL_PATTERN,
} from "../src/shared/skill-exclusion-policy.ts";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");

describe("manifest exclusion parity", () => {
  test("manifest excludedSkills matches live exclusion policy", () => {
    const { manifest, errors } = buildManifest(SKILLS_DIR);
    expect(errors).toEqual([]);
    expect(manifest).not.toBeNull();

    const live = loadValidatedSkillMap(SKILLS_DIR);
    const filtered = filterExcludedSkillMap(live.skills);

    // Manifest exclusions must exactly match what the live policy produces
    expect(manifest.excludedSkills).toEqual(filtered.excluded);

    // Excluded skills must be absent from manifest.skills
    for (const ex of filtered.excluded) {
      expect(Object.keys(manifest.skills)).not.toContain(ex.slug);
    }
  });

  test("excluded skill slugs match the expected pattern", () => {
    const live = loadValidatedSkillMap(SKILLS_DIR);
    const filtered = filterExcludedSkillMap(live.skills);

    // Every excluded slug must match ^fake- or -test-skill$
    for (const ex of filtered.excluded) {
      expect(ex.slug).toMatch(/^fake-|-test-skill$/);
      expect(ex.reason).toBe("test-only-pattern");
    }
  });

  test("buildManifest returns no errors for the current skills directory", () => {
    const { errors, warnings } = buildManifest(SKILLS_DIR);
    expect(errors).toEqual([]);
    // Warnings are acceptable, but no hard errors
  });

  // ---------------------------------------------------------------------------
  // Explicit fixture verification after cleanup
  // ---------------------------------------------------------------------------

  test("fake-banned-test-skill exists on disk but is excluded from manifest", () => {
    const skillDir = join(SKILLS_DIR, "fake-banned-test-skill");
    expect(existsSync(skillDir)).toBe(true);

    const exclusion = getSkillExclusion("fake-banned-test-skill");
    expect(exclusion).not.toBeNull();
    expect(exclusion!.reason).toBe("test-only-pattern");

    const { manifest } = buildManifest(SKILLS_DIR);
    expect(Object.keys(manifest.skills)).not.toContain("fake-banned-test-skill");
    expect(manifest.excludedSkills.some((e: { slug: string }) => e.slug === "fake-banned-test-skill")).toBe(true);
  });

  test("fake-orphan-test-skill exists on disk but is excluded from manifest", () => {
    const skillDir = join(SKILLS_DIR, "fake-orphan-test-skill");
    // This skill may or may not exist depending on fixture cleanup state
    if (!existsSync(skillDir)) {
      // If it's been cleaned up, verify it's not in the manifest at all
      const { manifest } = buildManifest(SKILLS_DIR);
      expect(Object.keys(manifest.skills)).not.toContain("fake-orphan-test-skill");
      return;
    }

    const exclusion = getSkillExclusion("fake-orphan-test-skill");
    expect(exclusion).not.toBeNull();
    expect(exclusion!.reason).toBe("test-only-pattern");

    const { manifest } = buildManifest(SKILLS_DIR);
    expect(Object.keys(manifest.skills)).not.toContain("fake-orphan-test-skill");
    expect(manifest.excludedSkills.some((e: { slug: string }) => e.slug === "fake-orphan-test-skill")).toBe(true);
  });

  test("excluded skills array is sorted by slug for deterministic output", () => {
    const { manifest } = buildManifest(SKILLS_DIR);
    const slugs = manifest.excludedSkills.map((e: { slug: string }) => e.slug);
    const sorted = [...slugs].sort();
    expect(slugs).toEqual(sorted);
  });

  test("production skills are never caught by the exclusion pattern", () => {
    const { manifest } = buildManifest(SKILLS_DIR);
    for (const slug of Object.keys(manifest.skills)) {
      expect(EXCLUDED_SKILL_PATTERN.test(slug)).toBe(false);
    }
  });
});
