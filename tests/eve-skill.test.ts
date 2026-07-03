import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  compileSkillPatterns,
  matchBashWithReason,
  matchImportWithReason,
  matchPathWithReason,
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

let compiledPromptSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const eve = skills.eve;

  expect(eve).toBeDefined();
  expect(eve.promptSignals).toBeDefined();

  compiledPromptSignals = compilePromptSignals(eve.promptSignals!);
  compiledSkill = compileSkillPatterns({ eve })[0];
});

function matchesPrompt(prompt: string): boolean {
  return matchPromptWithReason(
    normalizePromptText(prompt),
    compiledPromptSignals,
  ).matched;
}

describe("eve prompt activation", () => {
  test.each([
    "Build me an agent that triages support tickets.",
    "Design a durable research agent with scheduled reports.",
    "Prototype an agent-powered knowledge assistant.",
    "Implement a new agent for release-note triage.",
    "Which agent framework should I use for this application?",
    "Help debug my Eve project.",
    "Migrate my LangGraph agent to another framework.",
    "Show me the latest production Agent Runs for my project.",
    "Inspect an Agent Runs trace for wrun_123.",
    "Update skills based on recent runs.",
  ])("matches agent-building or explicit Eve intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Explain what an AI agent is.",
    "Fix my AI SDK ToolLoopAgent implementation.",
    "Debug my LangGraph agent.",
    "Add a presentational chat UI component to this page.",
    "Build a browser user agent parser.",
    "Tell me about EVE Online agents.",
  ])("does not match incidental or unrelated agent intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });
});

describe("eve project evidence", () => {
  test("matches only Eve-specific paths", () => {
    expect(matchPathWithReason(".eve/build/manifest.json", compiledSkill.compiledPaths)).not.toBeNull();
    expect(matchPathWithReason("apps/support/agent/channels/eve.ts", compiledSkill.compiledPaths)).not.toBeNull();
    expect(matchPathWithReason("agent/tools/search.ts", compiledSkill.compiledPaths)).toBeNull();
  });

  test("matches Eve package imports", () => {
    expect(matchImportWithReason('import { defineTool } from "eve/tools";', compiledSkill.compiledImports)).not.toBeNull();
    expect(matchImportWithReason('import { ToolLoopAgent } from "ai";', compiledSkill.compiledImports)).toBeNull();
  });

  test("matches Eve CLI and installation commands without matching similarly named packages", () => {
    expect(matchBashWithReason("npx eve@latest init support-agent", compiledSkill.compiledBash)).not.toBeNull();
    expect(matchBashWithReason("npm install eve@latest", compiledSkill.compiledBash)).not.toBeNull();
    expect(matchBashWithReason("vercel agent-runs --help", compiledSkill.compiledBash)).not.toBeNull();
    expect(matchBashWithReason("vc agent-runs some-subcommand --help", compiledSkill.compiledBash)).not.toBeNull();
    expect(matchBashWithReason("npm install evergreen", compiledSkill.compiledBash)).toBeNull();
  });
});
