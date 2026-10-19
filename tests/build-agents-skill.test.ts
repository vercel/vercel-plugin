import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  compilePromptSignals,
  matchPromptWithReason,
  normalizePromptText,
  type CompiledPromptSignals,
} from "../hooks/src/prompt-patterns.mts";
import {
  compileSkillPatterns,
  matchBashWithReason,
  type CompiledSkillEntry,
} from "../hooks/src/patterns.mts";
import { analyzePrompt } from "../hooks/src/prompt-analysis.mts";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

const ROOT = resolve(import.meta.dirname, "..");

let compiledPromptSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;
let skillMap: Record<string, any>;

beforeAll(() => {
  const loaded = loadValidatedSkillMap(resolve(ROOT, "skills"));
  skillMap = loaded.skills;

  const buildAgents = skillMap["build-agents"];
  const eve = skillMap.eve;

  expect(buildAgents).toBeDefined();
  expect(buildAgents.promptSignals).toBeDefined();
  expect(eve).toBeDefined();
  expect(buildAgents.priority).toBeGreaterThan(eve.priority);

  compiledPromptSignals = compilePromptSignals(buildAgents.promptSignals!);
  compiledSkill = compileSkillPatterns({ "build-agents": buildAgents })[0];
});

function matchesPrompt(prompt: string): boolean {
  return matchPromptWithReason(
    normalizePromptText(prompt),
    compiledPromptSignals,
  ).matched;
}

describe("build-agents prompt activation", () => {
  test.each([
    "Build me an agent that triages support tickets.",
    "Create an agent that runs scheduled research reports.",
    "Scaffold a Slack agent that answers channel questions.",
    "Design a multi-agent system with tools and approvals.",
    "Which agent framework should I use for this application?",
    "Implement a tool-calling agent for release-note triage.",
  ])("does not choose the Vercel/eve stack from generic intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });

  test.each([
    "Build an eve agent that triages support tickets.",
    "Add scheduled research to our existing eve agent.",
    "Scaffold eve for the agent architecture we selected.",
    "Design an agent architecture on Vercel.",
  ])("matches an explicitly selected stack: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Build a browser user-agent parser.",
    "Configure Vercel Agent code review for this repo.",
    "Investigate an incident with Vercel Agent.",
    "Tell me about EVE Online agents.",
  ])("does not match unrelated agent wording: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });

  test("does not select build-agents for an unchosen stack", () => {
    const report = analyzePrompt(
      "build me an agent",
      skillMap,
      "",
      8_000,
      2,
      { lexicalEnabled: false },
    );

    expect(report.selectedSkills).not.toContain("build-agents");
    expect(report.perSkillResults["build-agents"].matched).toBe(false);
    expect(report.perSkillResults.eve.matched).toBe(false);
  });

  test("matches new eve agent scaffold commands", () => {
    expect(matchBashWithReason("npx eve@latest init support-agent", compiledSkill.compiledBash)).not.toBeNull();
    expect(matchBashWithReason("bunx eve init research-agent", compiledSkill.compiledBash)).not.toBeNull();
    expect(matchBashWithReason("eve dev", compiledSkill.compiledBash)).toBeNull();
  });
});
