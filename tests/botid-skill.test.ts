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

let botidSignals: CompiledPromptSignals;
let firewallSignals: CompiledPromptSignals;
let botidSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const botid = skills["botid"];
  const firewall = skills["vercel-firewall"];

  expect(botid).toBeDefined();
  expect(botid.promptSignals).toBeDefined();
  expect(firewall.promptSignals).toBeDefined();

  botidSignals = compilePromptSignals(botid.promptSignals!);
  firewallSignals = compilePromptSignals(firewall.promptSignals!);
  botidSkill = compileSkillPatterns({ botid })[0];
});

function matches(signals: CompiledPromptSignals, prompt: string): boolean {
  return matchPromptWithReason(normalizePromptText(prompt), signals).matched;
}

describe("BotID prompt activation", () => {
  test.each([
    "Add BotID to my signup route.",
    "Add BotID to my AI chatbot endpoint.",
    "Protect my checkout from bots.",
    "Stop bots hitting my AI chat endpoint on Vercel.",
    "Why does checkBotId always return isBot in production?",
    "Set up initBotId for my server action.",
    "Add a CAPTCHA to my login form.",
    "Enable Deep Analysis to catch bots on checkout.",
  ])("matches BotID intent: %s", (prompt) => {
    expect(matches(botidSignals, prompt)).toBe(true);
  });

  test.each([
    "Do a deep analysis of this codebase.",
    "Build me a chatbot with the AI SDK.",
    "Build a Slack bot with Next.js.",
    "Create a Discord bot that answers support questions.",
    "Block AI crawlers on my Vercel site.",
  ])("does not match unrelated intent: %s", (prompt) => {
    expect(matches(botidSignals, prompt)).toBe(false);
  });
});

describe("Firewall bot prompts", () => {
  test.each([
    "Block AI crawlers on my Vercel site.",
    "Set the AI bots ruleset to log.",
    "Let verified bots through but challenge everything else.",
  ])("routes to vercel-firewall: %s", (prompt) => {
    expect(matches(firewallSignals, prompt)).toBe(true);
  });
});

describe("BotID artifact activation", () => {
  test.each([
    "import { checkBotId } from 'botid/server';",
    "import { initBotId } from 'botid/client/core';",
  ])("matches botid imports: %s", (source) => {
    expect(matchImportWithReason(source, botidSkill.compiledImports)).not.toBeNull();
  });

  test.each(["npm i botid", "pnpm add botid", "bun add botid"])(
    "matches installs: %s",
    (command) => {
      expect(matchBashWithReason(command, botidSkill.compiledBash)).not.toBeNull();
    },
  );

  test("does not match similarly named packages", () => {
    expect(matchBashWithReason("npm i botid-utils", botidSkill.compiledBash)).toBeNull();
  });
});
