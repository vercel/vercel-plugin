import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildBoundaryEvent,
  classifyBoundary,
  inferRoute,
  parseInput,
  redactCommand,
} from "../hooks/src/posttooluse-verification-observe.mts";
import {
  loadObservations,
  loadStories,
  loadPlanState,
  recordObservation,
  recordStory,
} from "../hooks/src/verification-ledger.mts";
import type { VerificationObservation } from "../hooks/src/verification-ledger.mts";

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
