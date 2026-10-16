import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
const SKILL_DIR = resolve(ROOT, "skills/vercel-tracing");

let compiledPromptSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const tracing = skills["vercel-tracing"];

  expect(tracing).toBeDefined();
  expect(tracing.priority).toBe(8);
  expect(tracing.promptSignals).toBeDefined();

  compiledPromptSignals = compilePromptSignals(tracing.promptSignals!);
  compiledSkill = compileSkillPatterns({ "vercel-tracing": tracing })[0];
});

function matchesPrompt(prompt: string): boolean {
  return matchPromptWithReason(
    normalizePromptText(prompt),
    compiledPromptSignals,
  ).matched;
}

describe("Vercel tracing prompt activation", () => {
  test.each([
    "My app is slow, make it faster.",
    "This endpoint is slow.",
    "Speed up my API route.",
    "Why is this page slow to load?",
    "Measure how long the database query takes.",
    "The checkout route takes 3 seconds.",
    "TTFB is high.",
    "Cold starts make my function slow.",
    "Improve performance of this API endpoint.",
  ])("matches application performance intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Set up instrumentation for my app deployed on Vercel.",
    "Add OpenTelemetry to my Express app on Vercel.",
    "Enable tracing for my project.",
    "Enable always-on tracing for production.",
    "Set up context propagation between my services.",
    "Propagate traceparent to my backend API.",
    "My traces are disconnected across services.",
    "Add a custom span around checkout.",
    "Find error spans for my Vercel project.",
    "Debug failed requests on my API.",
    "Investigate production errors in my app.",
    "Change the sampling rule for always-on tracing.",
    "Call registerOTel from my SvelteKit server hooks.",
    "Sentry is conflicting with my OTel setup.",
    "Add OTel instrumentation to my Hono app.",
  ])("matches setup, propagation, and debugging intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  // Slowness complaints from the Next.js and Remix load evals.
  test.each([
    "The dashboard page is really slow to load in production. Can you figure out why?",
    "Users are complaining checkout got sluggish since last week's deploy.",
    "Performance has degraded on /api/checkout — p95 went from 300ms to 2s.",
    "TTFB on our site is terrible, fix it",
    "Why does the dashboard take 4 seconds?",
    "Our Vercel functions are slow, can you speed them up?",
    "Something is making the checkout API slow, find the bottleneck",
    "Page loads are way slower than they used to be",
    "Why does the dashboard loader take 4 seconds?",
    "Something is making the checkout action slow, find the bottleneck",
  ])("matches slowness complaints: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Vercel build shows a stack trace.",
    "Next.js output file tracing is including too many files.",
    "Reduce bundle size to improve performance.",
    "Improve the performance of my LCP score.",
    "Improve Lighthouse score.",
    "Make the build faster.",
    "My build takes 5 minutes.",
    "Speed up my tests.",
    "My Turbopack dev server is slow.",
    "My React component re-renders too often.",
    "Add a loading spinner while the page is slow.",
    "The step indicator animation is slow.",
    "Write a blog post about latency.",
    "My build is sluggish on Vercel",
    "The dev server feels laggy with turbopack",
    "Scrolling feels laggy on mobile",
    "The animation is laggy when the modal opens",
    "Our test suite got slower than it used to be",
    "Add a p95 chart to the admin dashboard",
    "Count page loads per day",
    "The README is slower than it used to be to read",
    "The dropdown feels sluggish",
    "Speed up the CI",
    "Find the bottleneck in our webpack config",
    "The page transition animation is slow",
    "GitHub Actions are slow",
    "vercel deploy is slow",
    "My deployments are slow, they take 5 minutes",
    "Our page takes 10 seconds to build",
    "Optimize performance of my React app",
  ])("does not match build, browser, or unrelated intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });
});

describe("Vercel tracing artifact activation", () => {
  test.each([
    "vercel traces search --scope my-team --status error --since 1h",
    "vc traces inspect 0870e4ead46aafba39ccfbcb001835db --project my-app",
    "vercel traces config ls --json",
    "vercel curl /api/status --trace --deployment https://my-app-abc123.vercel.app",
  ])("matches tracing CLI commands: %s", (command) => {
    expect(matchBashWithReason(command, compiledSkill.compiledBash)).not.toBeNull();
  });

  test.each([
    "vercel curl /api/status --deployment https://my-app-abc123.vercel.app",
    "vercel logs my-app.vercel.app",
    "vercel deploy --prod",
    "npm run trace",
  ])("does not match unrelated CLI commands: %s", (command) => {
    expect(matchBashWithReason(command, compiledSkill.compiledBash)).toBeNull();
  });

  test.each([
    "import { registerOTel } from '@vercel/otel';",
    "import { trace } from '@opentelemetry/api';",
    'import { context, propagation } from "@opentelemetry/api";',
    "const { trace } = require('@opentelemetry/api');",
  ])("matches Vercel OpenTelemetry and OpenTelemetry API imports: %s", (content) => {
    expect(matchImportWithReason(content, compiledSkill.compiledImports)).not.toBeNull();
  });

  test.each([
    "import { logs } from '@opentelemetry/api-logs';",
    "import { NodeSDK } from '@opentelemetry/sdk-node';",
  ])("does not match other OpenTelemetry packages: %s", (content) => {
    expect(matchImportWithReason(content, compiledSkill.compiledImports)).toBeNull();
  });

  test("does not match application files by path", () => {
    expect(compiledSkill.compiledPaths).toHaveLength(0);
  });
});

describe("Vercel tracing guidance", () => {
  test("entrypoint routes performance work to measurement with custom spans", () => {
    const skill = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");

    expect(skill).toContain("[Performance](references/performance.md)");
    expect(skill).toContain("Measure before optimizing");
    expect(skill).toContain("startActiveSpan");
    expect(skill).toContain("When the cause looks obvious in the code");
  });

  test("description leads with instrumentation setup and keeps debugging as a secondary use", () => {
    const skill = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");
    const description = skill.match(/^description: (.+)$/m)?.[1] ?? "";

    expect(description).toMatch(/^Set up OpenTelemetry instrumentation for Vercel Tracing/);
    for (const term of ["@vercel/otel", "startup hook", "custom spans", "propagating trace context", "failed or slow"]) {
      expect(description).toContain(term);
    }
  });

  test("entrypoint limits tracing to requests that run server code", () => {
    const skill = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");

    expect(skill).toContain("Tracing only covers requests that run server code");
    expect(skill).toContain("Static and prerendered pages and CDN cache hits run no application code");
  });

  test("entrypoint presents the setup workflow before the investigation workflow", () => {
    const skill = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");
    const setup = skill.indexOf("## Setup workflow");
    const investigation = skill.indexOf("## Investigation workflow");

    expect(setup).toBeGreaterThan(-1);
    expect(setup).toBeLessThan(investigation);
    expect(skill).toContain("never register a second one");
  });

  test("custom spans reference owns the measure helper", () => {
    const reference = readFileSync(resolve(SKILL_DIR, "references/custom-spans.md"), "utf8");

    expect(reference).toContain("export function measure<T>(");
    expect(reference).toContain("tracer.startActiveSpan(name, { attributes }, async (span) => {");
    expect(reference).toContain("span.recordException(error)");
    expect(reference).toContain("span.end();");
  });

  test("performance reference uses the custom spans helper to measure before changing code", () => {
    const reference = readFileSync(resolve(SKILL_DIR, "references/performance.md"), "utf8");

    expect(reference).toContain("`measure` helper from [custom spans](custom-spans.md)");
    expect(reference).not.toContain("export function measure<T>(");
    expect(reference).toContain("`span.duration` is in milliseconds");
    expect(reference).toContain("[seconds, nanoseconds]");
    expect(reference).toContain("critical path");
  });

  test("inspection accepts trace IDs and request IDs through inspect", () => {
    const reference = readFileSync(resolve(SKILL_DIR, "references/inspection.md"), "utf8");

    expect(reference).toContain("`vercel traces inspect` accepts either a trace ID or a request ID");
    expect(reference).toContain("vercel traces inspect 0870e4ead46aafba39ccfbcb001835db --scope my-team --project my-app");
    expect(reference).toContain("deprecation warning");
    expect(reference).not.toContain("Do not pass a trace ID");
  });

  test.each(["nextjs", "sveltekit"])(
    "entrypoint links the %s framework reference",
    (framework) => {
      const skill = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");
      const reference = readFileSync(resolve(SKILL_DIR, `references/${framework}.md`), "utf8");

      expect(skill).toContain(`(references/${framework}.md)`);
      expect(reference).toContain("registerOTel({ serviceName: 'checkout' })");
      expect(reference).toContain("[SDK ownership](instrumentation.md)");
    },
  );

  test("sveltekit reference covers SvelteKit 3 and 2.31+ configuration", () => {
    const reference = readFileSync(resolve(SKILL_DIR, "references/sveltekit.md"), "utf8");

    expect(reference).toContain("sveltekit({ tracing: { server: true } })");
    expect(reference).toContain("instrumentation: { server: true }");
  });

  test("no framework reference outside the supported set", () => {
    const skill = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");

    expect(skill).not.toContain("references/remix.md");
    expect(existsSync(resolve(SKILL_DIR, "references/remix.md"))).toBe(false);
  });

  test("propagation matchers use full URLs, not bare hosts", () => {
    const reference = readFileSync(resolve(SKILL_DIR, "references/context-propagation.md"), "utf8");

    expect(reference).toContain("propagateContextUrls: ['https://api.example.com/'");
    expect(reference).not.toMatch(/propagateContextUrls: \['api\./);
    expect(reference).toContain("propagation.inject(context.active(), carrier)");
  });
});
