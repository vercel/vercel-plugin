import { describe, expect, test } from "bun:test";
import { applyVerifiedPlaybookInsertion, buildPlaybookExposureRoles, formatOutput } from "../hooks/src/pretooluse-skill-inject.mts";

describe("applyVerifiedPlaybookInsertion", () => {
  test("splices ordered steps after anchor and emits verified-playbook reasons", () => {
    const result = applyVerifiedPlaybookInsertion({
      rankedSkills: ["verification", "vercel-functions"],
      matched: new Set(["verification", "vercel-functions"]),
      injectedSkills: new Set(["workflow"]),
      dedupOff: false,
      forceSummarySkills: new Set<string>(),
      selection: {
        anchorSkill: "verification",
        insertedSkills: ["workflow", "agent-browser-verify"],
        banner: "[vercel-plugin] Verified playbook applied",
      },
    });

    expect(result.rankedSkills).toEqual([
      "verification",
      "workflow",
      "agent-browser-verify",
      "vercel-functions",
    ]);
    expect(result.reasons.workflow).toEqual({
      trigger: "verified-playbook",
      reasonCode: "scenario-playbook-rulebook",
    });
    expect(result.reasons["agent-browser-verify"]).toEqual({
      trigger: "verified-playbook",
      reasonCode: "scenario-playbook-rulebook",
    });
    expect([...result.forceSummarySkills]).toEqual(["workflow"]);
    expect(result.banner).toBe("[vercel-plugin] Verified playbook applied");
  });

  test("no-ops when anchor skill is absent", () => {
    const result = applyVerifiedPlaybookInsertion({
      rankedSkills: ["vercel-functions"],
      matched: new Set(["vercel-functions"]),
      injectedSkills: new Set<string>(),
      dedupOff: false,
      forceSummarySkills: new Set<string>(),
      selection: {
        anchorSkill: "verification",
        insertedSkills: ["workflow"],
        banner: "[vercel-plugin] Verified playbook applied",
      },
    });

    expect(result.rankedSkills).toEqual(["vercel-functions"]);
    expect(result.reasons).toEqual({});
    expect(result.banner).toBeNull();
  });

  test("no-ops when selection is null", () => {
    const result = applyVerifiedPlaybookInsertion({
      rankedSkills: ["verification", "vercel-functions"],
      matched: new Set(["verification", "vercel-functions"]),
      injectedSkills: new Set<string>(),
      dedupOff: false,
      forceSummarySkills: new Set<string>(),
      selection: null,
    });

    expect(result.rankedSkills).toEqual(["verification", "vercel-functions"]);
    expect(result.reasons).toEqual({});
    expect(result.banner).toBeNull();
  });

  test("skips inserted skills already present in rankedSkills", () => {
    const result = applyVerifiedPlaybookInsertion({
      rankedSkills: ["verification", "workflow", "vercel-functions"],
      matched: new Set(["verification", "workflow", "vercel-functions"]),
      injectedSkills: new Set<string>(),
      dedupOff: false,
      forceSummarySkills: new Set<string>(),
      selection: {
        anchorSkill: "verification",
        insertedSkills: ["workflow", "agent-browser-verify"],
        banner: null,
      },
    });

    // "workflow" already present, only "agent-browser-verify" is inserted
    expect(result.rankedSkills).toEqual([
      "verification",
      "agent-browser-verify",
      "workflow",
      "vercel-functions",
    ]);
    expect(result.reasons.workflow).toBeUndefined();
    expect(result.reasons["agent-browser-verify"]).toEqual({
      trigger: "verified-playbook",
      reasonCode: "scenario-playbook-rulebook",
    });
  });

  test("does not mark deduped skills as forceSummary when dedupOff is true", () => {
    const result = applyVerifiedPlaybookInsertion({
      rankedSkills: ["verification", "vercel-functions"],
      matched: new Set(["verification", "vercel-functions"]),
      injectedSkills: new Set(["workflow"]),
      dedupOff: true,
      forceSummarySkills: new Set<string>(),
      selection: {
        anchorSkill: "verification",
        insertedSkills: ["workflow"],
        banner: null,
      },
    });

    expect(result.rankedSkills).toEqual([
      "verification",
      "workflow",
      "vercel-functions",
    ]);
    expect(result.forceSummarySkills.size).toBe(0);
  });
});

describe("buildPlaybookExposureRoles", () => {
  test("marks anchor as candidate and inserted steps as context", () => {
    const roles = buildPlaybookExposureRoles([
      "verification",
      "workflow",
      "agent-browser-verify",
    ]);
    expect(roles).toEqual([
      { skill: "verification", attributionRole: "candidate", candidateSkill: "verification" },
      { skill: "workflow", attributionRole: "context", candidateSkill: "verification" },
      { skill: "agent-browser-verify", attributionRole: "context", candidateSkill: "verification" },
    ]);
  });

  test("returns single candidate for solo anchor", () => {
    const roles = buildPlaybookExposureRoles(["verification"]);
    expect(roles).toEqual([
      { skill: "verification", attributionRole: "candidate", candidateSkill: "verification" },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(buildPlaybookExposureRoles([])).toEqual([]);
  });

  test("filters out empty strings", () => {
    const roles = buildPlaybookExposureRoles(["", "verification", "", "workflow"]);
    expect(roles).toEqual([
      { skill: "verification", attributionRole: "candidate", candidateSkill: "verification" },
      { skill: "workflow", attributionRole: "context", candidateSkill: "verification" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hook-layer integration: banner/reason contract through formatOutput
// ---------------------------------------------------------------------------

describe("hook-layer playbook banner/reason contract", () => {
  /**
   * Helper: extract the skillInjection metadata object from formatOutput's
   * HTML comment embedded in the additionalContext.
   */
  function extractMetadata(output: string): Record<string, unknown> | null {
    const parsed = JSON.parse(output);
    const ctx: string =
      parsed.hookSpecificOutput?.additionalContext ?? "";
    const match = ctx.match(/<!-- skillInjection: ({.*?}) -->/);
    if (!match) return null;
    return JSON.parse(match[1]) as Record<string, unknown>;
  }

  test("playbook banner appears exactly once in additionalContext", () => {
    const playbookApply = applyVerifiedPlaybookInsertion({
      rankedSkills: ["verification", "vercel-functions"],
      matched: new Set(["verification", "vercel-functions"]),
      injectedSkills: new Set<string>(),
      dedupOff: false,
      forceSummarySkills: new Set<string>(),
      selection: {
        anchorSkill: "verification",
        insertedSkills: ["workflow"],
        banner: "[vercel-plugin] Verified playbook applied",
      },
    });

    // Simulate run() wiring: prepend banner to parts
    const parts = ["skill-body-placeholder"];
    if (playbookApply.banner) {
      parts.unshift(playbookApply.banner);
    }

    const output = formatOutput({
      parts,
      matched: playbookApply.matched,
      injectedSkills: ["verification", "workflow", "vercel-functions"],
      droppedByCap: [],
      toolName: "Bash",
      toolTarget: "npm run dev",
      reasons: playbookApply.reasons,
    });

    const parsed = JSON.parse(output);
    const ctx: string = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Banner appears exactly once
    const bannerCount = ctx.split("[vercel-plugin] Verified playbook applied").length - 1;
    expect(bannerCount).toBe(1);
  });

  test("metadata exposes trigger and reasonCode for each playbook-inserted skill", () => {
    const playbookApply = applyVerifiedPlaybookInsertion({
      rankedSkills: ["verification", "vercel-functions"],
      matched: new Set(["verification", "vercel-functions"]),
      injectedSkills: new Set<string>(),
      dedupOff: false,
      forceSummarySkills: new Set<string>(),
      selection: {
        anchorSkill: "verification",
        insertedSkills: ["workflow", "agent-browser-verify"],
        banner: "[vercel-plugin] Verified playbook applied",
      },
    });

    const parts = ["body"];
    if (playbookApply.banner) parts.unshift(playbookApply.banner);

    const output = formatOutput({
      parts,
      matched: playbookApply.matched,
      injectedSkills: ["verification", "workflow", "agent-browser-verify", "vercel-functions"],
      droppedByCap: [],
      toolName: "Bash",
      toolTarget: "npm run dev",
      reasons: playbookApply.reasons,
    });

    const meta = extractMetadata(output);
    expect(meta).not.toBeNull();
    const reasons = meta!.reasons as Record<string, { trigger: string; reasonCode: string }>;
    expect(reasons.workflow).toEqual({
      trigger: "verified-playbook",
      reasonCode: "scenario-playbook-rulebook",
    });
    expect(reasons["agent-browser-verify"]).toEqual({
      trigger: "verified-playbook",
      reasonCode: "scenario-playbook-rulebook",
    });
  });

  test("no playbook reasons or banner in metadata when selection is null", () => {
    const playbookApply = applyVerifiedPlaybookInsertion({
      rankedSkills: ["vercel-functions"],
      matched: new Set(["vercel-functions"]),
      injectedSkills: new Set<string>(),
      dedupOff: false,
      forceSummarySkills: new Set<string>(),
      selection: null,
    });

    const parts = ["body"];
    // No banner to prepend
    expect(playbookApply.banner).toBeNull();

    const output = formatOutput({
      parts,
      matched: playbookApply.matched,
      injectedSkills: ["vercel-functions"],
      droppedByCap: [],
      toolName: "Read",
      toolTarget: "src/app.tsx",
      reasons: playbookApply.reasons,
    });

    const meta = extractMetadata(output);
    expect(meta).not.toBeNull();
    // No reasons key when reasons is empty
    expect(meta!.reasons).toBeUndefined();

    const parsed = JSON.parse(output);
    const ctx: string = parsed.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).not.toContain("Verified playbook");
  });
});
