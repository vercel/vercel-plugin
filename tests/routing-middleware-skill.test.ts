import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

// Content-contract guards for the routing-middleware skill. These lock in the
// configuration surface the skill teaches so a future edit cannot silently
// reintroduce APIs that do not exist (an invented `defineConfig` export and
// `npx @vercel/config compile|validate|generate` commands) or drop the
// platform's documented entry points (`proxy.entrypoint`, `vercel routes`).

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_PATH = resolve(ROOT, "skills/routing-middleware/SKILL.md");

let skill: string;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  expect(skills["routing-middleware"]).toBeDefined();
  skill = readFileSync(SKILL_PATH, "utf8");
});

describe("routing-middleware guidance", () => {
  test("teaches the documented vercel.json proxy entrypoint and Next.js proxy.ts", () => {
    expect(skill).toContain('"proxy": {');
    expect(skill).toContain('"entrypoint": "proxy.ts"');
    expect(skill).toContain("export default function proxy(request: Request)");
    expect(skill).toContain("Next.js Proxy runs on Node.js only");
  });

  test("uses the real @vercel/config/v1 shape for vercel.ts", () => {
    expect(skill).toContain(
      "import { routes, type VercelConfig } from '@vercel/config/v1';",
    );
    expect(skill).toContain("export const config: VercelConfig = {");
    expect(skill).not.toContain("defineConfig");
    expect(skill).not.toMatch(/npx @vercel\/config (compile|validate|generate)/);
  });

  test("routes project-level rules through the vercel routes CLI", () => {
    expect(skill).toContain("vercel routes add");
    expect(skill).toContain("vercel routes list --diff");
    expect(skill).toContain("vercel routes publish");
  });

  test("does not recommend retired products or removed request properties", () => {
    expect(skill).not.toContain("Edge Functions");
    expect(skill).not.toMatch(/`request\.geo`|`request\.ip`/);
    expect(skill).toContain("`geolocation(request)` and `ipAddress(request)` from `@vercel/functions`");
  });
});
