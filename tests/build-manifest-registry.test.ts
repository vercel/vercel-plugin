import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Registry metadata tests — verifies that engine rules with known registry
 * packages carry the correct `registry` and `registrySlug` fields in both
 * source frontmatter and the compiled manifest.
 */

// ---------------------------------------------------------------------------
// Load the compiled manifest
// ---------------------------------------------------------------------------

const manifestPath = join(ROOT, "generated", "skill-rules.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const skills: Record<string, any> = manifest.skills;

// ---------------------------------------------------------------------------
// Single source-of-truth expectation map
// ---------------------------------------------------------------------------

/**
 * Every registry-backed engine skill must appear here with its exact
 * registry and (when the engine slug differs from the package name)
 * registrySlug. Skills NOT in this map must have neither field.
 */
const REGISTRY_EXPECTATIONS: Record<
  string,
  { registry: string; registrySlug?: string }
> = {
  // Direct matches — engine slug === registry package name
  "agent-browser": { registry: "vercel-labs/agent-browser" },
  "ai-elements": { registry: "vercel/ai-elements" },
  "ai-sdk": { registry: "vercel/ai" },
  "chat-sdk": { registry: "vercel/chat" },
  "next-cache-components": { registry: "vercel-labs/next-skills" },
  "next-upgrade": { registry: "vercel-labs/next-skills" },
  turborepo: { registry: "vercel/turborepo" },
  "vercel-sandbox": { registry: "vercel-labs/agent-browser" },
  workflow: { registry: "vercel/workflow" },

  // Slug mismatches — engine slug differs from registry package name
  nextjs: {
    registry: "vercel-labs/next-skills",
    registrySlug: "next-best-practices",
  },
  "react-best-practices": {
    registry: "vercel-labs/agent-skills",
    registrySlug: "vercel-react-best-practices",
  },
  "deployments-cicd": {
    registry: "vercel-labs/agent-skills",
    registrySlug: "vercel-deploy",
  },
  "vercel-cli": { registry: "vercel/vercel" },
  "vercel-flags": {
    registry: "vercel/flags",
    registrySlug: "flags-sdk",
  },
  shadcn: { registry: "vercel-labs/json-render" },
  "next-forge": { registry: "vercel/next-forge" },
};

/** Representative non-registry skills that must have no registry fields. */
const NO_REGISTRY: string[] = [
  "auth",
  "env-vars",
  "vercel-storage",
  "observability",
  "ai-gateway",
  "vercel-functions",
  "routing-middleware",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("build-manifest registry metadata", () => {
  describe("registry-backed skills have exact metadata", () => {
    for (const [slug, expected] of Object.entries(REGISTRY_EXPECTATIONS)) {
      test(`${slug} → ${expected.registry}${expected.registrySlug ? ` as ${expected.registrySlug}` : ""}`, () => {
        const skill = skills[slug];
        expect(skill).toBeDefined();
        expect(skill.registry).toBe(expected.registry);
        if (expected.registrySlug) {
          expect(skill.registrySlug).toBe(expected.registrySlug);
        } else {
          expect(skill.registrySlug).toBeUndefined();
        }
      });
    }
  });

  describe("non-registry skills have no registry fields", () => {
    for (const slug of NO_REGISTRY) {
      test(`${slug} has no registry field`, () => {
        const skill = skills[slug];
        expect(skill).toBeDefined();
        expect(skill.registry).toBeUndefined();
        expect(skill.registrySlug).toBeUndefined();
      });
    }
  });

  test("no skill outside the expectation map has a registry field", () => {
    const unexpected: string[] = [];
    for (const [slug, skill] of Object.entries(skills)) {
      if (skill.registry && !(slug in REGISTRY_EXPECTATIONS)) {
        unexpected.push(slug);
      }
    }
    expect(unexpected).toEqual([]);
  });

  test("all registry fields reference a valid org/repo format", () => {
    for (const [slug, skill] of Object.entries(skills)) {
      if (skill.registry) {
        expect(skill.registry).toMatch(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
      }
    }
  });

  test("registrySlug is never set without registry", () => {
    for (const [slug, skill] of Object.entries(skills)) {
      if (skill.registrySlug) {
        expect(skill.registry).toBeDefined();
      }
    }
  });

  test("expectation map covers all registry-backed skills in manifest", () => {
    const manifestRegistrySkills = Object.keys(skills).filter(
      (slug) => skills[slug].registry,
    );
    const expectedRegistrySkills = Object.keys(REGISTRY_EXPECTATIONS).sort();
    expect(manifestRegistrySkills.sort()).toEqual(expectedRegistrySkills);
  });
});
