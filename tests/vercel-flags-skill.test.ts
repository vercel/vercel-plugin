import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  compileSkillPatterns,
  matchBashWithReason,
  matchImportWithReason,
  type CompiledSkillEntry,
} from "../hooks/src/patterns.mts";
import {
  compilePromptSignals,
  matchPromptWithReason,
  normalizePromptText,
  type CompiledPromptSignals,
} from "../hooks/src/prompt-patterns.mts";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS = ["vercel-flags", "flags-sdk"] as const;
type FlagsSkill = (typeof SKILLS)[number];

const prompts = {} as Record<FlagsSkill, CompiledPromptSignals>;
const entries = {} as Record<FlagsSkill, CompiledSkillEntry>;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  for (const name of SKILLS) {
    expect(skills[name]).toBeDefined();
    prompts[name] = compilePromptSignals(skills[name].promptSignals!);
    entries[name] = compileSkillPatterns({ [name]: skills[name] })[0];
  }
});

function promptMatches(prompt: string): FlagsSkill[] {
  const text = normalizePromptText(prompt);
  return SKILLS.filter((name) => matchPromptWithReason(text, prompts[name]).matched);
}

function bashMatches(command: string): FlagsSkill[] {
  return SKILLS.filter((name) => matchBashWithReason(command, entries[name].compiledBash) !== null);
}

function importMatches(source: string): FlagsSkill[] {
  return SKILLS.filter((name) => matchImportWithReason(source, entries[name].compiledImports) !== null);
}

describe("flag planning and management route to vercel-flags", () => {
  test.each([
    "Put the new checkout behind a feature flag.",
    "Roll this out to 10% of users with a gradual rollout.",
    "Set up an A/B test for the pricing page.",
    "Add a kill switch for the recommendations widget.",
    "Archive the old-header flag now that the rollout is done.",
  ])("%s", (prompt) => {
    expect(promptMatches(prompt)).toEqual(["vercel-flags"]);
  });

  test.each([
    "vercel flags rollout new-checkout --by user.id --stage 10",
    "vc flags inspect new-checkout",
    "pnpm add @vercel/flags-core",
  ])("bash: %s", (command) => {
    expect(bashMatches(command)).toEqual(["vercel-flags"]);
  });

  test("@vercel/flags-core imports, including subpaths", () => {
    expect(importMatches(`import { createClient } from '@vercel/flags-core';`)).toEqual(["vercel-flags"]);
    expect(importMatches(`import { VercelProvider } from "@vercel/flags-core/openfeature";`)).toEqual(["vercel-flags"]);
  });
});

describe("Flags SDK code routes to flags-sdk", () => {
  test.each([
    "Wire the Statsig flag adapter into the Flags SDK.",
    "Precompute flags so the marketing page stays static.",
    "Set up the Flags Explorer discovery endpoint.",
  ])("%s", (prompt) => {
    expect(promptMatches(prompt)).toEqual(["flags-sdk"]);
  });

  test.each([
    "pnpm add flags @flags-sdk/vercel",
    "npm i flags@4",
    "npm install @flags-sdk/statsig",
  ])("bash: %s", (command) => {
    expect(bashMatches(command)).toEqual(["flags-sdk"]);
  });

  test("flags/next and @flags-sdk imports", () => {
    expect(importMatches(`import { flag } from 'flags/next';`)).toEqual(["flags-sdk"]);
    expect(importMatches(`import { vercelAdapter } from '@flags-sdk/vercel';`)).toEqual(["flags-sdk"]);
  });
});

describe("unrelated flags do not route to either skill", () => {
  test.each([
    "Add a --verbose command-line flag to the build script.",
    "Which compiler flag enables strict mode?",
    "Use a rolling release for the next production deploy.",
  ])("%s", (prompt) => {
    expect(promptMatches(prompt)).toEqual([]);
  });
});
