import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
const SKILL_PATH = resolve(ROOT, "skills/queues/SKILL.md");

let compiledPromptSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const queues = skills["queues"];

  expect(queues).toBeDefined();
  expect(queues.priority).toBe(6);
  expect(queues.promptSignals).toBeDefined();

  compiledPromptSignals = compilePromptSignals(queues.promptSignals!);
  compiledSkill = compileSkillPatterns({ queues })[0];
});

function matchesPrompt(prompt: string): boolean {
  return matchPromptWithReason(
    normalizePromptText(prompt),
    compiledPromptSignals,
  ).matched;
}

describe("Vercel Queues prompt activation", () => {
  test.each([
    "Set up Vercel Queues to process orders in the background.",
    "Add a background job that sends the welcome email after signup.",
    "Publish events to a topic and fan out to two consumers on Vercel.",
    "How do I retry a failed queue consumer on Vercel?",
    "Add a queue to my Vercel app to buffer webhook traffic.",
    "Set up Vercel Queues so my deployments can retry failed webhooks.",
    "Vercel Queues up messages while my consumer is down. How do I control retention?",
  ])("matches Queues intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Consume messages from an SQS queue in this Lambda.",
    "Set up BullMQ workers with Redis.",
    "Configure a Celery queue for my Django app.",
    "Add a Kafka topic for analytics events.",
    "Fix the retry logic in this fetch wrapper.",
    "Why are my Vercel deployments stuck in the build queue and retrying?",
    "Why does Vercel queue my deployments?",
    "Vercel queues up deployments during a traffic spike, how do I speed it up?",
    "Vercel queues my deployments one at a time. Can I run them in parallel?",
    "Vercel queues builds when several commits land. Can I increase concurrency?",
  ])("does not match third-party or unrelated queue intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });
});

describe("Vercel Queues artifact activation", () => {
  test.each([
    "app/api/queues/process-order/route.ts",
    "src/app/api/queues/fulfill/route.ts",
    "lib/queue.ts",
    "src/lib/queues/orders.ts",
  ])("matches consumer and client paths: %s", (path) => {
    expect(matchPathWithReason(path, compiledSkill.compiledPaths)).not.toBeNull();
  });

  test.each(["npm install @vercel/queue", "pnpm add @vercel/queue", "uv add vercel-queue", "pip install vercel-queue"])(
    "matches SDK installs: %s",
    (command) => {
      expect(matchBashWithReason(command, compiledSkill.compiledBash)).not.toBeNull();
    },
  );

  test("matches @vercel/queue imports", () => {
    expect(
      matchImportWithReason("import { send } from '@vercel/queue';", compiledSkill.compiledImports),
    ).not.toBeNull();
  });

  test.each(["npm install bullmq", "vercel deploy"])(
    "does not match unrelated commands: %s",
    (command) => {
      expect(matchBashWithReason(command, compiledSkill.compiledBash)).toBeNull();
    },
  );
});

describe("Vercel Queues guidance", () => {
  test("teaches the documented SDK surface and trigger configuration", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");

    expect(skill).toContain("import { send } from '@vercel/queue';");
    expect(skill).toContain("import { handleCallback } from '@vercel/queue';");
    expect(skill).toContain('"experimentalTriggers": [{ "type": "queue/v2beta", "topic": "orders" }]');
    expect(skill).toContain("at-least-once");
    expect(skill).toContain("visibilityTimeoutSeconds");
    expect(skill).toContain("idempotencyKey");
    expect(skill).toContain("⤳ skill: workflow");
  });
});
