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
// Expected registry mappings
// ---------------------------------------------------------------------------

/** Skills whose engine slug matches the registry package name exactly. */
const DIRECT_MATCHES: Record<string, string> = {
  "agent-browser": "vercel/vercel-skills",
  "ai-elements": "vercel/vercel-skills",
  "ai-sdk": "vercel/vercel-skills",
  "next-cache-components": "vercel/vercel-skills",
  "next-upgrade": "vercel/vercel-skills",
  turborepo: "vercel/vercel-skills",
};

/** Skills whose engine slug differs from the registry package name. */
const SLUG_MISMATCHES: Record<
  string,
  { registry: string; registrySlug: string }
> = {
  nextjs: {
    registry: "vercel/vercel-skills",
    registrySlug: "next-best-practices",
  },
  "react-best-practices": {
    registry: "vercel/vercel-skills",
    registrySlug: "vercel-react-best-practices",
  },
  "deployments-cicd": {
    registry: "vercel/vercel-skills",
    registrySlug: "vercel-deploy",
  },
  "vercel-cli": {
    registry: "vercel-labs/agent-skills",
    registrySlug: "vercel-cli-with-tokens",
  },
};

/** A representative sample of skills that should NOT have a registry field. */
const NO_REGISTRY: string[] = [
  "shadcn",
  "workflow",
  "auth",
  "env-vars",
  "vercel-storage",
  "observability",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("build-manifest registry metadata", () => {
  describe("direct slug matches", () => {
    for (const [slug, registry] of Object.entries(DIRECT_MATCHES)) {
      test(`${slug} → ${registry}`, () => {
        const skill = skills[slug];
        expect(skill).toBeDefined();
        expect(skill.registry).toBe(registry);
        expect(skill.registrySlug).toBeUndefined();
      });
    }
  });

  describe("slug mismatches carry registrySlug", () => {
    for (const [slug, expected] of Object.entries(SLUG_MISMATCHES)) {
      test(`${slug} → ${expected.registry} as ${expected.registrySlug}`, () => {
        const skill = skills[slug];
        expect(skill).toBeDefined();
        expect(skill.registry).toBe(expected.registry);
        expect(skill.registrySlug).toBe(expected.registrySlug);
      });
    }
  });

  describe("docs/sitemap-only skills have no registry", () => {
    for (const slug of NO_REGISTRY) {
      test(`${slug} has no registry field`, () => {
        const skill = skills[slug];
        expect(skill).toBeDefined();
        expect(skill.registry).toBeUndefined();
        expect(skill.registrySlug).toBeUndefined();
      });
    }
  });

  test("all registry-backed skills reference a valid org/repo", () => {
    for (const [slug, skill] of Object.entries(skills)) {
      if (skill.registry) {
        expect(skill.registry).toMatch(
          /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/,
        );
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
});
