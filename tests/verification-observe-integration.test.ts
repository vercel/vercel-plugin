import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildBoundaryEvent,
  classifyBoundary,
  envString,
  inferRoute,
  parseInput,
  redactCommand,
  resolveObservedRoute,
  run,
} from "../hooks/src/posttooluse-verification-observe.mts";
import {
  loadObservations,
  loadStories,
  loadPlanState,
  recordObservation,
  recordStory,
} from "../hooks/src/verification-ledger.mts";
import type { VerificationObservation } from "../hooks/src/verification-ledger.mts";
import {
  appendSkillExposure,
  loadProjectRoutingPolicy,
  loadSessionExposures,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import { scenarioKey } from "../hooks/src/routing-policy.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const T0 = "2026-03-26T12:00:00.000Z";

let testSessionId: string;

beforeEach(() => {
  testSessionId = `test-observe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${testSessionId}-ledger`), { recursive: true, force: true });
  } catch { /* ignore */ }
});

function makeStdinPayload(command: string, sessionId?: string): string {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    session_id: sessionId ?? testSessionId,
    cwd: ROOT,
  });
}

function makeObs(
  id: string,
  boundary: "uiRender" | "clientRequest" | "serverHandler" | "environment",
  opts?: Partial<VerificationObservation>,
): VerificationObservation {
  return {
    id,
    timestamp: T0,
    source: "bash",
    boundary,
    route: null,
    storyId: null,
    summary: `obs-${id}`,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// classifyBoundary
// ---------------------------------------------------------------------------

describe("classifyBoundary for verification observations", () => {
  test("pnpm dev records unknown (launch, not a boundary observation itself)", () => {
    // pnpm dev is a dev server launch — it doesn't directly match a boundary
    // unless it includes browser/curl/log/env patterns
    const result = classifyBoundary("pnpm dev");
    // dev server launch does not match any specific boundary pattern
    expect(result.boundary).toBe("unknown");
  });

  test("curl http://localhost:3000/settings records clientRequest", () => {
    const result = classifyBoundary("curl http://localhost:3000/settings");
    expect(result.boundary).toBe("clientRequest");
    expect(result.matchedPattern).toBe("http-client");
  });

  test("wget http://localhost:3000/api/users records clientRequest", () => {
    const result = classifyBoundary("wget http://localhost:3000/api/users");
    expect(result.boundary).toBe("clientRequest");
  });

  test("vercel logs records serverHandler", () => {
    const result = classifyBoundary("vercel logs");
    expect(result.boundary).toBe("serverHandler");
    expect(result.matchedPattern).toBe("vercel-logs");
  });

  test("tail -f server.log records serverHandler", () => {
    const result = classifyBoundary("tail -f server.log");
    expect(result.boundary).toBe("serverHandler");
  });

  test("printenv records environment", () => {
    const result = classifyBoundary("printenv");
    expect(result.boundary).toBe("environment");
  });

  test("vercel env pull records environment", () => {
    const result = classifyBoundary("vercel env pull");
    expect(result.boundary).toBe("environment");
  });

  test("cat .env.local records environment", () => {
    const result = classifyBoundary("cat .env.local");
    expect(result.boundary).toBe("environment");
  });

  test("open https://localhost:3000/ records uiRender", () => {
    const result = classifyBoundary("open https://localhost:3000/");
    expect(result.boundary).toBe("uiRender");
  });

  test("npx playwright test records uiRender", () => {
    const result = classifyBoundary("npx playwright test");
    expect(result.boundary).toBe("uiRender");
  });
});

// ---------------------------------------------------------------------------
// inferRoute
// ---------------------------------------------------------------------------

describe("inferRoute", () => {
  test("recent edits win over URL-derived routes", () => {
    const route = inferRoute(
      "curl http://localhost:3000/api/data",
      "app/settings/page.tsx",
    );
    expect(route).toBe("/settings");
  });

  test("URL route is fallback when no recent edits", () => {
    const route = inferRoute("curl http://localhost:3000/settings");
    expect(route).toBe("/settings");
  });

  test("preserves explicit null when neither source is reliable", () => {
    const route = inferRoute("echo hello");
    expect(route).toBeNull();
  });

  test("strips Next.js file suffixes from edit paths", () => {
    const route = inferRoute("ls", "app/dashboard/page.tsx");
    expect(route).toBe("/dashboard");
  });

  test("converts dynamic segments to param notation", () => {
    const route = inferRoute("ls", "app/users/[id]/page.tsx");
    expect(route).toBe("/users/:id");
  });
});

// ---------------------------------------------------------------------------
// redactCommand
// ---------------------------------------------------------------------------

describe("redactCommand", () => {
  test("redacts --token flag values", () => {
    const result = redactCommand("vercel --token skt_abc123xyz");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("skt_abc123xyz");
  });

  test("redacts --password flag values", () => {
    const result = redactCommand("mysql --password mysecretpass");
    expect(result).toContain("[REDACTED]");
  });

  test("truncates long commands to 200 chars plus suffix", () => {
    const longCmd = "echo " + "x".repeat(300);
    const result = redactCommand(longCmd);
    // redactCommand slices to 200 then appends "…[truncated]" suffix
    expect(result.length).toBeLessThanOrEqual(200 + "…[truncated]".length);
    expect(result).toContain("[truncated]");
  });

  test("preserves safe commands unchanged", () => {
    const cmd = "curl http://localhost:3000/settings";
    expect(redactCommand(cmd)).toBe(cmd);
  });
});

// ---------------------------------------------------------------------------
// parseInput
// ---------------------------------------------------------------------------

describe("parseInput", () => {
  test("parses valid Bash tool input", () => {
    const result = parseInput(makeStdinPayload("curl http://localhost:3000"));
    expect(result).not.toBeNull();
    expect(result!.command).toBe("curl http://localhost:3000");
    expect(result!.sessionId).toBe(testSessionId);
  });

  test("returns null for non-Bash tools", () => {
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/foo" },
    });
    expect(parseInput(payload)).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseInput("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ledger integration: observations persist through full cycle
// ---------------------------------------------------------------------------

describe("observation ledger integration", () => {
  test("pnpm dev trace does not record observation (unknown boundary)", () => {
    // pnpm dev → unknown → not recorded
    const { boundary } = classifyBoundary("pnpm dev");
    expect(boundary).toBe("unknown");
    // Only record if boundary is not unknown
    const before = loadObservations(testSessionId);
    expect(before).toHaveLength(0);
  });

  test("curl http://localhost:3000/settings records clientRequest with route /settings", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "test prompt", []);
    const obs = makeObs("curl-test", "clientRequest", {
      route: "/settings",
      summary: "curl http://localhost:3000/settings",
    });
    const plan = recordObservation(testSessionId, obs);
    expect(plan.satisfiedBoundaries.has("clientRequest")).toBe(true);
    expect(plan.recentRoutes).toContain("/settings");
  });

  test("vercel logs records serverHandler", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    const obs = makeObs("logs-test", "serverHandler", {
      summary: "vercel logs",
    });
    const plan = recordObservation(testSessionId, obs);
    expect(plan.satisfiedBoundaries.has("serverHandler")).toBe(true);
  });

  test("printenv records environment", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    const obs = makeObs("env-test", "environment", {
      summary: "printenv",
    });
    const plan = recordObservation(testSessionId, obs);
    expect(plan.satisfiedBoundaries.has("environment")).toBe(true);
  });

  test("full bash trace sequence builds up boundaries", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);

    // Simulate: curl → vercel logs → printenv
    recordObservation(testSessionId, makeObs("trace-1", "clientRequest", {
      route: "/settings",
      summary: "curl http://localhost:3000/settings",
    }));
    recordObservation(testSessionId, makeObs("trace-2", "serverHandler", {
      summary: "vercel logs",
    }));
    const finalPlan = recordObservation(testSessionId, makeObs("trace-3", "environment", {
      summary: "printenv",
    }));

    expect(finalPlan.observations).toHaveLength(3);
    expect(finalPlan.satisfiedBoundaries.has("clientRequest")).toBe(true);
    expect(finalPlan.satisfiedBoundaries.has("serverHandler")).toBe(true);
    expect(finalPlan.satisfiedBoundaries.has("environment")).toBe(true);
    // uiRender still missing
    expect(finalPlan.missingBoundaries).toContain("uiRender");
    expect(finalPlan.missingBoundaries).not.toContain("clientRequest");
  });

  test("observation ids are stable for dedup retries", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    const obs = makeObs("stable-id", "clientRequest");
    recordObservation(testSessionId, obs);
    const plan = recordObservation(testSessionId, obs); // retry
    expect(plan.observations.filter((o) => o.id === "stable-id")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Story creation from prompt
// ---------------------------------------------------------------------------

describe("verification story from prompt", () => {
  test("flow-verification story creation before any bash command", () => {
    const plan = recordStory(
      testSessionId,
      "flow-verification",
      "/settings",
      "settings page loads but save fails",
      ["verification"],
    );
    expect(plan.stories).toHaveLength(1);
    expect(plan.stories[0].kind).toBe("flow-verification");
    expect(plan.stories[0].route).toBe("/settings");
    expect(plan.missingBoundaries).toHaveLength(4); // all missing initially
  });

  test("stuck-investigation story creation", () => {
    const plan = recordStory(
      testSessionId,
      "stuck-investigation",
      null,
      "the page is stuck loading",
      ["investigation-mode"],
    );
    expect(plan.stories).toHaveLength(1);
    expect(plan.stories[0].kind).toBe("stuck-investigation");
  });

  test("browser-only story creation", () => {
    const plan = recordStory(
      testSessionId,
      "browser-only",
      "/dashboard",
      "blank page on dashboard",
      ["agent-browser-verify", "investigation-mode"],
    );
    expect(plan.stories).toHaveLength(1);
    expect(plan.stories[0].kind).toBe("browser-only");
  });

  test("repeated similar troubleshooting prompts merge into one active story", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    const plan = recordStory(testSessionId, "flow-verification", "/settings", "the settings page still fails on save", ["workflow"]);

    expect(plan.stories).toHaveLength(1); // merged, not duplicated
    expect(plan.stories[0].requestedSkills).toContain("verification");
    expect(plan.stories[0].requestedSkills).toContain("workflow");
    expect(plan.stories[0].promptExcerpt).toBe("the settings page still fails on save");
  });

  test("different routes create separate stories", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings broken", []);
    const plan = recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard broken", []);
    expect(plan.stories).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildBoundaryEvent
// ---------------------------------------------------------------------------

describe("buildBoundaryEvent", () => {
  test("redacts secrets and marks suggested matches", () => {
    const event = buildBoundaryEvent({
      command: "curl -H 'Authorization: Bearer sk-secret-value' http://localhost:3000/settings",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/settings",
      verificationId: "verification-1",
      timestamp: "2026-03-27T00:00:00.000Z",
      env: {
        VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "clientRequest",
        VERCEL_PLUGIN_VERIFICATION_ACTION: "curl http://localhost:3000/settings",
      } as NodeJS.ProcessEnv,
    });

    expect(event.command).toContain("[REDACTED]");
    expect(event.command).not.toContain("sk-secret-value");
    expect(event.suggestedBoundary).toBe("clientRequest");
    expect(event.matchedSuggestedAction).toBe(true);
  });

  test("matchedSuggestedAction is false when boundaries differ", () => {
    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000/api",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/api",
      verificationId: "v2",
      timestamp: "2026-03-27T00:00:00.000Z",
      env: {
        VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "serverHandler",
      } as NodeJS.ProcessEnv,
    });

    expect(event.matchedSuggestedAction).toBe(false);
  });

  test("handles missing env vars gracefully", () => {
    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000/test",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/test",
      verificationId: "v3",
      timestamp: "2026-03-27T00:00:00.000Z",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(event.suggestedBoundary).toBeNull();
    expect(event.suggestedAction).toBeNull();
    expect(event.matchedSuggestedAction).toBe(false);
  });

  test("truncates command to 200 characters", () => {
    const longCommand = "curl " + "x".repeat(300);
    const event = buildBoundaryEvent({
      command: longCommand,
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: null,
      verificationId: "v4",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(event.command.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// envString helper
// ---------------------------------------------------------------------------

describe("envString", () => {
  test("returns trimmed value for non-empty strings", () => {
    const env = { FOO: "  bar  " } as unknown as NodeJS.ProcessEnv;
    expect(envString(env, "FOO")).toBe("bar");
  });

  test("returns null for blank strings", () => {
    const env = { FOO: "   " } as unknown as NodeJS.ProcessEnv;
    expect(envString(env, "FOO")).toBeNull();
  });

  test("returns null for empty string", () => {
    const env = { FOO: "" } as unknown as NodeJS.ProcessEnv;
    expect(envString(env, "FOO")).toBeNull();
  });

  test("returns null for missing key", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(envString(env, "MISSING")).toBeNull();
  });

  test("returns null for undefined value", () => {
    const env = { FOO: undefined } as unknown as NodeJS.ProcessEnv;
    expect(envString(env, "FOO")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveObservedRoute
// ---------------------------------------------------------------------------

describe("resolveObservedRoute", () => {
  test("returns VERCEL_PLUGIN_VERIFICATION_ROUTE when inferred is null", () => {
    const env = { VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings" } as unknown as NodeJS.ProcessEnv;
    expect(resolveObservedRoute(null, env)).toBe("/settings");
  });

  test("prefers inferred route over env fallback", () => {
    const env = { VERCEL_PLUGIN_VERIFICATION_ROUTE: "/fallback" } as unknown as NodeJS.ProcessEnv;
    expect(resolveObservedRoute("/real", env)).toBe("/real");
  });

  test("returns null when both inferred and env are absent", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveObservedRoute(null, env)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Directive-env fallback closes the verified routing loop E2E
// ---------------------------------------------------------------------------

describe("directive-env fallback closes the routing policy loop", () => {
  const projectRoot = ROOT;

  function makeExposure(
    sessionId: string,
    overrides?: Partial<SkillExposure>,
  ): SkillExposure {
    return {
      id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      projectRoot,
      storyId: "story-1",
      storyKind: "flow-verification",
      route: "/settings",
      hook: "PreToolUse",
      toolName: "Bash",
      skill: "verification",
      targetBoundary: "clientRequest",
      exposureGroupId: null,
      attributionRole: "candidate",
      candidateSkill: null,
      createdAt: T0,
      resolvedAt: null,
      outcome: "pending",
      ...overrides,
    };
  }

  test("observer resolves pending exposure as directive-win via env fallback", () => {
    // --- Checkpoint 1: Seed a pending exposure ---
    const exposure = makeExposure(testSessionId);
    appendSkillExposure(exposure);

    const seededExposures = loadSessionExposures(testSessionId);
    expect(seededExposures).toHaveLength(1);
    expect(seededExposures[0].outcome).toBe("pending");
    expect(seededExposures[0].storyId).toBe("story-1");
    expect(seededExposures[0].route).toBe("/settings");
    expect(seededExposures[0].targetBoundary).toBe("clientRequest");

    // --- Checkpoint 2: Record a verification story so the observer has plan context ---
    // We deliberately do NOT create a matching story in the verification ledger.
    // Instead, we rely on directive env fallback for story/route resolution.

    // --- Checkpoint 3: Set directive env vars (simulating subagent bootstrap handoff) ---
    const savedEnv = {
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID,
      VERCEL_PLUGIN_VERIFICATION_ROUTE: process.env.VERCEL_PLUGIN_VERIFICATION_ROUTE,
      VERCEL_PLUGIN_VERIFICATION_BOUNDARY: process.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY,
      VERCEL_PLUGIN_VERIFICATION_ACTION: process.env.VERCEL_PLUGIN_VERIFICATION_ACTION,
      VERCEL_PLUGIN_LOG_LEVEL: process.env.VERCEL_PLUGIN_LOG_LEVEL,
    };

    process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID = "story-1";
    process.env.VERCEL_PLUGIN_VERIFICATION_ROUTE = "/settings";
    process.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY = "clientRequest";
    process.env.VERCEL_PLUGIN_VERIFICATION_ACTION = "curl http://localhost:3000/settings";
    process.env.VERCEL_PLUGIN_LOG_LEVEL = "off";

    try {
      // --- Checkpoint 4: Run the PostToolUse observer with a matching Bash payload ---
      const stdinPayload = makeStdinPayload(
        "curl http://localhost:3000/settings",
        testSessionId,
      );
      const output = run(stdinPayload);
      expect(output).toBe("{}");

      // --- Checkpoint 5: Assert the exposure resolved as directive-win ---
      const resolvedExposures = loadSessionExposures(testSessionId);
      const resolved = resolvedExposures.filter((e) => e.outcome !== "pending");
      expect(resolved).toHaveLength(1);
      expect(resolved[0].outcome).toBe("directive-win");
      expect(resolved[0].resolvedAt).not.toBeNull();
      expect(resolved[0].skill).toBe("verification");

      // --- Checkpoint 6: Assert project routing policy incremented wins and directiveWins ---
      const policy = loadProjectRoutingPolicy(projectRoot);
      const scenario = scenarioKey({
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
      });
      const stats = policy.scenarios[scenario]?.["verification"];
      expect(stats).toBeDefined();
      expect(stats!.wins).toBeGreaterThanOrEqual(1);
      expect(stats!.directiveWins).toBeGreaterThanOrEqual(1);
    } finally {
      // Restore env
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
  });

  test("exposure remains unresolved when directive env is absent and no story matches", () => {
    const exposure = makeExposure(testSessionId, {
      storyId: "story-orphan",
      route: "/orphan",
    });
    appendSkillExposure(exposure);

    const savedEnv = {
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID,
      VERCEL_PLUGIN_VERIFICATION_ROUTE: process.env.VERCEL_PLUGIN_VERIFICATION_ROUTE,
      VERCEL_PLUGIN_VERIFICATION_BOUNDARY: process.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY,
      VERCEL_PLUGIN_VERIFICATION_ACTION: process.env.VERCEL_PLUGIN_VERIFICATION_ACTION,
      VERCEL_PLUGIN_LOG_LEVEL: process.env.VERCEL_PLUGIN_LOG_LEVEL,
    };

    // Clear all directive env — the observer has no story context
    delete process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID;
    delete process.env.VERCEL_PLUGIN_VERIFICATION_ROUTE;
    delete process.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY;
    delete process.env.VERCEL_PLUGIN_VERIFICATION_ACTION;
    process.env.VERCEL_PLUGIN_LOG_LEVEL = "off";

    try {
      const stdinPayload = makeStdinPayload(
        "curl http://localhost:3000/settings",
        testSessionId,
      );
      run(stdinPayload);

      // The exposure has storyId="story-orphan" and route="/orphan",
      // but the observer inferred route="/settings" and storyId=null.
      // Strict null matching prevents resolution.
      const exposures = loadSessionExposures(testSessionId);
      expect(exposures).toHaveLength(1);
      expect(exposures[0].outcome).toBe("pending");
    } finally {
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Story-scoped observation isolation (E2E)
// ---------------------------------------------------------------------------

describe("story-scoped observation isolation", () => {
  test("observation for /settings under story-settings does not redirect /dashboard active story", async () => {
    const { storyId } = await import("../hooks/src/verification-ledger.mts");

    // Create /settings story, record an observation under it
    recordStory(testSessionId, "flow-verification", "/settings", "settings broken", ["verification"]);
    recordObservation(testSessionId, makeObs("iso-settings-1", "clientRequest", {
      route: "/settings",
      storyId: storyId("flow-verification", "/settings"),
      timestamp: "2026-03-27T22:00:00.000Z",
      summary: "curl http://localhost:3000/settings",
    }));

    // Create newer /dashboard story (should become active)
    recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard broken", ["verification"]);

    // Load the plan state and verify isolation
    const state = loadPlanState(testSessionId);
    expect(state).not.toBeNull();
    expect(state!.activeStoryId).toBe(storyId("flow-verification", "/dashboard"));

    // Top-level projection is the active story (/dashboard) which has no observations
    expect(state!.satisfiedBoundaries).toHaveLength(0);
    expect(state!.missingBoundaries).toHaveLength(4);

    // The /settings story state should contain the observation
    const settingsState = state!.storyStates.find((s) => s.route === "/settings");
    expect(settingsState).toBeDefined();
    expect(settingsState!.satisfiedBoundaries).toContain("clientRequest");

    // The /dashboard story state should be clean
    const dashboardState = state!.storyStates.find((s) => s.route === "/dashboard");
    expect(dashboardState).toBeDefined();
    expect(dashboardState!.satisfiedBoundaries).toHaveLength(0);
  });

  test("run() with VERCEL_PLUGIN_VERIFICATION_STORY_ID persists storyId on observation", () => {
    const savedEnv = {
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID,
      VERCEL_PLUGIN_LOG_LEVEL: process.env.VERCEL_PLUGIN_LOG_LEVEL,
    };

    const storyIdValue = "explicit-story-123";
    process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID = storyIdValue;
    process.env.VERCEL_PLUGIN_LOG_LEVEL = "off";

    try {
      recordStory(testSessionId, "flow-verification", "/settings", "test story binding", []);

      const stdinPayload = makeStdinPayload(
        "curl http://localhost:3000/settings",
        testSessionId,
      );
      run(stdinPayload);

      const observations = loadObservations(testSessionId);
      const obs = observations.find((o) => o.route === "/settings");
      expect(obs).toBeDefined();
      expect(obs!.storyId).toBe(storyIdValue);
    } finally {
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
  });
});
