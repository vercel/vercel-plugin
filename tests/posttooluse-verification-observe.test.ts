import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, unlinkSync } from "node:fs";
import {
  buildBoundaryEvent,
  buildLedgerObservation,
  classifyToolSignal,
  isLocalVerificationUrl,
  parseInput,
  resolveObservedStoryId,
  shouldResolveRoutingOutcome,
  type VerificationBoundaryEvent,
} from "../hooks/src/posttooluse-verification-observe.mts";
import {
  recordObservation,
  recordStory,
  removeLedgerArtifacts,
} from "../hooks/src/verification-ledger.mts";
import { storyId as computeStoryId } from "../hooks/src/verification-ledger.mts";
import { verifyPlanSnapshot } from "../src/commands/verify-plan.ts";
import {
  readRoutingDecisionTrace,
  createDecisionId,
  traceDir,
} from "../hooks/src/routing-decision-trace.mts";
import {
  appendSkillExposure,
  sessionExposurePath,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import {
  inspectLocalVerificationUrl,
  evaluateResolutionGate,
  diagnosePendingExposureMatch,
} from "../hooks/src/verification-closure-diagnosis.mts";

describe("posttooluse verification closed loop", () => {
  const sessionId = `verification-loop-${Date.now()}`;

  afterEach(() => {
    removeLedgerArtifacts(sessionId);
  });

  test("buildLedgerObservation maps boundary event to observation shape", () => {
    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000/settings",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/settings",
      verificationId: "verif-shape-1",
      timestamp: "2026-03-27T03:17:44.104Z",
    });

    const obs = buildLedgerObservation(event);
    expect(obs.id).toBe("verif-shape-1");
    expect(obs.source).toBe("bash");
    expect(obs.boundary).toBe("clientRequest");
    expect(obs.route).toBe("/settings");
    expect(obs.meta?.matchedPattern).toBe("http-client");
    expect(obs.meta?.matchedSuggestedAction).toBe(false);
  });

  test("buildLedgerObservation nullifies unknown boundary", () => {
    const event = buildBoundaryEvent({
      command: "ls",
      boundary: "unknown",
      matchedPattern: "none",
      inferredRoute: null,
      verificationId: "verif-unknown-1",
    });

    const obs = buildLedgerObservation(event);
    expect(obs.boundary).toBeNull();
  });

  test("records directive adherence and advances the plan", () => {
    recordStory(sessionId, "flow-verification", "/settings", "save fails", []);

    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000/settings",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/settings",
      verificationId: "verif-1",
      timestamp: "2026-03-27T03:17:44.104Z",
      env: {
        ...process.env,
        VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "clientRequest",
        VERCEL_PLUGIN_VERIFICATION_ACTION:
          "curl http://localhost:3000/settings",
      },
    });

    expect(event.matchedSuggestedAction).toBe(true);

    const plan = recordObservation(
      sessionId,
      buildLedgerObservation(event),
      {
        lastAttemptedAction: "curl http://localhost:3000/settings",
      },
    );

    expect(Array.from(plan.satisfiedBoundaries)).toContain("clientRequest");

    const snapshot = verifyPlanSnapshot({ sessionId });
    expect(snapshot.observationCount).toBe(1);
    expect(snapshot.lastObservation?.matchedSuggestedAction).toBe(true);
    expect(snapshot.lastObservation?.route).toBe("/settings");
    expect(snapshot.primaryNextAction?.targetBoundary).toBe("serverHandler");
  });

  test("records divergence when the observed action does not match the suggestion", () => {
    recordStory(sessionId, "flow-verification", "/settings", "save fails", []);

    const event = buildBoundaryEvent({
      command: "printenv",
      boundary: "environment",
      matchedPattern: "env-read",
      inferredRoute: "/settings",
      verificationId: "verif-2",
      timestamp: "2026-03-27T03:17:45.104Z",
      env: {
        ...process.env,
        VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "clientRequest",
        VERCEL_PLUGIN_VERIFICATION_ACTION:
          "curl http://localhost:3000/settings",
      },
    });

    expect(event.matchedSuggestedAction).toBe(false);

    recordObservation(
      sessionId,
      buildLedgerObservation(event),
      {
        lastAttemptedAction: "curl http://localhost:3000/settings",
      },
    );

    const snapshot = verifyPlanSnapshot({ sessionId });
    expect(snapshot.lastObservation?.matchedSuggestedAction).toBe(false);
    expect(snapshot.lastObservation?.boundary).toBe("environment");
  });

  test("snapshot with no session returns empty with null lastObservation", () => {
    const snapshot = verifyPlanSnapshot({
      sessionId: "nonexistent-session-" + Date.now(),
    });
    expect(snapshot.hasStories).toBe(false);
    expect(snapshot.lastObservation).toBeNull();
    expect(snapshot.observationCount).toBe(0);
  });

  describe("PostToolUse trace emission via run()", () => {
    const traceSessionId = `trace-observe-${Date.now()}`;

    afterEach(() => {
      removeLedgerArtifacts(traceSessionId);
      try { rmSync(traceDir(traceSessionId), { recursive: true, force: true }); } catch {}
    });

    test("run() emits a PostToolUse trace with verification correlation", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");

      recordStory(traceSessionId, "flow-verification", "/settings", "test trace emit", []);

      const input = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "curl http://localhost:3000/settings" },
        session_id: traceSessionId,
      });

      run(input);

      const traces = readRoutingDecisionTrace(traceSessionId);
      expect(traces.length).toBeGreaterThanOrEqual(1);

      const trace = traces.find((t) => t.hook === "PostToolUse");
      expect(trace).toBeDefined();
      expect(trace!.toolName).toBe("Bash");
      expect(trace!.verification).not.toBeNull();
      expect(trace!.verification!.verificationId).toBeTruthy();
      expect(trace!.verification!.observedBoundary).toBe("clientRequest");
    });

    test("createDecisionId is deterministic for same inputs", () => {
      const input = {
        hook: "PostToolUse" as const,
        sessionId: "sess-1",
        toolName: "Bash",
        toolTarget: "curl http://localhost:3000",
        timestamp: "2026-03-27T04:00:00.000Z",
      };
      const id1 = createDecisionId(input);
      const id2 = createDecisionId(input);
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(16);
    });
  });
});

// ---------------------------------------------------------------------------
// Multi-tool parseInput coverage
// ---------------------------------------------------------------------------

describe("parseInput multi-tool support", () => {
  test("parses Bash with command", () => {
    const result = parseInput(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "curl http://localhost:3000" },
      session_id: "s1",
    }));
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("Bash");
    expect(result!.toolInput.command).toBe("curl http://localhost:3000");
  });

  test("rejects Bash without command", () => {
    const result = parseInput(JSON.stringify({
      tool_name: "Bash",
      tool_input: {},
    }));
    expect(result).toBeNull();
  });

  test("parses Read tool", () => {
    const result = parseInput(JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/repo/.env.local" },
      session_id: "s2",
    }));
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("Read");
  });

  test("parses WebFetch tool", () => {
    const result = parseInput(JSON.stringify({
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/api/health" },
      session_id: "s3",
    }));
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("WebFetch");
  });

  test("parses Grep tool", () => {
    const result = parseInput(JSON.stringify({
      tool_name: "Grep",
      tool_input: { pattern: "ERROR", path: "/var/log/app.log" },
    }));
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("Grep");
  });

  test("parses Glob tool", () => {
    const result = parseInput(JSON.stringify({
      tool_name: "Glob",
      tool_input: { pattern: "**/*.log" },
    }));
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("Glob");
  });

  test("rejects unsupported tool names", () => {
    const result = parseInput(JSON.stringify({
      tool_name: "Agent",
      tool_input: {},
    }));
    expect(result).toBeNull();
  });

  test("rejects unknown tool names", () => {
    const result = parseInput(JSON.stringify({
      tool_name: "SomeFutureTool",
      tool_input: { data: "test" },
    }));
    expect(result).toBeNull();
  });

  test("returns {} without throwing for unsupported payloads via run()", async () => {
    const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");

    // Unknown tool
    expect(run(JSON.stringify({ tool_name: "UnknownTool", tool_input: {} }))).toBe("{}");

    // Empty input
    expect(run("")).toBe("{}");

    // Invalid JSON
    expect(run("not-json")).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// classifyToolSignal coverage
// ---------------------------------------------------------------------------

describe("classifyToolSignal", () => {
  test("Read .env.local → environment + soft + env-read", () => {
    const result = classifyToolSignal("Read", { file_path: "/repo/.env.local" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("environment");
    expect(result!.signalStrength).toBe("soft");
    expect(result!.evidenceSource).toBe("env-read");
    expect(result!.matchedPattern).toBe("env-file-read");
  });

  test("Read vercel.json → environment + soft", () => {
    const result = classifyToolSignal("Read", { file_path: "/repo/vercel.json" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("environment");
    expect(result!.matchedPattern).toBe("vercel-config-read");
  });

  test("Read .vercel/project.json → environment + soft", () => {
    const result = classifyToolSignal("Read", { file_path: "/repo/.vercel/project.json" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("environment");
  });

  test("Read server.log → serverHandler + soft + log-read", () => {
    const result = classifyToolSignal("Read", { file_path: "/repo/.next/server/app.log" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("serverHandler");
    expect(result!.signalStrength).toBe("soft");
    expect(result!.evidenceSource).toBe("log-read");
  });

  test("Read generic file → null (no verification evidence)", () => {
    const result = classifyToolSignal("Read", { file_path: "/repo/src/index.ts" });
    expect(result).toBeNull();
  });

  test("WebFetch → clientRequest + strong + http", () => {
    const result = classifyToolSignal("WebFetch", { url: "https://example.com/api/data" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("clientRequest");
    expect(result!.signalStrength).toBe("strong");
    expect(result!.evidenceSource).toBe("http");
    expect(result!.matchedPattern).toBe("web-fetch");
  });

  test("WebFetch without url → null", () => {
    const result = classifyToolSignal("WebFetch", {});
    expect(result).toBeNull();
  });

  test("Grep in log file → serverHandler + soft", () => {
    const result = classifyToolSignal("Grep", { pattern: "ERROR", path: "/var/log/app.log" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("serverHandler");
    expect(result!.signalStrength).toBe("soft");
    expect(result!.evidenceSource).toBe("log-read");
  });

  test("Grep in .env → environment + soft", () => {
    const result = classifyToolSignal("Grep", { pattern: "API_KEY", path: ".env" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("environment");
    expect(result!.evidenceSource).toBe("env-read");
  });

  test("Grep in generic path → null", () => {
    const result = classifyToolSignal("Grep", { pattern: "foo", path: "/repo/src" });
    expect(result).toBeNull();
  });

  test("Glob for *.log → serverHandler + soft", () => {
    const result = classifyToolSignal("Glob", { pattern: "**/*.log" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("serverHandler");
    expect(result!.signalStrength).toBe("soft");
  });

  test("Glob for .env* → environment + soft", () => {
    const result = classifyToolSignal("Glob", { pattern: ".env*" });
    expect(result).not.toBeNull();
    expect(result!.boundary).toBe("environment");
  });

  test("Glob for generic pattern → null", () => {
    const result = classifyToolSignal("Glob", { pattern: "**/*.ts" });
    expect(result).toBeNull();
  });

  test("Edit → null (not verification evidence)", () => {
    const result = classifyToolSignal("Edit", { file_path: "/repo/src/page.tsx" });
    expect(result).toBeNull();
  });

  test("Write → null (not verification evidence)", () => {
    const result = classifyToolSignal("Write", { file_path: "/repo/src/page.tsx" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shouldResolveRoutingOutcome gating
// ---------------------------------------------------------------------------

describe("shouldResolveRoutingOutcome", () => {
  test("strong + known boundary + Bash → true", () => {
    expect(shouldResolveRoutingOutcome({ boundary: "clientRequest", signalStrength: "strong", toolName: "Bash", command: "curl http://localhost:3000" })).toBe(true);
    expect(shouldResolveRoutingOutcome({ boundary: "uiRender", signalStrength: "strong", toolName: "Bash", command: "open http://localhost:3000" })).toBe(true);
    expect(shouldResolveRoutingOutcome({ boundary: "serverHandler", signalStrength: "strong", toolName: "Bash", command: "tail -f server.log" })).toBe(true);
    expect(shouldResolveRoutingOutcome({ boundary: "environment", signalStrength: "strong", toolName: "Bash", command: "printenv" })).toBe(true);
  });

  test("soft + known boundary → false", () => {
    expect(shouldResolveRoutingOutcome({ boundary: "environment", signalStrength: "soft", toolName: "Read", command: ".env" })).toBe(false);
    expect(shouldResolveRoutingOutcome({ boundary: "serverHandler", signalStrength: "soft", toolName: "Grep", command: "grep ERROR app.log" })).toBe(false);
  });

  test("strong + unknown boundary → false", () => {
    expect(shouldResolveRoutingOutcome({ boundary: "unknown", signalStrength: "strong", toolName: "Bash", command: "ls" })).toBe(false);
  });

  test("soft + unknown boundary → false", () => {
    expect(shouldResolveRoutingOutcome({ boundary: "unknown", signalStrength: "soft", toolName: "Bash", command: "ls" })).toBe(false);
  });

  test("WebFetch strong signal does not resolve policy for external origin", () => {
    expect(shouldResolveRoutingOutcome({
      boundary: "clientRequest",
      signalStrength: "strong",
      toolName: "WebFetch",
      command: "https://example.com/settings",
    })).toBe(false);
  });

  test("WebFetch strong signal resolves policy for localhost", () => {
    expect(shouldResolveRoutingOutcome({
      boundary: "clientRequest",
      signalStrength: "strong",
      toolName: "WebFetch",
      command: "http://localhost:3000/settings",
    })).toBe(true);
  });

  test("WebFetch resolves for configured VERCEL_PLUGIN_LOCAL_DEV_ORIGIN", () => {
    const env = { VERCEL_PLUGIN_LOCAL_DEV_ORIGIN: "http://myapp.test:4000" };
    expect(shouldResolveRoutingOutcome({
      boundary: "clientRequest",
      signalStrength: "strong",
      toolName: "WebFetch",
      command: "http://myapp.test:4000/dashboard",
    }, env)).toBe(true);
  });

  test("Bash curl strong signal still resolves policy regardless of URL", () => {
    expect(shouldResolveRoutingOutcome({
      boundary: "clientRequest",
      signalStrength: "strong",
      toolName: "Bash",
      command: "curl https://example.com/settings",
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isLocalVerificationUrl
// ---------------------------------------------------------------------------

describe("isLocalVerificationUrl", () => {
  test("localhost is local", () => {
    expect(isLocalVerificationUrl("http://localhost:3000/settings")).toBe(true);
  });

  test("127.0.0.1 is local", () => {
    expect(isLocalVerificationUrl("http://127.0.0.1:3000/api")).toBe(true);
  });

  test("::1 is local", () => {
    expect(isLocalVerificationUrl("http://[::1]:3000/")).toBe(true);
  });

  test("0.0.0.0 is local", () => {
    expect(isLocalVerificationUrl("http://0.0.0.0:5173/dashboard")).toBe(true);
  });

  test("external host is not local", () => {
    expect(isLocalVerificationUrl("https://example.com/settings")).toBe(false);
  });

  test("configured origin matches", () => {
    const env = { VERCEL_PLUGIN_LOCAL_DEV_ORIGIN: "http://myapp.local:4000" };
    expect(isLocalVerificationUrl("http://myapp.local:4000/settings", env)).toBe(true);
  });

  test("configured origin mismatch", () => {
    const env = { VERCEL_PLUGIN_LOCAL_DEV_ORIGIN: "http://myapp.local:4000" };
    expect(isLocalVerificationUrl("http://other.local:4000/settings", env)).toBe(false);
  });

  test("non-http protocol returns false", () => {
    expect(isLocalVerificationUrl("ftp://localhost:3000/")).toBe(false);
  });

  test("invalid URL returns false", () => {
    expect(isLocalVerificationUrl("not-a-url")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveObservedStoryId
// ---------------------------------------------------------------------------

describe("resolveObservedStoryId", () => {
  const plan = {
    activeStoryId: "story-settings",
    stories: [
      { id: "story-settings", route: "/settings" },
      { id: "story-dashboard", route: "/dashboard" },
    ],
  };

  test("observed route selects matching story instead of active story", () => {
    expect(resolveObservedStoryId(plan, "/dashboard")).toBe("story-dashboard");
  });

  test("observed route matching active story returns that story", () => {
    expect(resolveObservedStoryId(plan, "/settings")).toBe("story-settings");
  });

  test("null observed route falls back to activeStoryId", () => {
    expect(resolveObservedStoryId(plan, null)).toBe("story-settings");
  });

  test("unmatched observed route falls back to activeStoryId", () => {
    expect(resolveObservedStoryId(plan, "/unknown")).toBe("story-settings");
  });

  test("explicit env override takes precedence", () => {
    const env = { VERCEL_PLUGIN_VERIFICATION_STORY_ID: "story-override" };
    expect(resolveObservedStoryId(plan, "/dashboard", env)).toBe("story-override");
  });

  test("ambiguous route (multiple matches) falls back to activeStoryId", () => {
    const ambiguousPlan = {
      activeStoryId: "story-a",
      stories: [
        { id: "story-a", route: "/shared" },
        { id: "story-b", route: "/shared" },
      ],
    };
    expect(resolveObservedStoryId(ambiguousPlan, "/shared")).toBe("story-a");
  });

  test("no stories and no active story returns null", () => {
    expect(resolveObservedStoryId({ stories: [], activeStoryId: null }, "/dashboard")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBoundaryEvent and buildLedgerObservation with new fields
// ---------------------------------------------------------------------------

describe("buildBoundaryEvent with signalStrength and evidenceSource", () => {
  test("defaults to strong/bash/Bash when not specified", () => {
    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/",
      verificationId: "v-1",
    });
    expect(event.signalStrength).toBe("strong");
    expect(event.evidenceSource).toBe("bash");
    expect(event.toolName).toBe("Bash");
  });

  test("propagates explicit soft/env-read/Read", () => {
    const event = buildBoundaryEvent({
      command: "/repo/.env.local",
      boundary: "environment",
      matchedPattern: "env-file-read",
      inferredRoute: null,
      verificationId: "v-2",
      signalStrength: "soft",
      evidenceSource: "env-read",
      toolName: "Read",
    });
    expect(event.signalStrength).toBe("soft");
    expect(event.evidenceSource).toBe("env-read");
    expect(event.toolName).toBe("Read");
  });

  test("ledger observation includes toolName and signalStrength in meta", () => {
    const event = buildBoundaryEvent({
      command: "https://example.com/api",
      boundary: "clientRequest",
      matchedPattern: "web-fetch",
      inferredRoute: null,
      verificationId: "v-3",
      signalStrength: "strong",
      evidenceSource: "http",
      toolName: "WebFetch",
    });
    const obs = buildLedgerObservation(event);
    expect(obs.meta?.toolName).toBe("WebFetch");
    expect(obs.meta?.signalStrength).toBe("strong");
    expect(obs.meta?.evidenceSource).toBe("http");
  });
});

// ---------------------------------------------------------------------------
// Fixture matrix: tool_name -> observer_reached
// ---------------------------------------------------------------------------

describe("fixture matrix: tool_name -> observer_reached", () => {
  const toolPayloads: Record<string, Record<string, unknown>> = {
    Bash: { command: "curl http://localhost:3000/dashboard" },
    Read: { file_path: "/repo/.env.local" },
    WebFetch: { url: "https://example.com/api" },
    Grep: { pattern: "ERROR", path: "/var/log/app.log" },
    Glob: { pattern: "**/*.log" },
    // These tools produce null from classifyToolSignal but parseInput accepts them
    Edit: { file_path: "/repo/src/page.tsx" },
    Write: { file_path: "/repo/src/page.tsx" },
  };

  for (const [toolName, toolInput] of Object.entries(toolPayloads)) {
    test(`parseInput accepts ${toolName}`, () => {
      const result = parseInput(JSON.stringify({
        tool_name: toolName,
        tool_input: toolInput,
        session_id: "test-session",
      }));
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe(toolName);
    });
  }

  test("run() returns {} for each tool without throwing", async () => {
    const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
    for (const [toolName, toolInput] of Object.entries(toolPayloads)) {
      const output = run(JSON.stringify({
        tool_name: toolName,
        tool_input: toolInput,
      }));
      expect(output).toBe("{}");
    }
  });
});

// ---------------------------------------------------------------------------
// Verification Closure Diagnosis — inspectLocalVerificationUrl
// ---------------------------------------------------------------------------

describe("inspectLocalVerificationUrl", () => {
  test("localhost returns loopback match", () => {
    const result = inspectLocalVerificationUrl("http://localhost:3000/settings", {});
    expect(result.applicable).toBe(true);
    expect(result.parseable).toBe(true);
    expect(result.isLocal).toBe(true);
    expect(result.matchSource).toBe("loopback");
    expect(result.observedHost).toBe("localhost:3000");
  });

  test("127.0.0.1 returns loopback match", () => {
    const result = inspectLocalVerificationUrl("http://127.0.0.1:4000/api", {});
    expect(result.isLocal).toBe(true);
    expect(result.matchSource).toBe("loopback");
  });

  test("[::1] returns loopback match", () => {
    const result = inspectLocalVerificationUrl("http://[::1]:3000/", {});
    expect(result.isLocal).toBe(true);
    expect(result.matchSource).toBe("loopback");
  });

  test("external host returns non-local", () => {
    const result = inspectLocalVerificationUrl("https://example.com/dashboard", {});
    expect(result.isLocal).toBe(false);
    expect(result.matchSource).toBeNull();
    expect(result.observedHost).toBe("example.com");
  });

  test("configured origin matches", () => {
    const env = { VERCEL_PLUGIN_LOCAL_DEV_ORIGIN: "http://myapp.local:4000" };
    const result = inspectLocalVerificationUrl("http://myapp.local:4000/settings", env);
    expect(result.isLocal).toBe(true);
    expect(result.matchSource).toBe("configured-origin");
    expect(result.configuredOrigin).toBe("http://myapp.local:4000");
  });

  test("non-http protocol returns non-local", () => {
    const result = inspectLocalVerificationUrl("ftp://localhost:21/data", {});
    expect(result.parseable).toBe(true);
    expect(result.isLocal).toBe(false);
  });

  test("invalid URL returns unparseable", () => {
    const result = inspectLocalVerificationUrl("not-a-url", {});
    expect(result.parseable).toBe(false);
    expect(result.isLocal).toBeNull();
    expect(result.observedHost).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Verification Closure Diagnosis — evaluateResolutionGate
// ---------------------------------------------------------------------------

describe("evaluateResolutionGate", () => {
  test("strong signal + known boundary + Bash → eligible", () => {
    const gate = evaluateResolutionGate({
      boundary: "clientRequest",
      signalStrength: "strong",
      toolName: "Bash",
      command: "curl http://localhost:3000/settings",
    }, {});
    expect(gate.eligible).toBe(true);
    expect(gate.passedChecks).toContain("known_boundary");
    expect(gate.passedChecks).toContain("strong_signal");
    expect(gate.blockingReasonCodes).toHaveLength(0);
    expect(gate.locality.applicable).toBe(false);
  });

  test("soft signal blocks with soft_signal code", () => {
    const gate = evaluateResolutionGate({
      boundary: "environment",
      signalStrength: "soft",
      toolName: "Read",
      command: ".env",
    }, {});
    expect(gate.eligible).toBe(false);
    expect(gate.blockingReasonCodes).toContain("soft_signal");
    expect(gate.passedChecks).toContain("known_boundary");
  });

  test("unknown boundary blocks with unknown_boundary code", () => {
    const gate = evaluateResolutionGate({
      boundary: "unknown",
      signalStrength: "strong",
      toolName: "Bash",
      command: "ls",
    }, {});
    expect(gate.eligible).toBe(false);
    expect(gate.blockingReasonCodes).toContain("unknown_boundary");
  });

  test("remote WebFetch blocks with remote_web_fetch code", () => {
    const gate = evaluateResolutionGate({
      boundary: "clientRequest",
      signalStrength: "strong",
      toolName: "WebFetch",
      command: "https://example.com/dashboard",
    }, {});
    expect(gate.eligible).toBe(false);
    expect(gate.passedChecks).toContain("known_boundary");
    expect(gate.passedChecks).toContain("strong_signal");
    expect(gate.blockingReasonCodes).toContain("remote_web_fetch");
    expect(gate.locality.applicable).toBe(true);
    expect(gate.locality.isLocal).toBe(false);
    expect(gate.locality.observedHost).toBe("example.com");
  });

  test("local WebFetch is eligible", () => {
    const gate = evaluateResolutionGate({
      boundary: "clientRequest",
      signalStrength: "strong",
      toolName: "WebFetch",
      command: "http://localhost:3000/api/health",
    }, {});
    expect(gate.eligible).toBe(true);
    expect(gate.passedChecks).toContain("local_verification_url");
    expect(gate.locality.isLocal).toBe(true);
    expect(gate.locality.matchSource).toBe("loopback");
  });

  test("WebFetch with configured origin is eligible", () => {
    const gate = evaluateResolutionGate({
      boundary: "clientRequest",
      signalStrength: "strong",
      toolName: "WebFetch",
      command: "http://myapp.test:4000/dashboard",
    }, { VERCEL_PLUGIN_LOCAL_DEV_ORIGIN: "http://myapp.test:4000" });
    expect(gate.eligible).toBe(true);
    expect(gate.locality.matchSource).toBe("configured-origin");
  });

  test("soft + unknown accumulates multiple blocking codes", () => {
    const gate = evaluateResolutionGate({
      boundary: "unknown",
      signalStrength: "soft",
      toolName: "Bash",
      command: "ls",
    }, {});
    expect(gate.eligible).toBe(false);
    expect(gate.blockingReasonCodes).toContain("unknown_boundary");
    expect(gate.blockingReasonCodes).toContain("soft_signal");
    expect(gate.blockingReasonCodes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Verification Closure Diagnosis — diagnosePendingExposureMatch
// ---------------------------------------------------------------------------

describe("diagnosePendingExposureMatch", () => {
  const SESSION = "diagnosis-test-" + Date.now();

  function makeExposure(id: string, overrides: Partial<SkillExposure> = {}): SkillExposure {
    return {
      id,
      sessionId: SESSION,
      projectRoot: "/tmp/project",
      storyId: null,
      storyKind: "flow-verification",
      route: null,
      hook: "PreToolUse",
      toolName: "Bash",
      skill: "agent-browser-verify",
      targetBoundary: "clientRequest",
      exposureGroupId: "group-1",
      attributionRole: "candidate",
      candidateSkill: "agent-browser-verify",
      createdAt: "2026-03-28T11:00:00.000Z",
      resolvedAt: null,
      outcome: "pending",
      ...overrides,
    };
  }

  test("exact match returns matched exposure IDs with no unresolved codes", () => {
    const exposures = [
      makeExposure("exp-1", { storyId: "story-1", route: "/settings" }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-1",
      route: "/settings",
      exposures,
    });
    expect(result.exactMatchCount).toBe(1);
    expect(result.exactMatchExposureIds).toEqual(["exp-1"]);
    expect(result.unresolvedReasonCodes).toHaveLength(0);
  });

  test("route mismatch diagnosed when same story different route", () => {
    const exposures = [
      makeExposure("exp-2", { storyId: "story-1", route: "/settings" }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-1",
      route: "/dashboard",
      exposures,
    });
    expect(result.exactMatchCount).toBe(0);
    expect(result.unresolvedReasonCodes).toContain("route_mismatch");
    expect(result.sameStoryDifferentRouteExposureIds).toEqual(["exp-2"]);
  });

  test("story mismatch diagnosed when same route different story", () => {
    const exposures = [
      makeExposure("exp-3", { storyId: "story-other", route: "/settings" }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-1",
      route: "/settings",
      exposures,
    });
    expect(result.exactMatchCount).toBe(0);
    expect(result.unresolvedReasonCodes).toContain("story_mismatch");
    expect(result.sameRouteDifferentStoryExposureIds).toEqual(["exp-3"]);
  });

  test("missing story scope diagnosed when storyId is null", () => {
    const exposures = [
      makeExposure("exp-4", { storyId: "story-1", route: "/settings" }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: null,
      route: "/settings",
      exposures,
    });
    expect(result.unresolvedReasonCodes).toContain("missing_story_scope");
    expect(result.unresolvedReasonCodes).toContain("story_mismatch");
  });

  test("missing route scope diagnosed when route is null", () => {
    const exposures = [
      makeExposure("exp-5", { storyId: "story-1", route: "/settings" }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-1",
      route: null,
      exposures,
    });
    expect(result.unresolvedReasonCodes).toContain("missing_route_scope");
    expect(result.unresolvedReasonCodes).toContain("route_mismatch");
  });

  test("no pending for boundary diagnosed when boundary doesn't match", () => {
    const exposures = [
      makeExposure("exp-6", {
        storyId: "story-1",
        route: "/settings",
        targetBoundary: "serverHandler",
      }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-1",
      route: "/settings",
      exposures,
    });
    expect(result.pendingBoundaryCount).toBe(0);
    expect(result.unresolvedReasonCodes).toContain("no_pending_for_boundary");
  });

  test("already-resolved exposures are excluded from pending", () => {
    const exposures = [
      makeExposure("exp-7", {
        storyId: "story-1",
        route: "/settings",
        outcome: "win",
        resolvedAt: "2026-03-28T12:00:00.000Z",
      }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-1",
      route: "/settings",
      exposures,
    });
    expect(result.pendingTotal).toBe(0);
    expect(result.pendingBoundaryCount).toBe(0);
    expect(result.unresolvedReasonCodes).toContain("no_pending_for_boundary");
  });

  test("no exact pending match as fallback when no specific reason applies", () => {
    const exposures = [
      makeExposure("exp-8", {
        storyId: "story-x",
        route: "/other",
      }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-1",
      route: "/settings",
      exposures,
    });
    expect(result.exactMatchCount).toBe(0);
    expect(result.unresolvedReasonCodes).toContain("no_exact_pending_match");
  });

  test("active-story fallback: pending on same boundary with null storyId matches null", () => {
    const exposures = [
      makeExposure("exp-9", { storyId: null, route: "/settings" }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: null,
      route: "/settings",
      exposures,
    });
    expect(result.exactMatchCount).toBe(1);
    expect(result.exactMatchExposureIds).toEqual(["exp-9"]);
    expect(result.unresolvedReasonCodes).toHaveLength(0);
  });

  test("ambiguous route: multiple stories on same route", () => {
    const exposures = [
      makeExposure("exp-10a", { storyId: "story-a", route: "/shared" }),
      makeExposure("exp-10b", { storyId: "story-b", route: "/shared" }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-a",
      route: "/shared",
      exposures,
    });
    expect(result.exactMatchCount).toBe(1);
    expect(result.exactMatchExposureIds).toEqual(["exp-10a"]);
    expect(result.sameRouteDifferentStoryExposureIds).toEqual(["exp-10b"]);
  });

  test("pendingTotal counts across all boundaries", () => {
    const exposures = [
      makeExposure("exp-11a", {
        storyId: "story-1",
        route: "/settings",
        targetBoundary: "clientRequest",
      }),
      makeExposure("exp-11b", {
        storyId: "story-1",
        route: "/settings",
        targetBoundary: "serverHandler",
      }),
    ];
    const result = diagnosePendingExposureMatch({
      sessionId: SESSION,
      boundary: "clientRequest",
      storyId: "story-1",
      route: "/settings",
      exposures,
    });
    expect(result.pendingTotal).toBe(2);
    expect(result.pendingBoundaryCount).toBe(1);
    expect(result.exactMatchCount).toBe(1);
  });
});
