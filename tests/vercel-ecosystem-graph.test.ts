import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vercel.md is the plugin's ecosystem source of truth and README.md is what
// contributors read first. Neither may present retired Vercel product names
// or removed APIs as current recommendations. Historical mentions must be
// explicitly marked (e.g. `formerly "Edge Network"`).

const ROOT = resolve(import.meta.dirname, "..");
const graph = readFileSync(resolve(ROOT, "vercel.md"), "utf8");
const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
const aiArchitect = readFileSync(resolve(ROOT, "agents/ai-architect.md"), "utf8");

const RETIRED = [
  /\bEdge Functions\b/,
  /\bEdge Middleware\b/,
  /\bServerless Functions\b/,
  /\bBot Filter\b/,
  /purgeByTag/,
  /vercel\.com\/docs\/workflow\/agent/,
];

describe("vercel.md ecosystem graph", () => {
  test.each(RETIRED.map((re) => [re.source, re] as const))(
    "does not recommend retired name %s",
    (_name, re) => {
      const lines = graph.split("\n").filter((line) => re.test(line));
      expect(lines).toEqual([]);
    },
  );

  test("only mentions Edge Network as the former name of the CDN", () => {
    const lines = graph.split("\n").filter((line) => /Edge Network/.test(line));
    expect(lines).toEqual([
      '├── Vercel CDN (global network, ~300ms propagation; formerly "Edge Network")',
    ]);
  });

  test("describes Vercel Functions and Vercel Agent with current facts", () => {
    expect(graph).toContain("https://vercel.com/docs/agent");
    expect(graph).toMatch(/300s default, 800s max on Pro\/Enterprise/);
    expect(graph).toContain("`expireTag()`");
    expect(graph).toContain("vercel cache invalidate --tag");
  });
});

describe("README and generated agents", () => {
  test.each(RETIRED.map((re) => [re.source, re] as const))(
    "README does not recommend retired name %s",
    (_name, re) => {
      const lines = readme.split("\n").filter((line) => re.test(line));
      expect(lines).toEqual([]);
    },
  );

  test("README describes Vercel Agent with its current surface", () => {
    expect(readme).toMatch(/`vercel-agent`\s+\| Vercel Agent chat/);
  });

  test("ai-architect agent uses the real AI Gateway env var and Node.js streaming", () => {
    expect(aiArchitect).toContain("`AI_GATEWAY_API_KEY`");
    expect(aiArchitect).not.toContain("VERCEL_AI_GATEWAY_API_KEY");
    expect(aiArchitect).not.toContain("supportsResponseStreaming");
  });
});
