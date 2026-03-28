import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  buildBoundaryEvent,
  buildLedgerObservation,
  classifyToolSignal,
  parseInput,
  shouldResolveRoutingOutcome,
  type VerificationBoundaryEvent,
} from "../hooks/src/posttooluse-verification-observe.mts";
import {
  recordObservation,
  recordStory,
  removeLedgerArtifacts,
} from "../hooks/src/verification-ledger.mts";
import { verifyPlanSnapshot } from "../src/commands/verify-plan.ts";
import {
  readRoutingDecisionTrace,
  createDecisionId,
  traceDir,
} from "../hooks/src/routing-decision-trace.mts";

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
  test("strong + known boundary → true", () => {
    expect(shouldResolveRoutingOutcome({ boundary: "clientRequest", signalStrength: "strong" })).toBe(true);
    expect(shouldResolveRoutingOutcome({ boundary: "uiRender", signalStrength: "strong" })).toBe(true);
    expect(shouldResolveRoutingOutcome({ boundary: "serverHandler", signalStrength: "strong" })).toBe(true);
    expect(shouldResolveRoutingOutcome({ boundary: "environment", signalStrength: "strong" })).toBe(true);
  });

  test("soft + known boundary → false", () => {
    expect(shouldResolveRoutingOutcome({ boundary: "environment", signalStrength: "soft" })).toBe(false);
    expect(shouldResolveRoutingOutcome({ boundary: "serverHandler", signalStrength: "soft" })).toBe(false);
  });

  test("strong + unknown boundary → false", () => {
    expect(shouldResolveRoutingOutcome({ boundary: "unknown", signalStrength: "strong" })).toBe(false);
  });

  test("soft + unknown boundary → false", () => {
    expect(shouldResolveRoutingOutcome({ boundary: "unknown", signalStrength: "soft" })).toBe(false);
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
