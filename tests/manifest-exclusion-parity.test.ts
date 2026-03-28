import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { buildManifest } from "../scripts/build-manifest.ts";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";
import { filterExcludedSkillMap } from "../src/shared/skill-exclusion-policy.ts";

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
});
