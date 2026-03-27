import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendPendingLaunch, type PendingLaunch } from "../hooks/src/subagent-state.mts";
import {
  recordStory,
  recordObservation,
  loadObservations,
  loadStories,
  derivePlan,
  persistPlanState,
  type VerificationObservation,
  type VerificationBoundary,
} from "../hooks/src/verification-ledger.mts";
import { computePlan, selectPrimaryStory, type VerificationPlanResult } from "../hooks/src/verification-plan.mts";
import {
  buildVerificationContext,
  buildVerificationContextFromPlan,
  buildVerificationDirective,
  buildVerificationEnv,
  resolveBudgetCategory,
} from "../hooks/src/subagent-start-bootstrap.mts";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "subagent-start-bootstrap.mjs");

let testSession: string;
let tempDir: string;

beforeEach(() => {
  testSession = `subagent-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tempDir = mkdtempSync(join(tmpdir(), "subagent-ctx-"));
});

/**
 * Run the SubagentStart bootstrap hook by piping JSON on stdin.
 */
async function runSubagentStart(
  input: {
    session_id?: string;
    agent_id?: string;
    agent_type?: string;
    cwd?: string;
  },
  env?: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({
    session_id: testSession,
    hook_event_name: "SubagentStart",
    ...input,
  });

  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_LOG_LEVEL: "off",
      ...env,
    },
  });

  proc.stdin.write(payload);
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function parseContext(stdout: string): string {
  if (!stdout.trim()) return "";
  const parsed = JSON.parse(stdout);
  return parsed?.hookSpecificOutput?.additionalContext || "";
}

/**
 * Write a fake profile cache to disk so the hook can read it.
 */
function writeProfileCache(sessionId: string, likelySkills: string[]): void {
  // Profile cache path follows: <tmpdir>/vercel-plugin-<sessionId>-profile.json
  const cachePath = join(tmpdir(), `vercel-plugin-${sessionId}-profile.json`);
  writeFileSync(
    cachePath,
    JSON.stringify({
      projectRoot: "/Users/me/project",
      likelySkills,
      greenfield: false,
      bootstrapHints: [],
      resourceHints: [],
      setupMode: false,
      agentBrowserAvailable: false,
      timestamp: new Date().toISOString(),
    }),
    "utf-8",
  );
}

function cleanupProfileCache(sessionId: string): void {
  const cachePath = join(tmpdir(), `vercel-plugin-${sessionId}-profile.json`);
  try {
    rmSync(cachePath, { force: true });
  } catch {}
}

function cleanupPendingLaunches(sessionId: string): void {
  const pendingLaunchPath = join(tmpdir(), `vercel-plugin-${sessionId}-pending-launches.jsonl`);
  try {
    rmSync(pendingLaunchPath, { force: true });
    rmSync(`${pendingLaunchPath}.lock`, { force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("subagent-start-context: additionalContext per agent type", () => {
  test("Explore agent receives minimal budget context", async () => {
    writeProfileCache(testSession, ["nextjs", "vercel-storage"]);

    try {
      const { code, stdout } = await runSubagentStart({
        agent_id: "explore-1",
        agent_type: "Explore",
      });

      expect(code).toBe(0);
      const ctx = parseContext(stdout);
      expect(ctx).toContain('budget="minimal"');
      expect(ctx).toContain('agent_type="Explore"');
      expect(ctx).toContain("nextjs");
      expect(ctx).toContain("vercel-storage");
    } finally {
      cleanupProfileCache(testSession);
    }
  });

  test("Plan agent receives light budget context with summaries", async () => {
    writeProfileCache(testSession, ["nextjs", "vercel-storage"]);

    try {
      const { code, stdout } = await runSubagentStart({
        agent_id: "plan-1",
        agent_type: "Plan",
      });

      expect(code).toBe(0);
      const ctx = parseContext(stdout);
      expect(ctx).toContain('budget="light"');
      expect(ctx).toContain('agent_type="Plan"');
      expect(ctx).toContain("nextjs");
    } finally {
      cleanupProfileCache(testSession);
    }
  });

  test("general-purpose agent receives standard budget context", async () => {
    writeProfileCache(testSession, ["nextjs"]);

    try {
      const { code, stdout } = await runSubagentStart({
        agent_id: "gp-1",
        agent_type: "general-purpose",
      });

      expect(code).toBe(0);
      const ctx = parseContext(stdout);
      expect(ctx).toContain('budget="standard"');
      expect(ctx).toContain('agent_type="general-purpose"');
      expect(ctx).toContain("nextjs");
    } finally {
      cleanupProfileCache(testSession);
    }
  });

  test("unknown agent type falls back to standard budget", async () => {
    writeProfileCache(testSession, ["nextjs"]);

    try {
      const { code, stdout } = await runSubagentStart({
        agent_id: "custom-1",
        agent_type: "my-custom-agent",
      });

      expect(code).toBe(0);
      const ctx = parseContext(stdout);
      expect(ctx).toContain('budget="standard"');
      expect(ctx).toContain('agent_type="my-custom-agent"');
    } finally {
      cleanupProfileCache(testSession);
    }
  });
});

describe("subagent-start-context: budget enforcement", () => {
  test("Explore context stays within 1KB budget", async () => {
    // Give it many skills to potentially exceed budget
    writeProfileCache(testSession, [
      "nextjs", "vercel-storage", "ai-sdk", "shadcn", "auth",
      "vercel-functions", "turborepo",
    ]);

    try {
      const { code, stdout } = await runSubagentStart({
        agent_id: "explore-budget",
        agent_type: "Explore",
      });

      expect(code).toBe(0);
      const ctx = parseContext(stdout);
      expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(1024);
    } finally {
      cleanupProfileCache(testSession);
    }
  });

  test("Plan context stays within 3KB budget", async () => {
    writeProfileCache(testSession, [
      "nextjs", "vercel-storage", "ai-sdk", "shadcn", "auth",
      "vercel-functions", "turborepo",
    ]);

    try {
      const { code, stdout } = await runSubagentStart({
        agent_id: "plan-budget",
        agent_type: "Plan",
      });

      expect(code).toBe(0);
      const ctx = parseContext(stdout);
      expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(3072);
    } finally {
      cleanupProfileCache(testSession);
    }
  });

  test("general-purpose context stays within 8KB budget", async () => {
    writeProfileCache(testSession, [
      "nextjs", "vercel-storage", "ai-sdk", "shadcn", "auth",
      "vercel-functions", "turborepo",
    ]);

    try {
      const { code, stdout } = await runSubagentStart({
        agent_id: "gp-budget",
        agent_type: "general-purpose",
      });

      expect(code).toBe(0);
      const ctx = parseContext(stdout);
      expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(8000);
    } finally {
      cleanupProfileCache(testSession);
    }
  });
});

describe("subagent-start-context: profile cache and fallback", () => {
  test("falls back to VERCEL_PLUGIN_LIKELY_SKILLS env when no profile cache", async () => {
    // No profile cache written — should fall back to env var
    const { code, stdout } = await runSubagentStart(
      {
        agent_id: "fallback-1",
        agent_type: "general-purpose",
      },
      {
        VERCEL_PLUGIN_LIKELY_SKILLS: "nextjs,ai-sdk",
      },
    );

    expect(code).toBe(0);
    const ctx = parseContext(stdout);
    expect(ctx).toContain("nextjs");
    expect(ctx).toContain("ai-sdk");
  });

  test("returns context even with no likely skills", async () => {
    const { code, stdout } = await runSubagentStart(
      {
        agent_id: "empty-1",
        agent_type: "Explore",
      },
      {
        VERCEL_PLUGIN_LIKELY_SKILLS: "",
      },
    );

    expect(code).toBe(0);
    const ctx = parseContext(stdout);
    expect(ctx).toContain("Vercel plugin active");
    expect(ctx).toContain("unknown stack");
  });

  test("merges pending launch prompt matches into likely skills before context assembly", async () => {
    writeProfileCache(testSession, ["nextjs"]);

    const pendingLaunch: PendingLaunch = {
      description: "Plan a durable workflow",
      prompt: "Use Workflow DevKit retries and step orchestration for this task",
      subagent_type: "Plan",
      createdAt: Date.now(),
    };
    appendPendingLaunch(testSession, pendingLaunch);

    try {
      const firstRun = await runSubagentStart({
        agent_id: "plan-prompt",
        agent_type: "Plan",
      });

      expect(firstRun.code).toBe(0);
      const firstContext = parseContext(firstRun.stdout);
      expect(firstContext).toContain("Project likely uses: workflow, nextjs.");

      const secondRun = await runSubagentStart({
        agent_id: "plan-prompt-2",
        agent_type: "Plan",
      });

      expect(secondRun.code).toBe(0);
      const secondContext = parseContext(secondRun.stdout);
      expect(secondContext).toContain("Project likely uses: nextjs.");
    } finally {
      cleanupProfileCache(testSession);
      cleanupPendingLaunches(testSession);
    }
  });

  test("empty stdin produces empty output (no crash)", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_LOG_LEVEL: "off" },
    });

    proc.stdin.write("");
    proc.stdin.end();

    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Verification context scoping helpers
// ---------------------------------------------------------------------------

const T0 = "2026-03-26T12:00:00.000Z";

function makeObs(
  id: string,
  boundary: VerificationBoundary,
  opts?: Partial<VerificationObservation>,
): VerificationObservation {
  return {
    id,
    timestamp: T0,
    source: "bash",
    boundary,
    route: null,
    summary: `obs-${id}`,
    ...opts,
  };
}

let verificationSessionId: string;

// ---------------------------------------------------------------------------
// Verification context: unit tests for buildVerificationContext
// ---------------------------------------------------------------------------

describe("subagent-start-context: verification context scoping", () => {
  beforeEach(() => {
    verificationSessionId = `subagent-ver-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try {
      rmSync(join(tmpdir(), `vercel-plugin-${verificationSessionId}-ledger`), { recursive: true, force: true });
    } catch {}
  });

  test("returns null when no verification plan exists", () => {
    const ctx = buildVerificationContext(verificationSessionId, "minimal");
    expect(ctx).toBeNull();
  });

  test("returns null when no session id provided", () => {
    const ctx = buildVerificationContext(undefined, "standard");
    expect(ctx).toBeNull();
  });

  test("Explore agent gets minimal verification context (story + route only)", () => {
    recordStory(verificationSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    recordObservation(verificationSessionId, makeObs("v1", "clientRequest", { route: "/settings" }));

    const ctx = buildVerificationContext(verificationSessionId, "minimal");
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain('scope="minimal"');
    expect(ctx!).toContain("flow-verification");
    expect(ctx!).toContain("/settings");
    // Minimal should NOT include missing boundaries or actions
    expect(ctx!).not.toContain("Missing boundaries");
    expect(ctx!).not.toContain("Primary action");
  });

  test("Plan agent gets light verification context (story + missing boundaries + candidate)", () => {
    recordStory(verificationSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    recordObservation(verificationSessionId, makeObs("v1", "clientRequest", { route: "/settings" }));

    const ctx = buildVerificationContext(verificationSessionId, "light");
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain('scope="light"');
    expect(ctx!).toContain("flow-verification");
    expect(ctx!).toContain("/settings");
    expect(ctx!).toContain("Missing boundaries:");
    expect(ctx!).toContain("Candidate action:");
  });

  test("general-purpose agent gets standard verification context (full evidence + action)", () => {
    recordStory(verificationSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    recordObservation(verificationSessionId, makeObs("v1", "clientRequest", { route: "/settings" }));
    recordObservation(verificationSessionId, makeObs("v2", "serverHandler", { route: "/settings" }));

    const ctx = buildVerificationContext(verificationSessionId, "standard");
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain('scope="standard"');
    expect(ctx!).toContain("flow-verification");
    expect(ctx!).toContain("Evidence: 2/4 boundaries");
    expect(ctx!).toContain("Missing:");
    expect(ctx!).toContain("Primary action:");
    expect(ctx!).toContain("Reason:");
  });

  test("standard context includes recent routes", () => {
    recordStory(verificationSessionId, "flow-verification", "/settings", "test", []);
    recordObservation(verificationSessionId, makeObs("v1", "clientRequest", { route: "/settings" }));
    recordObservation(verificationSessionId, makeObs("v2", "serverHandler", { route: "/dashboard" }));

    const ctx = buildVerificationContext(verificationSessionId, "standard");
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain("Recent routes:");
    expect(ctx!).toContain("/settings");
    expect(ctx!).toContain("/dashboard");
  });

  test("light context includes blocked reasons", () => {
    recordStory(verificationSessionId, "flow-verification", null, "test", []);
    recordObservation(verificationSessionId, makeObs("v1", "clientRequest"));
    recordObservation(verificationSessionId, makeObs("v2", "serverHandler"));
    recordObservation(verificationSessionId, makeObs("v3", "environment"));
    // Need to force browser unavailability — the cached plan was derived with defaults.
    // Re-derive with browser unavailable so the cached state reflects it.
    const obs = loadObservations(verificationSessionId);
    const stories = loadStories(verificationSessionId);
    const plan = derivePlan(obs, stories, { agentBrowserAvailable: false });
    persistPlanState(verificationSessionId, plan);

    const ctx = buildVerificationContext(verificationSessionId, "light");
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain("Blocked:");
  });
});

// ---------------------------------------------------------------------------
// Verification context: fixture scenarios
// ---------------------------------------------------------------------------

describe("subagent-start-context: verification fixtures", () => {
  beforeEach(() => {
    verificationSessionId = `subagent-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try {
      rmSync(join(tmpdir(), `vercel-plugin-${verificationSessionId}-ledger`), { recursive: true, force: true });
    } catch {}
  });

  test("settings page loads but save fails — scoped context per agent type", () => {
    recordStory(verificationSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    recordObservation(verificationSessionId, makeObs("f1", "clientRequest", { route: "/settings" }));

    const minimal = buildVerificationContext(verificationSessionId, "minimal");
    const light = buildVerificationContext(verificationSessionId, "light");
    const standard = buildVerificationContext(verificationSessionId, "standard");

    // All should mention the story
    expect(minimal).toContain("flow-verification");
    expect(light).toContain("flow-verification");
    expect(standard).toContain("flow-verification");

    // Light and standard should have missing boundaries
    expect(light).toContain("Missing boundaries:");
    expect(standard).toContain("Missing:");

    // Standard should have evidence count
    expect(standard).toContain("Evidence: 1/4 boundaries");
  });

  test("blank page on dashboard — all agent types get context", () => {
    recordStory(verificationSessionId, "browser-only", "/dashboard", "blank page on dashboard", ["agent-browser-verify"]);

    const minimal = buildVerificationContext(verificationSessionId, "minimal");
    const light = buildVerificationContext(verificationSessionId, "light");
    const standard = buildVerificationContext(verificationSessionId, "standard");

    expect(minimal).toContain("browser-only");
    expect(minimal).toContain("/dashboard");
    expect(light).toContain("blank page on dashboard");
    expect(standard).toContain("blank page on dashboard");
    expect(standard).toContain("Evidence: 0/4 boundaries");
  });

  test("env inspection — environment boundary satisfied", () => {
    recordStory(verificationSessionId, "stuck-investigation", null, "env vars missing", []);
    recordObservation(verificationSessionId, makeObs("e1", "environment", { summary: "printenv" }));

    const standard = buildVerificationContext(verificationSessionId, "standard");
    expect(standard).toContain("environment");
    expect(standard).toContain("Evidence: 1/4 boundaries");
  });
});

// ---------------------------------------------------------------------------
// Evidence isolation between sibling subagents
// ---------------------------------------------------------------------------

describe("subagent-start-context: evidence isolation", () => {
  let siblingSession: string;

  beforeEach(() => {
    siblingSession = `sibling-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try {
      rmSync(join(tmpdir(), `vercel-plugin-${siblingSession}-ledger`), { recursive: true, force: true });
    } catch {}
  });

  test("sibling agents do not overwrite each other's verification state", () => {
    // Parent session creates a story
    recordStory(siblingSession, "flow-verification", "/settings", "settings broken", ["verification"]);

    // Subagent A records an observation
    recordObservation(siblingSession, makeObs("agent-a-obs", "clientRequest", {
      route: "/settings",
      source: "subagent",
      meta: { agentId: "explore-1" },
    }));

    // Subagent B records a different observation
    recordObservation(siblingSession, makeObs("agent-b-obs", "serverHandler", {
      route: "/settings",
      source: "subagent",
      meta: { agentId: "plan-1" },
    }));

    // Both observations should be visible to the parent session
    const obs = loadObservations(siblingSession);
    expect(obs).toHaveLength(2);
    expect(obs.find((o: VerificationObservation) => o.id === "agent-a-obs")).toBeTruthy();
    expect(obs.find((o: VerificationObservation) => o.id === "agent-b-obs")).toBeTruthy();

    // Plan should reflect both observations
    const plan = computePlan(siblingSession);
    expect(plan.satisfiedBoundaries).toContain("clientRequest");
    expect(plan.satisfiedBoundaries).toContain("serverHandler");
    expect(plan.observationCount).toBe(2);
  });

  test("observations from multiple subagents are idempotent by id", () => {
    recordStory(siblingSession, "flow-verification", null, "test", []);

    // Both agents try to record the same observation (e.g., race condition)
    recordObservation(siblingSession, makeObs("shared-obs", "clientRequest", {
      source: "subagent",
      meta: { agentId: "explore-1" },
    }));
    recordObservation(siblingSession, makeObs("shared-obs", "clientRequest", {
      source: "subagent",
      meta: { agentId: "plan-1" },
    }));

    const plan = computePlan(siblingSession);
    // Should only count once despite two appends
    expect(plan.observationCount).toBe(1);
  });

  test("deterministic planner output across repeated runs", () => {
    recordStory(siblingSession, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    recordObservation(siblingSession, makeObs("det-1", "clientRequest", { route: "/settings" }));
    recordObservation(siblingSession, makeObs("det-2", "serverHandler", { route: "/settings" }));

    const plan1 = computePlan(siblingSession);
    const plan2 = computePlan(siblingSession);
    const plan3 = computePlan(siblingSession);

    expect(JSON.stringify(plan1, null, 2)).toBe(JSON.stringify(plan2, null, 2));
    expect(JSON.stringify(plan2, null, 2)).toBe(JSON.stringify(plan3, null, 2));
  });
});

// ---------------------------------------------------------------------------
// buildVerificationContextFromPlan: deterministic story selection
// ---------------------------------------------------------------------------

describe("subagent-start-context: buildVerificationContextFromPlan", () => {
  test("uses primary story (most recently updated) for standard agents", () => {
    const plan: VerificationPlanResult = {
      hasStories: true,
      stories: [
        {
          id: "older",
          kind: "flow-verification",
          route: "/older",
          promptExcerpt: "older prompt",
          createdAt: "2026-03-27T00:00:00.000Z",
          updatedAt: "2026-03-27T00:00:00.000Z",
        },
        {
          id: "newer",
          kind: "flow-verification",
          route: "/settings",
          promptExcerpt: "verify settings flow",
          createdAt: "2026-03-27T00:01:00.000Z",
          updatedAt: "2026-03-27T00:02:00.000Z",
        },
      ],
      observationCount: 1,
      satisfiedBoundaries: ["serverHandler"],
      missingBoundaries: ["clientRequest", "environment", "uiRender"],
      recentRoutes: ["/settings"],
      primaryNextAction: {
        action: "curl <LOCAL_DEV_ORIGIN>/settings",
        targetBoundary: "clientRequest",
        reason: "No HTTP request observation yet — verify the endpoint responds",
      },
      blockedReasons: [],
    };

    const context = buildVerificationContextFromPlan(plan, "standard");
    expect(context).toContain("Verification story: flow-verification (/settings)");
    expect(context).toContain("Primary action:");
    expect(context).not.toContain("(/older)");
  });

  test("returns null for plan with no stories", () => {
    const plan: VerificationPlanResult = {
      hasStories: false,
      stories: [],
      observationCount: 0,
      satisfiedBoundaries: [],
      missingBoundaries: [],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: [],
    };

    expect(buildVerificationContextFromPlan(plan, "standard")).toBeNull();
  });

  test("minimal scope contains only story kind and route", () => {
    const plan: VerificationPlanResult = {
      hasStories: true,
      stories: [{
        id: "s1",
        kind: "browser-only",
        route: "/dashboard",
        promptExcerpt: "blank page",
        createdAt: T0,
        updatedAt: T0,
      }],
      observationCount: 0,
      satisfiedBoundaries: [],
      missingBoundaries: ["clientRequest", "environment", "serverHandler", "uiRender"],
      recentRoutes: [],
      primaryNextAction: { action: "curl /dashboard", targetBoundary: "clientRequest", reason: "test" },
      blockedReasons: [],
    };

    const ctx = buildVerificationContextFromPlan(plan, "minimal");
    expect(ctx).toContain("browser-only");
    expect(ctx).toContain("/dashboard");
    expect(ctx).not.toContain("Missing");
    expect(ctx).not.toContain("Primary action");
  });
});

// ---------------------------------------------------------------------------
// Verification directive and env
// ---------------------------------------------------------------------------

describe("subagent-start-context: verification directive", () => {
  test("buildVerificationDirective returns null for empty plan", () => {
    expect(buildVerificationDirective(null)).toBeNull();
    expect(buildVerificationDirective({
      hasStories: false,
      stories: [],
      observationCount: 0,
      satisfiedBoundaries: [],
      missingBoundaries: [],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: [],
    })).toBeNull();
  });

  test("buildVerificationDirective selects primary story", () => {
    const plan: VerificationPlanResult = {
      hasStories: true,
      stories: [
        { id: "old", kind: "flow-verification", route: "/old", promptExcerpt: "old", createdAt: T0, updatedAt: T0 },
        { id: "new", kind: "flow-verification", route: "/new", promptExcerpt: "new", createdAt: "2026-03-27T01:00:00.000Z", updatedAt: "2026-03-27T01:00:00.000Z" },
      ],
      observationCount: 1,
      satisfiedBoundaries: ["serverHandler"],
      missingBoundaries: ["clientRequest"],
      recentRoutes: [],
      primaryNextAction: { action: "curl /new", targetBoundary: "clientRequest", reason: "test" },
      blockedReasons: [],
    };

    const directive = buildVerificationDirective(plan);
    expect(directive).not.toBeNull();
    expect(directive!.version).toBe(1);
    expect(directive!.storyId).toBe("new");
    expect(directive!.route).toBe("/new");
    expect(directive!.primaryNextAction?.action).toBe("curl /new");
  });

  test("buildVerificationEnv returns env vars from directive", () => {
    const directive = {
      version: 1 as const,
      storyId: "abc123",
      storyKind: "flow-verification",
      route: "/settings",
      missingBoundaries: ["clientRequest"],
      satisfiedBoundaries: ["serverHandler"],
      primaryNextAction: {
        action: "curl <LOCAL_DEV_ORIGIN>/settings",
        targetBoundary: "clientRequest",
        reason: "test",
      },
      blockedReasons: [],
    };

    const env = buildVerificationEnv(directive);
    expect(env.VERCEL_PLUGIN_VERIFICATION_STORY_ID).toBe("abc123");
    expect(env.VERCEL_PLUGIN_VERIFICATION_ROUTE).toBe("/settings");
    expect(env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY).toBe("clientRequest");
    expect(env.VERCEL_PLUGIN_VERIFICATION_ACTION).toBe("curl <LOCAL_DEV_ORIGIN>/settings");
  });

  test("buildVerificationEnv returns empty when no next action", () => {
    const directive = {
      version: 1 as const,
      storyId: "abc",
      storyKind: "flow-verification",
      route: null,
      missingBoundaries: [],
      satisfiedBoundaries: [],
      primaryNextAction: null,
      blockedReasons: [],
    };

    expect(buildVerificationEnv(directive)).toEqual({
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: "",
      VERCEL_PLUGIN_VERIFICATION_ROUTE: "",
      VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "",
      VERCEL_PLUGIN_VERIFICATION_ACTION: "",
    });
  });
});
