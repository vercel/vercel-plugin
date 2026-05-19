/**
 * Guardrail test: asserts that compiled .mjs hooks stay in sync with .mts sources.
 *
 * If this test fails, run `bun run build:hooks` and commit the updated .mjs files.
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Helper: dynamic import with cache-bust to avoid stale module cache
async function load(rel: string) {
  const abs = resolve(ROOT, rel);
  return import(`${abs}?t=${Date.now()}`);
}

// ---------------------------------------------------------------------------
// patterns module
// ---------------------------------------------------------------------------
describe("patterns .mts/.mjs sync", () => {
  test("exported function names match", async () => {
    const src = await load("hooks/src/patterns.mts");
    const compiled = await load("hooks/patterns.mjs");

    const srcFns = Object.keys(src).filter((k) => typeof src[k] === "function").sort();
    const compiledFns = Object.keys(compiled).filter((k) => typeof compiled[k] === "function").sort();

    expect(compiledFns).toEqual(srcFns);
  });

  test("globToRegex produces identical output", async () => {
    const src = await load("hooks/src/patterns.mts");
    const compiled = await load("hooks/patterns.mjs");

    const inputs = ["**/*.tsx", "src/components/**/*.ts", "*.js", "lib/**/index.mts"];
    for (const input of inputs) {
      expect(compiled.globToRegex(input).source).toBe(src.globToRegex(input).source);
    }
  });

  test("parseSeenSkills produces identical output", async () => {
    const src = await load("hooks/src/patterns.mts");
    const compiled = await load("hooks/patterns.mjs");

    const inputs = ["", "nextjs", "nextjs,turbopack,ai-sdk", "a,,b"];
    for (const input of inputs) {
      expect([...compiled.parseSeenSkills(input)].sort()).toEqual(
        [...src.parseSeenSkills(input)].sort(),
      );
    }
  });

  test("appendSeenSkill produces identical output", async () => {
    const src = await load("hooks/src/patterns.mts");
    const compiled = await load("hooks/patterns.mjs");

    expect(compiled.appendSeenSkill("", "nextjs")).toBe(src.appendSeenSkill("", "nextjs"));
    expect(compiled.appendSeenSkill("a,b", "c")).toBe(src.appendSeenSkill("a,b", "c"));
    expect(compiled.appendSeenSkill(undefined, "x")).toBe(src.appendSeenSkill(undefined, "x"));
  });
});

// ---------------------------------------------------------------------------
// pretooluse-skill-inject module
// ---------------------------------------------------------------------------
describe("pretooluse-skill-inject .mts/.mjs sync", () => {
  test("exported function names match", async () => {
    const src = await load("hooks/src/pretooluse-skill-inject.mts");
    const compiled = await load("hooks/pretooluse-skill-inject.mjs");

    const srcFns = Object.keys(src).filter((k) => typeof src[k] === "function").sort();
    const compiledFns = Object.keys(compiled).filter((k) => typeof compiled[k] === "function").sort();

    expect(compiledFns).toEqual(srcFns);
  });

  test("redactCommand produces identical output", async () => {
    const src = await load("hooks/src/pretooluse-skill-inject.mts");
    const compiled = await load("hooks/pretooluse-skill-inject.mjs");

    const inputs = [
      "npm install",
      "STRIPE_KEY=sk_live_abc npm run dev",
      "echo hello world",
      'curl -H "Authorization: Bearer tok_123" https://api.example.com',
    ];
    for (const input of inputs) {
      expect(compiled.redactCommand(input)).toBe(src.redactCommand(input));
    }
  });

});

// ---------------------------------------------------------------------------
// vercel-config module
// ---------------------------------------------------------------------------
describe("vercel-config .mts/.mjs sync", () => {
  test("exported function names match", async () => {
    const src = await load("hooks/src/vercel-config.mts");
    const compiled = await load("hooks/vercel-config.mjs");

    const srcFns = Object.keys(src).filter((k) => typeof src[k] === "function").sort();
    const compiledFns = Object.keys(compiled).filter((k) => typeof compiled[k] === "function").sort();

    expect(compiledFns).toEqual(srcFns);
  });

  test("VERCEL_JSON_SKILLS constant matches", async () => {
    const src = await load("hooks/src/vercel-config.mts");
    const compiled = await load("hooks/vercel-config.mjs");

    expect([...compiled.VERCEL_JSON_SKILLS].sort()).toEqual(
      [...src.VERCEL_JSON_SKILLS].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// logger module
// ---------------------------------------------------------------------------
describe("logger .mts/.mjs sync", () => {
  test("exported function names match", async () => {
    const src = await load("hooks/src/logger.mts");
    const compiled = await load("hooks/logger.mjs");

    const srcFns = Object.keys(src).filter((k) => typeof src[k] === "function").sort();
    const compiledFns = Object.keys(compiled).filter((k) => typeof compiled[k] === "function").sort();

    expect(compiledFns).toEqual(srcFns);
  });

  test("resolveLogLevel produces identical defaults", async () => {
    const src = await load("hooks/src/logger.mts");
    const compiled = await load("hooks/logger.mjs");

    // With no env vars set, both should return the same default
    expect(compiled.resolveLogLevel()).toBe(src.resolveLogLevel());
  });
});
