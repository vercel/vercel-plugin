import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, unlinkSync } from "node:fs";
import { run } from "../hooks/src/posttooluse-verification-observe.mts";
import {
  recordStory,
  removeLedgerArtifacts,
  storyId as computeStoryId,
} from "../hooks/src/verification-ledger.mts";
import {
  appendSkillExposure,
  sessionExposurePath,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import {
  readLatestVerificationClosureCapsule,
  readVerificationClosureCapsules,
} from "../hooks/src/verification-closure-capsule.mts";
import { traceDir } from "../hooks/src/routing-decision-trace.mts";
import { readRoutingDecisionTrace } from "../hooks/src/routing-decision-trace.mts";

const SESSION = "verification-closure-capsule-" + Date.now();
const CREATED_AT = "2026-03-28T11:00:00.000Z";

function exposure(
  id: string,
  overrides: Partial<SkillExposure> = {},
): SkillExposure {
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
    createdAt: CREATED_AT,
    resolvedAt: null,
    outcome: "pending",
    ...overrides,
  };
}

afterEach(() => {
  try {
    removeLedgerArtifacts(SESSION);
  } catch {}
  try {
    unlinkSync(sessionExposurePath(SESSION));
  } catch {}
  try {
    rmSync(traceDir(SESSION), { recursive: true, force: true });
  } catch {}
  delete process.env.VERCEL_PLUGIN_LOCAL_DEV_ORIGIN;
  delete process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID;
  delete process.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY;
  delete process.env.VERCEL_PLUGIN_VERIFICATION_ACTION;
  delete process.env.VERCEL_PLUGIN_VERIFICATION_ROUTE;
});

describe("verification closure capsule", () => {
  test("records explicit gate failure for remote WebFetch", () => {
    recordStory(
      SESSION,
      "flow-verification",
      "/dashboard",
      "remote fetch check",
      [],
    );

    run(
      JSON.stringify({
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com/dashboard" },
        session_id: SESSION,
      }),
    );

    const capsule = readLatestVerificationClosureCapsule(SESSION);
    expect(capsule).not.toBeNull();
    expect(capsule!.observation.boundary).toBe("clientRequest");
    expect(capsule!.gate.eligible).toBe(false);
    expect(capsule!.gate.blockingReasonCodes).toContain("remote_web_fetch");
    expect(capsule!.resolution.attempted).toBe(false);
    expect(capsule!.resolution.resolvedCount).toBe(0);
  });

  test("records route mismatch when local strong verification resolves nothing", () => {
    recordStory(
      SESSION,
      "flow-verification",
      "/settings",
      "route mismatch check",
      [],
    );

    const sid = computeStoryId("flow-verification", "/settings");
    appendSkillExposure(
      exposure("exp-route-mismatch", {
        storyId: sid,
        route: "/settings",
      }),
    );

    run(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "curl http://localhost:3000/dashboard" },
        session_id: SESSION,
      }),
    );

    const capsule = readLatestVerificationClosureCapsule(SESSION);
    expect(capsule).not.toBeNull();
    expect(capsule!.gate.eligible).toBe(true);
    expect(capsule!.exposureDiagnosis).not.toBeNull();
    expect(capsule!.exposureDiagnosis!.unresolvedReasonCodes).toContain(
      "route_mismatch",
    );
    expect(capsule!.resolution.resolvedCount).toBe(0);
  });

  test("capsule includes story resolution method", () => {
    recordStory(
      SESSION,
      "flow-verification",
      "/dashboard",
      "method tracking",
      [],
    );

    run(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "curl http://localhost:3000/dashboard" },
        session_id: SESSION,
      }),
    );

    const capsule = readLatestVerificationClosureCapsule(SESSION);
    expect(capsule).not.toBeNull();
    expect(capsule!.storyResolution.method).toBe("exact-route");
    expect(capsule!.storyResolution.resolvedStoryId).toBe(
      computeStoryId("flow-verification", "/dashboard"),
    );
  });

  test("capsule plan fields reflect active-story projection", () => {
    recordStory(
      SESSION,
      "flow-verification",
      "/dashboard",
      "plan projection",
      [],
    );

    run(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "curl http://localhost:3000/dashboard" },
        session_id: SESSION,
      }),
    );

    const capsule = readLatestVerificationClosureCapsule(SESSION);
    expect(capsule).not.toBeNull();
    expect(capsule!.plan.activeStoryId).not.toBeNull();
    // After a clientRequest observation, that boundary should be satisfied
    expect(capsule!.plan.satisfiedBoundaries).toContain("clientRequest");
    expect(capsule!.plan.missingBoundaries.length).toBeGreaterThan(0);
  });

  test("routing decision trace uses namespaced skip reasons", () => {
    recordStory(
      SESSION,
      "flow-verification",
      "/dashboard",
      "trace reasons",
      [],
    );

    run(
      JSON.stringify({
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com/dashboard" },
        session_id: SESSION,
      }),
    );

    const traces = readRoutingDecisionTrace(SESSION);
    const trace = traces.find((t) => t.hook === "PostToolUse");
    expect(trace).toBeDefined();
    expect(trace!.skippedReasons).toContain("gate:remote_web_fetch");
  });

  test("multiple observations produce multiple capsules in JSONL", () => {
    recordStory(
      SESSION,
      "flow-verification",
      "/dashboard",
      "multi capsule",
      [],
    );

    run(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "curl http://localhost:3000/dashboard" },
        session_id: SESSION,
      }),
    );

    run(
      JSON.stringify({
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com/dashboard" },
        session_id: SESSION,
      }),
    );

    const capsules = readVerificationClosureCapsules(SESSION);
    expect(capsules.length).toBe(2);
    expect(capsules[0]!.toolName).toBe("Bash");
    expect(capsules[1]!.toolName).toBe("WebFetch");
  });

  test("successful resolution records win in capsule", () => {
    recordStory(
      SESSION,
      "flow-verification",
      "/dashboard",
      "win test",
      [],
    );

    const sid = computeStoryId("flow-verification", "/dashboard");
    appendSkillExposure(
      exposure("exp-win", {
        storyId: sid,
        route: "/dashboard",
      }),
    );

    run(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "curl http://localhost:3000/dashboard" },
        session_id: SESSION,
      }),
    );

    const capsule = readLatestVerificationClosureCapsule(SESSION);
    expect(capsule).not.toBeNull();
    expect(capsule!.gate.eligible).toBe(true);
    expect(capsule!.resolution.attempted).toBe(true);
    expect(capsule!.resolution.resolvedCount).toBe(1);
    expect(capsule!.resolution.outcomeKind).toBe("win");
    expect(capsule!.resolution.resolvedExposureIds).toContain("exp-win");
  });
});
