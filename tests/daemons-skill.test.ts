import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileSkillPatterns,
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
const SKILL_PATH = resolve(ROOT, "skills/daemons/SKILL.md");

let compiledPromptSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const daemons = skills["daemons"];

  expect(daemons).toBeDefined();
  expect(daemons.priority).toBe(6);
  expect(daemons.promptSignals).toBeDefined();

  compiledPromptSignals = compilePromptSignals(daemons.promptSignals!);
  compiledSkill = compileSkillPatterns({ daemons })[0];
});

function matchesPrompt(prompt: string): boolean {
  return matchPromptWithReason(
    normalizePromptText(prompt),
    compiledPromptSignals,
  ).matched;
}

describe("Vercel Daemons prompt activation", () => {
  test.each([
    "Set up a Vercel daemon that consumes my SQS queue.",
    "Add a daemon to my Vercel project for the BullMQ worker.",
    "Run a long-running worker on Vercel next to my Next.js app.",
    "Deploy my Celery worker on Vercel alongside the FastAPI service.",
    "How do I run Sidekiq on Vercel?",
    "Configure the daemons key in vercel.json with two instances in iad1.",
    "I need an always-on worker on Vercel that polls Vercel Queues.",
  ])("matches Daemons intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Create a systemd service for this daemon.",
    "vercel dev fails because the Docker daemon is not running.",
    "Add a Kubernetes DaemonSet for the log shipper.",
    "Register a service worker for offline caching.",
    "Move this computation into a web worker.",
    "Add a background job that sends the welcome email after signup.",
    "Add an API Route Handler to my existing Next.js app.",
  ])("does not match unrelated intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });
});

describe("Vercel Daemons artifact activation", () => {
  test("matches the root vercel.json", () => {
    expect(matchPathWithReason("vercel.json", compiledSkill.compiledPaths)).not.toBeNull();
  });

  test("does not match unrelated files", () => {
    expect(matchPathWithReason("worker/Dockerfile", compiledSkill.compiledPaths)).toBeNull();
  });
});

describe("Vercel Daemons guidance", () => {
  test("teaches the documented configuration and runtime contract", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");

    expect(skill).toContain('"daemons": {');
    expect(skill).toContain('"entrypoint": "Dockerfile"');
    expect(skill).toContain('"instances": { "iad1": 2 }');
    expect(skill).toContain("`replicas` is a deprecated alias");
    expect(skill).toContain("SIGTERM");
    expect(skill).toContain("Production only during the beta");
    expect(skill).toContain("VERCEL_OIDC_TOKEN_FILE");
    expect(skill).toContain("PollingQueueClient");
    expect(skill).toContain("⤳ skill: queues");
  });

  // The platform default moved from 10s to 30s in vercel/api#99394.
  test("states the 30-second default shutdown grace period everywhere", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");

    expect(skill).toContain("`terminationGracePeriodSeconds` | `number` | No | Seconds to wait after `SIGTERM` before terminating, `0`–`3600`, default `30`");
    expect(skill).not.toMatch(/\b10\s?(s|sec|seconds)\b[^\n]*SIGTERM|SIGTERM[^\n]*\b10\s?(s|sec|seconds)\b/);
  });

  test("vercel.json examples never put daemons inside services", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");
    for (const m of skill.matchAll(/```json filename="vercel.json"\n([\s\S]*?)```/g)) {
      const config = JSON.parse(m[1]);
      expect(Object.keys(config)).toContain("daemons");
      for (const daemon of Object.values(config.daemons) as Record<string, unknown>[]) {
        expect(daemon).toHaveProperty("root");
        expect(daemon).toHaveProperty("entrypoint");
        expect(daemon).toHaveProperty("instances");
        expect(daemon).not.toHaveProperty("replicas");
      }
    }
  });
});
