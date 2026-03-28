import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDecisionCapsule,
  decisionCapsuleDir,
  persistDecisionCapsule,
  type DecisionCapsuleV1,
} from "../hooks/src/routing-decision-capsule.mts";
import type { RoutingDecisionTrace } from "../hooks/src/routing-decision-trace.mts";
import type { VerificationDirective } from "../hooks/src/verification-directive.mts";
import { runDecisionCat, formatDecisionCapsule } from "../src/commands/decision-cat.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli", "index.ts");
const SESSION_ID = "decision-cat-test";

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function makeTrace(): RoutingDecisionTrace {
  return {
    version: 2,
    decisionId: "test-decision-001",
    sessionId: SESSION_ID,
    hook: "PreToolUse",
    toolName: "Read",
    toolTarget: "app/page.tsx",
    timestamp: "2026-03-28T02:30:00.000Z",
    primaryStory: {
      id: "story-1",
      kind: "flow-verification",
      storyRoute: "/settings",
      targetBoundary: "uiRender",
    },
    observedRoute: null,
    policyScenario: "PreToolUse|flow-verification|uiRender|Read",
    matchedSkills: ["nextjs", "react-best-practices"],
    injectedSkills: ["nextjs"],
    skippedReasons: [],
    ranked: [
      {
        skill: "nextjs",
        basePriority: 7,
        effectivePriority: 12,
        pattern: { type: "suffix", value: "app/**/*.tsx" },
        profilerBoost: 5,
        policyBoost: 0,
        policyReason: null,
        summaryOnly: false,
        synthetic: false,
        droppedReason: null,
      },
    ],
    verification: {
      verificationId: "verify-1",
      observedBoundary: null,
      matchedSuggestedAction: null,
    },
  };
}

function makeDirective(): VerificationDirective {
  return {
    version: 1,
    storyId: "story-1",
    storyKind: "flow-verification",
    route: "/settings",
    missingBoundaries: ["uiRender"],
    satisfiedBoundaries: ["clientRequest", "serverHandler"],
    primaryNextAction: {
      action: "open /settings in agent-browser",
      targetBoundary: "uiRender",
      reason: "No UI render observation yet",
    },
    blockedReasons: [],
  };
}

function makeCapsule(): DecisionCapsuleV1 {
  return buildDecisionCapsule({
    sessionId: SESSION_ID,
    hook: "PreToolUse",
    createdAt: "2026-03-28T02:30:00.000Z",
    toolName: "Read",
    toolTarget: "app/page.tsx",
    platform: "claude-code",
    trace: makeTrace(),
    directive: makeDirective(),
    attribution: {
      exposureGroupId: "group-1",
      candidateSkill: "nextjs",
      loadedSkills: ["nextjs"],
    },
    reasons: {
      nextjs: { trigger: "suffix", reasonCode: "pattern-match" },
    },
    env: { VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings" },
  });
}

afterEach(() => {
  rmSync(decisionCapsuleDir(SESSION_ID), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit: runDecisionCat
// ---------------------------------------------------------------------------

describe("runDecisionCat", () => {
  test("returns JSON with ok:true for valid capsule", () => {
    const capsule = makeCapsule();
    const path = persistDecisionCapsule(capsule);
    const { output, ok } = runDecisionCat(path, true);
    const parsed = JSON.parse(output);

    expect(ok).toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.capsule.decisionId).toBe("test-decision-001");
    expect(parsed.capsule.sha256).toBe(capsule.sha256);
  });

  test("returns JSON with ok:false for missing file", () => {
    const { output, ok } = runDecisionCat("/tmp/nonexistent-capsule.json", true);
    const parsed = JSON.parse(output);

    expect(ok).toBe(false);
    expect(parsed.ok).toBe(false);
    expect(parsed.capsule).toBeNull();
    expect(parsed.error).toContain("nonexistent-capsule.json");
  });

  test("returns human-readable text for valid capsule", () => {
    const capsule = makeCapsule();
    const path = persistDecisionCapsule(capsule);
    const { output, ok } = runDecisionCat(path, false);

    expect(ok).toBe(true);
    expect(output).toContain("Decision: test-decision-001");
    expect(output).toContain("Hook: PreToolUse");
    expect(output).toContain("Tool: Read");
    expect(output).toContain("Target: app/page.tsx");
    expect(output).toContain("Story: flow-verification (/settings)");
    expect(output).toContain("Injected: nextjs");
    expect(output).toContain("Candidate: nextjs");
    expect(output).toContain("SHA256:");
  });

  test("returns error text for missing file", () => {
    const { output, ok } = runDecisionCat("/tmp/nonexistent-capsule.json", false);

    expect(ok).toBe(false);
    expect(output).toContain("Decision capsule not found");
  });
});

// ---------------------------------------------------------------------------
// Unit: formatDecisionCapsule
// ---------------------------------------------------------------------------

describe("formatDecisionCapsule", () => {
  test("includes issues section when issues exist", () => {
    const capsule = makeCapsule();
    const text = formatDecisionCapsule(capsule);

    expect(text).toContain("Issues:");
    expect(text).toContain("machine_output_hidden_in_html_comment");
  });

  test("shows 'none' for missing optional fields", () => {
    const capsule = makeCapsule();
    capsule.injectedSkills = [];
    capsule.attribution = null;
    capsule.activeStory = { id: null, kind: null, route: null, targetBoundary: null };

    const text = formatDecisionCapsule(capsule);

    expect(text).toContain("Injected: none");
    expect(text).toContain("Candidate: none");
    expect(text).toContain("Story: none");
  });
});

// ---------------------------------------------------------------------------
// CLI integration: decision-cat
// ---------------------------------------------------------------------------

describe("CLI decision-cat", () => {
  test("--help prints usage with decision-cat", async () => {
    const { stdout, exitCode } = await runCli("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("decision-cat");
  });

  test("decision-cat with no args exits 1", async () => {
    const { stderr, exitCode } = await runCli("decision-cat");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires");
  });

  test("decision-cat --json returns valid JSON for a persisted capsule", async () => {
    const capsule = makeCapsule();
    const path = persistDecisionCapsule(capsule);

    const { stdout, exitCode } = await runCli("decision-cat", path, "--json");
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.capsule.decisionId).toBe("test-decision-001");
    expect(parsed.capsule.sha256).toBe(capsule.sha256);
  });

  test("decision-cat prints human summary for a persisted capsule", async () => {
    const capsule = makeCapsule();
    const path = persistDecisionCapsule(capsule);

    const { stdout, exitCode } = await runCli("decision-cat", path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Decision: test-decision-001");
    expect(stdout).toContain("Hook: PreToolUse");
    expect(stdout).toContain("Candidate: nextjs");
    expect(stdout).toContain("SHA256:");
  });

  test("decision-cat --json returns ok:false for missing file", async () => {
    const { stdout, exitCode } = await runCli(
      "decision-cat",
      "/tmp/no-such-capsule.json",
      "--json",
    );
    expect(exitCode).toBe(2);

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.capsule).toBeNull();
  });

  test("decision-cat exits 2 for missing file (text mode)", async () => {
    const { stderr, exitCode } = await runCli(
      "decision-cat",
      "/tmp/no-such-capsule.json",
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not found");
  });
});
