import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  compileSkillPatterns,
  matchBashWithReason,
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

let signals: CompiledPromptSignals;
let skill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const clientSideSecurity = skills["client-side-security"];

  expect(clientSideSecurity).toBeDefined();
  expect(clientSideSecurity.promptSignals).toBeDefined();

  signals = compilePromptSignals(clientSideSecurity.promptSignals!);
  skill = compileSkillPatterns({ "client-side-security": clientSideSecurity })[0];
});

function matches(prompt: string): boolean {
  return matchPromptWithReason(normalizePromptText(prompt), signals).matched;
}

describe("client-side-security prompt activation", () => {
  test.each([
    "Add a Content Security Policy to my site.",
    "Add a CSP to my Next.js app.",
    "Set a CSP header on Vercel.",
    "Why is my CSP blocking scripts? I see a CSP violation in the console.",
    "Turn on Page Integrity for this project.",
    "Monitor the third-party scripts on my checkout page.",
    "Ship the policy as Content-Security-Policy-Report-Only first.",
    "Add security headers to my app.",
  ])("matches client-side security intent: %s", (prompt) => {
    expect(matches(prompt)).toBe(true);
  });

  test.each([
    "Rate limit my API routes on Vercel.",
    "Protect my signup form from bots.",
    "Generate a nonce for the OAuth state parameter.",
    "Set up cloud security posture management for AWS.",
  ])("does not match unrelated intent: %s", (prompt) => {
    expect(matches(prompt)).toBe(false);
  });
});

describe("client-side-security bash activation", () => {
  test.each([
    "vercel page-integrity status",
    "vercel page-integrity enable --project my-app",
    `vercel routes add "CSP" --src "/(.*)" --set-response-header "Content-Security-Policy=default-src 'self'"`,
  ])("matches: %s", (command) => {
    expect(matchBashWithReason(command, skill.compiledBash)).not.toBeNull();
  });

  test("does not match routes that don't touch CSP", () => {
    expect(
      matchBashWithReason(
        `vercel routes add "Cache" --src "/(.*)" --set-response-header "Cache-Control=no-store"`,
        skill.compiledBash,
      ),
    ).toBeNull();
  });
});
