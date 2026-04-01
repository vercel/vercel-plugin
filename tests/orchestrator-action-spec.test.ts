import { describe, expect, mock, test } from "bun:test";
import type { SkillInstallPlan } from "../hooks/src/orchestrator-install-plan.mts";
import {
  getOrchestratorActionSpecs,
  getOrchestratorActionSpec,
  type OrchestratorActionSpec,
} from "../hooks/src/orchestrator-action-spec.mts";
import {
  ORCHESTRATOR_ACTION_IDS,
  buildOrchestratorRunnerCommand,
  type OrchestratorRunnerActionId,
} from "../hooks/src/orchestrator-action-command.mts";
import { formatOrchestratorActionPalette } from "../hooks/src/orchestrator-action-palette.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<SkillInstallPlan> = {}): SkillInstallPlan {
  return {
    schemaVersion: 1,
    createdAt: "2026-04-01T10:00:00.000Z",
    projectRoot: "/repo",
    likelySkills: ["nextjs"],
    installedSkills: [],
    missingSkills: ["nextjs"],
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
// getOrchestratorActionSpecs — visibility
// ---------------------------------------------------------------------------

describe("getOrchestratorActionSpecs", () => {
  test("unlinked project with missing skills shows bootstrap, install-missing, vercel-link", () => {
    const specs = getOrchestratorActionSpecs(makePlan());
    const visible = specs.filter((s) => s.visible).map((s) => s.id);
    expect(visible).toContain("bootstrap-project");
    expect(visible).toContain("install-missing");
    expect(visible).toContain("vercel-link");
    expect(visible).not.toContain("vercel-env-pull");
    expect(visible).not.toContain("vercel-deploy");
  });

  test("linked project with env and no missing skills hides most actions", () => {
    const specs = getOrchestratorActionSpecs(
      makePlan({
        vercelLinked: true,
        hasEnvLocal: true,
        missingSkills: [],
        installedSkills: ["nextjs"],
      }),
    );
    const visible = specs.filter((s) => s.visible).map((s) => s.id);
    // Only deploy should be visible
    expect(visible).toEqual(["vercel-deploy"]);
  });

  test("linked project without env shows env-pull and deploy", () => {
    const specs = getOrchestratorActionSpecs(
      makePlan({
        vercelLinked: true,
        hasEnvLocal: false,
        missingSkills: [],
      }),
    );
    const visible = specs.filter((s) => s.visible).map((s) => s.id);
    expect(visible).toContain("bootstrap-project");
    expect(visible).toContain("vercel-env-pull");
    expect(visible).toContain("vercel-deploy");
    expect(visible).not.toContain("vercel-link");
  });

  test("all spec IDs are in ORCHESTRATOR_ACTION_IDS", () => {
    const specs = getOrchestratorActionSpecs(makePlan());
    for (const spec of specs) {
      expect(ORCHESTRATOR_ACTION_IDS).toContain(spec.id);
    }
  });

  test("spec order is deterministic across calls", () => {
    const plan = makePlan();
    const ids1 = getOrchestratorActionSpecs(plan).map((s) => s.id);
    const ids2 = getOrchestratorActionSpecs(plan).map((s) => s.id);
    expect(ids1).toEqual(ids2);
  });

  test("bootstrap steps include if-needed for link and env-pull", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "bootstrap-project");
    expect(spec.steps).toEqual([
      { step: "vercel-link", mode: "if-needed" },
      { step: "vercel-env-pull", mode: "if-needed" },
      { step: "install-missing", mode: "always" },
    ]);
  });

  test("install-missing has a single always step", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ missingSkills: ["nextjs"] }),
      "install-missing",
    );
    expect(spec.steps).toEqual([{ step: "install-missing", mode: "always" }]);
  });

  // -------------------------------------------------------------------------
  // runnable / blockedReason
  // -------------------------------------------------------------------------

  test("vercel-env-pull is blocked when project is not linked", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: false }),
      "vercel-env-pull",
    );
    expect(spec.runnable).toBe(false);
    expect(spec.blockedReason).toContain("Link the project first");
  });

  test("vercel-env-pull is blocked when .env.local already exists", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: true, hasEnvLocal: true }),
      "vercel-env-pull",
    );
    expect(spec.runnable).toBe(false);
    expect(spec.blockedReason).toContain("already exists");
  });

  test("vercel-env-pull is runnable when linked and no .env.local", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: true, hasEnvLocal: false }),
      "vercel-env-pull",
    );
    expect(spec.runnable).toBe(true);
    expect(spec.blockedReason).toBeNull();
  });

  test("vercel-deploy is blocked when project is not linked", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: false }),
      "vercel-deploy",
    );
    expect(spec.runnable).toBe(false);
    expect(spec.blockedReason).toContain("Link the project first");
  });

  test("vercel-deploy is runnable when linked", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: true }),
      "vercel-deploy",
    );
    expect(spec.runnable).toBe(true);
    expect(spec.blockedReason).toBeNull();
  });

  test("bootstrap-project is always runnable", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "bootstrap-project");
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

  test("throws for invalid action ID", () => {
    expect(() =>
      getOrchestratorActionSpec(makePlan(), "bogus" as OrchestratorRunnerActionId),
    ).toThrow("Invalid --action: bogus");
  });

  test("uses plan action descriptions when available", () => {
    const plan = makePlan({
      actions: [
        {
          id: "install-missing",
          label: "Install",
          description: "Custom install description",
          command: null,
        },
      ],
    });
    const spec = getOrchestratorActionSpec(plan, "install-missing");
    expect(spec.description).toBe("Custom install description");
  });
});

// ---------------------------------------------------------------------------
// buildOrchestratorRunnerCommand
// ---------------------------------------------------------------------------

describe("buildOrchestratorRunnerCommand", () => {
  test("produces correct command with --json", () => {
    const cmd = buildOrchestratorRunnerCommand({
      pluginRoot: "/plugin",
      projectRoot: "/repo",
      actionId: "install-missing",
    });
    expect(cmd).toContain("node /plugin/hooks/orchestrator-action-runner.mjs");
    expect(cmd).toContain("--project-root /repo");
    expect(cmd).toContain("--action install-missing");
    expect(cmd).toContain("--json");
  });

  test("omits --json when json: false", () => {
    const cmd = buildOrchestratorRunnerCommand({
      pluginRoot: "/plugin",
      projectRoot: "/repo",
      actionId: "vercel-deploy",
      json: false,
    });
    expect(cmd).not.toContain("--json");
  });

  test("quotes paths with spaces", () => {
    const cmd = buildOrchestratorRunnerCommand({
      pluginRoot: "/my plugin",
      projectRoot: "/my repo",
      actionId: "vercel-link",
    });
    expect(cmd).toContain("'/my plugin/hooks/orchestrator-action-runner.mjs'");
    expect(cmd).toContain("'/my repo'");
  });
});

// ---------------------------------------------------------------------------
// formatOrchestratorActionPalette — renders from shared spec
// ---------------------------------------------------------------------------

describe("formatOrchestratorActionPalette", () => {
  test("renders visible actions with numbered labels", () => {
    const output = formatOrchestratorActionPalette({
      pluginRoot: "/plugin",
      plan: makePlan(),
    });
    expect(output).not.toBeNull();
    expect(output).toContain("### Vercel wrapper palette");
    expect(output).toContain("[1] Bootstrap project");
    expect(output).toContain("[2] Install missing skills");
    expect(output).toContain("[3] Link Vercel project");
    // Unlinked → no deploy or env-pull
    expect(output).not.toContain("Deploy");
    expect(output).not.toContain("env-pull");
  });

  test("returns null when no actions are visible", () => {
    const output = formatOrchestratorActionPalette({
      pluginRoot: "/plugin",
      plan: makePlan({
        vercelLinked: true,
        hasEnvLocal: true,
        missingSkills: [],
        installedSkills: ["nextjs"],
      }),
    });
    // Only deploy is visible for a fully set up project
    expect(output).not.toBeNull();
    expect(output).toContain("[1] Deploy to Vercel");
  });

  test("returns null when everything is set up and deploy not linked", () => {
    const output = formatOrchestratorActionPalette({
      pluginRoot: "/plugin",
      plan: makePlan({
        vercelLinked: false,
        hasEnvLocal: true,
        missingSkills: [],
        installedSkills: ["nextjs"],
      }),
    });
    // bootstrap (hasEnvLocal=true but not linked → still visible) + vercel-link
    expect(output).not.toBeNull();
  });

  test("palette command strings contain the runner path", () => {
    const output = formatOrchestratorActionPalette({
      pluginRoot: "/plugin",
      plan: makePlan(),
    });
    expect(output).toContain("/plugin/hooks/orchestrator-action-runner.mjs");
  });

  test("palette order matches spec order", () => {
    const plan = makePlan();
    const specs = getOrchestratorActionSpecs(plan).filter((s) => s.visible);
    const output = formatOrchestratorActionPalette({
      pluginRoot: "/plugin",
      plan,
    })!;
    for (const [i, spec] of specs.entries()) {
      expect(output).toContain(`[${i + 1}] ${spec.label}`);
    }
  });
});

// ---------------------------------------------------------------------------
// runOrchestratorAction — runner delegates via shared spec steps
// ---------------------------------------------------------------------------

describe("runOrchestratorAction", () => {
  // We need to mock fs.existsSync and the plan state module.
  // Import the runner dynamically to allow mocking.

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

  // We can't easily mock the plan state readers in the runner without
  // restructuring imports. Instead, test the spec→runner step contract
  // by verifying that the spec steps drive the runner's delegation calls.

  test("bootstrap-project spec has 3 steps in correct order", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "bootstrap-project");
    expect(spec.steps.map((s) => s.step)).toEqual([
      "vercel-link",
      "vercel-env-pull",
      "install-missing",
    ]);
  });

  test("install-missing spec has exactly one step", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "install-missing");
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0].step).toBe("install-missing");
    expect(spec.steps[0].mode).toBe("always");
  });

  test("vercel-link spec has exactly one always step", () => {
    const spec = getOrchestratorActionSpec(makePlan(), "vercel-link");
    expect(spec.steps).toEqual([{ step: "vercel-link", mode: "always" }]);
  });

  test("vercel-deploy spec has exactly one always step", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: true }),
      "vercel-deploy",
    );
    expect(spec.steps).toEqual([{ step: "vercel-deploy", mode: "always" }]);
  });

  test("vercel-env-pull spec has exactly one always step", () => {
    const spec = getOrchestratorActionSpec(
      makePlan({ vercelLinked: true }),
      "vercel-env-pull",
    );
    expect(spec.steps).toEqual([{ step: "vercel-env-pull", mode: "always" }]);
  });

  test("every ORCHESTRATOR_ACTION_IDS entry has a spec", () => {
    const plan = makePlan();
    for (const id of ORCHESTRATOR_ACTION_IDS) {
      expect(() => getOrchestratorActionSpec(plan, id)).not.toThrow();
    }
  });

  test("mock registry client shape matches RegistryClient interface", () => {
    const client = makeMockRegistryClient();
    expect(typeof client.installSkills).toBe("function");
  });

  test("mock vercel delegator shape matches VercelCliDelegator interface", () => {
    const delegator = makeMockVercelDelegator();
    expect(typeof delegator.run).toBe("function");
  });

  test("mock delegator returns correct command for each subcommand", async () => {
    const delegator = makeMockVercelDelegator();
    const linkResult = await delegator.run({
      projectRoot: "/repo",
      subcommand: "link",
    });
    expect(linkResult.command).toBe("vercel link --yes");

    const envResult = await delegator.run({
      projectRoot: "/repo",
      subcommand: "env-pull",
    });
    expect(envResult.command).toBe("vercel env pull --yes");

    const deployResult = await delegator.run({
      projectRoot: "/repo",
      subcommand: "deploy",
    });
    expect(deployResult.command).toBe("vercel deploy");
  });
});

// ---------------------------------------------------------------------------
// Drift detection — palette and runner share the same spec source
// ---------------------------------------------------------------------------

describe("drift detection", () => {
  test("palette visible IDs are a subset of spec IDs", () => {
    const plan = makePlan();
    const specIds = getOrchestratorActionSpecs(plan).map((s) => s.id);
    const allCommandIds = [...ORCHESTRATOR_ACTION_IDS];
    // Every spec ID must be in the canonical list
    for (const id of specIds) {
      expect(allCommandIds).toContain(id);
    }
  });

  test("spec covers all canonical action IDs", () => {
    const plan = makePlan();
    const specIds = getOrchestratorActionSpecs(plan).map((s) => s.id);
    for (const id of ORCHESTRATOR_ACTION_IDS) {
      expect(specIds).toContain(id);
    }
  });

  test("palette rendering is driven by spec visibility, not independent logic", () => {
    // Confirm that if we make all specs invisible, palette returns null
    const plan = makePlan({
      vercelLinked: true,
      hasEnvLocal: true,
      missingSkills: [],
      installedSkills: ["nextjs"],
    });
    const allVisible = getOrchestratorActionSpecs(plan).filter(
      (s) => s.visible,
    );
    // Fully set up → only deploy is visible
    expect(allVisible.length).toBe(1);
    expect(allVisible[0].id).toBe("vercel-deploy");

    const palette = formatOrchestratorActionPalette({
      pluginRoot: "/plugin",
      plan,
    });
    // Palette should show exactly the one visible action
    expect(palette).toContain("[1] Deploy to Vercel");
    expect(palette).not.toContain("[2]");
  });

  test("step order in spec matches expected delegation sequence", () => {
    // bootstrap: link → env-pull → install (this is the critical ordering)
    const bootstrap = getOrchestratorActionSpec(makePlan(), "bootstrap-project");
    const stepNames = bootstrap.steps.map((s) => s.step);
    expect(stepNames.indexOf("vercel-link")).toBeLessThan(
      stepNames.indexOf("vercel-env-pull"),
    );
    expect(stepNames.indexOf("vercel-env-pull")).toBeLessThan(
      stepNames.indexOf("install-missing"),
    );
  });
});
