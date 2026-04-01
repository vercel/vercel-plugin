import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SkillInstallPlan } from "../hooks/src/orchestrator-install-plan.mts";
import {
  buildOrchestratorActionError,
  type OrchestratorActionRunError,
  type OrchestratorActionRunErrorCode,
} from "../hooks/src/orchestrator-action-runner.mts";
import {
  getOrchestratorActionSpec,
} from "../hooks/src/orchestrator-action-spec.mts";
import {
  ORCHESTRATOR_ACTION_IDS,
  type OrchestratorRunnerActionId,
} from "../hooks/src/orchestrator-action-command.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<SkillInstallPlan> = {}): SkillInstallPlan {
  return {
    schemaVersion: 1,
    createdAt: "2026-04-01T12:00:00.000Z",
    projectRoot: "/repo",
    likelySkills: [],
    installedSkills: [],
    missingSkills: [],
    bundledFallbackEnabled: true,
    zeroBundleReady: false,
    projectSkillManifestPath: null,
    vercelLinked: false,
    hasEnvLocal: false,
    detections: [],
    actions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ACTION_BLOCKED — spec-level preflight
// ---------------------------------------------------------------------------

describe("ACTION_BLOCKED preflight via spec", () => {
  test("vercel-env-pull on unlinked repo is not runnable", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: false }),
      "vercel-env-pull",
    );
    expect(spec.runnable).toBe(false);
    expect(spec.blockedReason).toContain("Link the project first");
    expect(spec.blockedReason).toContain("vercel env pull");
  });

  test("vercel-deploy on unlinked repo is not runnable", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: false }),
      "vercel-deploy",
    );
    expect(spec.runnable).toBe(false);
    expect(spec.blockedReason).toContain("Link the project first");
    expect(spec.blockedReason).toContain("vercel deploy");
  });

  test("bootstrap-project is always runnable even when unlinked", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: false }),
      "bootstrap-project",
    );
    expect(spec.runnable).toBe(true);
    expect(spec.blockedReason).toBeNull();
  });

  test("install-missing is always runnable", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "install-missing");
    expect(spec.runnable).toBe(true);
    expect(spec.blockedReason).toBeNull();
  });

  test("vercel-link is always runnable", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "vercel-link");
    expect(spec.runnable).toBe(true);
    expect(spec.blockedReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildOrchestratorActionError — structured error envelopes
// ---------------------------------------------------------------------------

describe("buildOrchestratorActionError", () => {
  test("classifies ACTION_BLOCKED errors correctly", () => {
    const err = buildOrchestratorActionError({
      error: new Error(
        "Blocked action vercel-env-pull: Link the project first; `vercel env pull` requires a linked Vercel project.",
      ),
      actionId: "vercel-env-pull",
      projectRoot: "/repo",
    });

    expect(err.schemaVersion).toBe(1);
    expect(err.type).toBe("vercel-plugin-orchestrator-action-error");
    expect(err.ok).toBe(false);
    expect(err.code).toBe("ACTION_BLOCKED");
    expect(err.message).toContain("Blocked action vercel-env-pull");
    expect(err.hint).toContain("bootstrap-project");
    expect(err.hint).toContain("vercel-link");
    expect(err.actionId).toBe("vercel-env-pull");
    expect(err.projectRoot).toBe("/repo");
  });

  test("vercel-deploy blocked error has correct hint", () => {
    const err = buildOrchestratorActionError({
      error: new Error(
        "Blocked action vercel-deploy: Link the project first; `vercel deploy` is only runnable after the project is linked.",
      ),
      actionId: "vercel-deploy",
      projectRoot: "/repo",
    });

    expect(err.code).toBe("ACTION_BLOCKED");
    expect(err.hint).toContain("bootstrap-project");
    expect(err.hint).toContain("vercel-link");
    expect(err.hint).toContain("vercel-deploy");
  });

  test("classifies MISSING_INSTALL_PLAN errors correctly", () => {
    const err = buildOrchestratorActionError({
      error: new Error("Missing install plan at /repo/.skills/install-plan.json. Run SessionStart first."),
      actionId: "install-missing",
      projectRoot: "/repo",
    });

    expect(err.code).toBe("MISSING_INSTALL_PLAN");
    expect(err.hint).toContain("SessionStart");
  });

  test("classifies INVALID_ACTION errors correctly", () => {
    const err = buildOrchestratorActionError({
      error: new Error("Invalid --action: bogus"),
      actionId: null,
      projectRoot: "/repo",
    });

    expect(err.code).toBe("INVALID_ACTION");
    expect(err.hint).toContain(ORCHESTRATOR_ACTION_IDS[0]);
  });

  test("classifies unknown errors as RUNNER_ERROR", () => {
    const err = buildOrchestratorActionError({
      error: new Error("Something unexpected happened"),
      actionId: "install-missing",
      projectRoot: "/repo",
    });

    expect(err.code).toBe("RUNNER_ERROR");
    expect(err.hint).toContain("delegated CLI output");
  });

  test("handles non-Error values gracefully", () => {
    const err = buildOrchestratorActionError({
      error: "string error",
      actionId: null,
      projectRoot: null,
    });

    expect(err.code).toBe("RUNNER_ERROR");
    expect(err.message).toBe("string error");
    expect(err.actionId).toBeNull();
    expect(err.projectRoot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Runner blocked-action throw path (simulated via spec + error builder)
// ---------------------------------------------------------------------------

describe("runner blocked-action integration", () => {
  test("vercel-env-pull on unlinked repo produces ACTION_BLOCKED envelope", () => {
    const plan = makePlan({ vercelLinked: false });
    const spec = getOrchestratorActionSpec(plan, "vercel-env-pull");

    // Simulate what runOrchestratorAction does when spec.runnable is false
    expect(spec.runnable).toBe(false);
    const thrownMessage = `Blocked action vercel-env-pull: ${spec.blockedReason ?? "Action prerequisites are not met."}`;
    const envelope = buildOrchestratorActionError({
      error: new Error(thrownMessage),
      actionId: "vercel-env-pull",
      projectRoot: "/repo",
    });

    expect(envelope.code).toBe("ACTION_BLOCKED");
    expect(envelope.ok).toBe(false);
    expect(envelope.message).toContain("Link the project first");
    expect(envelope.hint).toContain("bootstrap-project");
  });

  test("vercel-deploy on unlinked repo produces ACTION_BLOCKED envelope", () => {
    const plan = makePlan({ vercelLinked: false });
    const spec = getOrchestratorActionSpec(plan, "vercel-deploy");

    expect(spec.runnable).toBe(false);
    const thrownMessage = `Blocked action vercel-deploy: ${spec.blockedReason ?? "Action prerequisites are not met."}`;
    const envelope = buildOrchestratorActionError({
      error: new Error(thrownMessage),
      actionId: "vercel-deploy",
      projectRoot: "/repo",
    });

    expect(envelope.code).toBe("ACTION_BLOCKED");
    expect(envelope.ok).toBe(false);
    expect(envelope.message).toContain("Link the project first");
    expect(envelope.hint).toContain("vercel-deploy");
  });

  test("linked project does not block vercel-env-pull", () => {
    const plan = makePlan({ vercelLinked: true, hasEnvLocal: false });
    const spec = getOrchestratorActionSpec(plan, "vercel-env-pull");
    expect(spec.runnable).toBe(true);
    expect(spec.blockedReason).toBeNull();
  });

  test("linked project does not block vercel-deploy", () => {
    const plan = makePlan({ vercelLinked: true });
    const spec = getOrchestratorActionSpec(plan, "vercel-deploy");
    expect(spec.runnable).toBe(true);
    expect(spec.blockedReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bootstrap-project step ordering
// ---------------------------------------------------------------------------

describe("bootstrap-project delegation order", () => {
  test("steps are vercel-link -> vercel-env-pull -> install-missing", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "bootstrap-project");
    const stepNames = spec.steps.map((s) => s.step);
    expect(stepNames).toEqual([
      "vercel-link",
      "vercel-env-pull",
      "install-missing",
    ]);
  });

  test("link and env-pull use if-needed mode, install uses always", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "bootstrap-project");
    expect(spec.steps[0]).toEqual({ step: "vercel-link", mode: "if-needed" });
    expect(spec.steps[1]).toEqual({ step: "vercel-env-pull", mode: "if-needed" });
    expect(spec.steps[2]).toEqual({ step: "install-missing", mode: "always" });
  });
});

// ---------------------------------------------------------------------------
// install-missing no-op when missingSkills is empty
// ---------------------------------------------------------------------------

describe("install-missing with empty missingSkills", () => {
  test("spec is still runnable when missingSkills is empty", () => {
    const plan = makePlan({ missingSkills: [] });
    const spec = getOrchestratorActionSpec(plan, "install-missing");
    expect(spec.runnable).toBe(true);
  });

  test("spec is not visible when missingSkills is empty", () => {
    const plan = makePlan({ missingSkills: [] });
    const spec = getOrchestratorActionSpec(plan, "install-missing");
    expect(spec.visible).toBe(false);
  });

  test("spec is visible when missingSkills is non-empty", () => {
    const plan = makePlan({ missingSkills: ["nextjs"] });
    const spec = getOrchestratorActionSpec(plan, "install-missing");
    expect(spec.visible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error code coverage
// ---------------------------------------------------------------------------

describe("error classification completeness", () => {
  const errorExamples: Array<{
    label: string;
    message: string;
    expectedCode: OrchestratorActionRunErrorCode;
  }> = [
    {
      label: "missing plan",
      message: "Missing install plan at /repo/.skills/install-plan.json",
      expectedCode: "MISSING_INSTALL_PLAN",
    },
    {
      label: "invalid action",
      message: "Invalid --action: foobar",
      expectedCode: "INVALID_ACTION",
    },
    {
      label: "blocked action",
      message: "Blocked action vercel-env-pull: prereqs not met",
      expectedCode: "ACTION_BLOCKED",
    },
    {
      label: "generic error",
      message: "ENOENT: no such file or directory",
      expectedCode: "RUNNER_ERROR",
    },
  ];

  for (const { label, message, expectedCode } of errorExamples) {
    test(`${label} → ${expectedCode}`, () => {
      const err = buildOrchestratorActionError({
        error: new Error(message),
        actionId: "install-missing",
        projectRoot: "/repo",
      });
      expect(err.code).toBe(expectedCode);
    });
  }
});

// ---------------------------------------------------------------------------
// Real runOrchestratorAction with temp filesystem
// ---------------------------------------------------------------------------

describe("runOrchestratorAction with real filesystem", () => {
  // Use mock.module to override plan-state so we can control plan reads
  // without needing a real SessionStart to have run first.
  const ROOT = resolve(import.meta.dirname, "..");
  const PLAN_STATE_MODULE = resolve(
    ROOT,
    "hooks",
    "src",
    "orchestrator-install-plan-state.mjs",
  );
  const RUNNER_MODULE = resolve(
    ROOT,
    "hooks",
    "src",
    "orchestrator-action-runner.mts",
  );

  function setupMockedRunner(plan: SkillInstallPlan) {
    mock.module(PLAN_STATE_MODULE, () => ({
      requirePersistedSkillInstallPlan: () => plan,
      refreshPersistedSkillInstallPlan: (args: {
        projectRoot: string;
        previousPlan: SkillInstallPlan;
      }) => ({
        ...plan,
        projectRoot: args.projectRoot,
        // Re-derive from plan to simulate refresh
        vercelLinked: plan.vercelLinked,
        hasEnvLocal: plan.hasEnvLocal,
        missingSkills: plan.missingSkills,
      }),
      installPlanPath: (projectRoot: string) =>
        join(projectRoot, ".skills", "install-plan.json"),
      readPersistedSkillInstallPlan: () => plan,
      writePersistedSkillInstallPlan: () => {},
    }));
  }

  function makeMockRegistryClient(
    result?: Partial<{
      installed: string[];
      reused: string[];
      missing: string[];
      command: string | null;
    }>,
  ) {
    return {
      installSkills: mock(async () => ({
        installed: result?.installed ?? ["nextjs"],
        reused: result?.reused ?? [],
        missing: result?.missing ?? [],
        command:
          result?.command ??
          "npx skills add vercel/vercel-skills --skill nextjs --agent claude-code -y --copy",
      })),
    };
  }

  function makeMockVercelDelegator() {
    return {
      run: mock(
        async (args: { projectRoot: string; subcommand: string }) => ({
          ok: true,
          subcommand: args.subcommand,
          command:
            args.subcommand === "link"
              ? "vercel link --yes"
              : args.subcommand === "env-pull"
                ? "vercel env pull --yes"
                : "vercel deploy",
          stdout: "",
          stderr: "",
          changed: true,
        }),
      ),
    };
  }

  test("vercel-env-pull throws on unlinked repo — does not invoke delegator", async () => {
    const plan = makePlan({ vercelLinked: false });
    setupMockedRunner(plan);

    const runner = await import(
      `${RUNNER_MODULE}?t=${Date.now()}-${Math.random()}`
    );
    const delegator = makeMockVercelDelegator();

    try {
      await runner.runOrchestratorAction({
        projectRoot: "/repo",
        actionId: "vercel-env-pull",
        vercelDelegator: delegator,
      });
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Blocked action vercel-env-pull");

      const envelope = runner.buildOrchestratorActionError({
        error: err,
        actionId: "vercel-env-pull",
        projectRoot: "/repo",
      });
      expect(envelope.code).toBe("ACTION_BLOCKED");
      expect(envelope.type).toBe("vercel-plugin-orchestrator-action-error");
    }

    // Delegator must NOT have been called
    expect(delegator.run).not.toHaveBeenCalled();
  });

  test("vercel-deploy throws on unlinked repo — does not invoke delegator", async () => {
    const plan = makePlan({ vercelLinked: false });
    setupMockedRunner(plan);

    const runner = await import(
      `${RUNNER_MODULE}?t=${Date.now()}-${Math.random()}`
    );
    const delegator = makeMockVercelDelegator();

    try {
      await runner.runOrchestratorAction({
        projectRoot: "/repo",
        actionId: "vercel-deploy",
        vercelDelegator: delegator,
      });
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Blocked action vercel-deploy");

      const envelope = runner.buildOrchestratorActionError({
        error: err,
        actionId: "vercel-deploy",
        projectRoot: "/repo",
      });
      expect(envelope.code).toBe("ACTION_BLOCKED");
      expect(envelope.type).toBe("vercel-plugin-orchestrator-action-error");
    }

    expect(delegator.run).not.toHaveBeenCalled();
  });

  test("bootstrap-project delegates link → env-pull → install in order", async () => {
    const plan = makePlan({
      vercelLinked: false,
      hasEnvLocal: false,
      missingSkills: ["nextjs"],
    });
    setupMockedRunner(plan);

    const runner = await import(
      `${RUNNER_MODULE}?t=${Date.now()}-${Math.random()}`
    );
    const delegator = makeMockVercelDelegator();
    const registry = makeMockRegistryClient();

    const result = await runner.runOrchestratorAction({
      projectRoot: "/repo",
      actionId: "bootstrap-project",
      registryClient: registry,
      vercelDelegator: delegator,
    });

    expect(result.type).toBe("vercel-plugin-orchestrator-action-result");
    expect(result.actionId).toBe("bootstrap-project");

    // Verify delegation calls happened
    const vercelCalls = delegator.run.mock.calls;
    // link is if-needed and project is not linked, so it should run
    // env-pull is if-needed; after link the .vercel dir doesn't actually
    // exist on mock fs, so it will be skipped (mode: if-needed, !linked)
    // install-missing should run because missingSkills is non-empty
    expect(vercelCalls.length).toBeGreaterThanOrEqual(1);
    expect(vercelCalls[0][0].subcommand).toBe("link");
    expect(registry.installSkills).toHaveBeenCalled();
  });

  test("install-missing no-ops when missingSkills is empty", async () => {
    const plan = makePlan({ missingSkills: [] });
    setupMockedRunner(plan);

    const runner = await import(
      `${RUNNER_MODULE}?t=${Date.now()}-${Math.random()}`
    );
    const registry = makeMockRegistryClient();
    const delegator = makeMockVercelDelegator();

    const result = await runner.runOrchestratorAction({
      projectRoot: "/repo",
      actionId: "install-missing",
      registryClient: registry,
      vercelDelegator: delegator,
    });

    expect(result.ok).toBe(true);
    expect(result.installResult).toBeNull();
    expect(registry.installSkills).not.toHaveBeenCalled();
    expect(delegator.run).not.toHaveBeenCalled();
  });
});
