/**
 * `vercel-plugin session-explain` — unified control-plane snapshot.
 *
 * Merges manifest provenance, routing decision traces, verification plan
 * state, and exposure outcomes into a single deterministic JSON/human output.
 *
 * JSON mode: stable additive-only contract for downstream agent consumers.
 * Text mode: concise operator summary with actionable next steps.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadValidatedSkillMap } from "../shared/skill-map-loader.ts";
import { filterExcludedSkillMap, type SkillExclusion } from "../shared/skill-exclusion-policy.ts";
import { readRoutingDecisionTrace } from "../../hooks/src/routing-decision-trace.mts";
import { loadSessionExposures } from "../../hooks/src/routing-policy-ledger.mts";
import {
  computePlan,
  loadCachedPlanResult,
  type VerificationPlanResult,
} from "../../hooks/src/verification-plan.mts";
import {
  buildVerificationDirective,
  buildVerificationEnv,
  type VerificationDirective,
} from "../../hooks/src/verification-directive.mts";

// ---------------------------------------------------------------------------
// Stable JSON contract (additive-only)
// ---------------------------------------------------------------------------

export interface SessionExplainDiagnosis {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  hint?: string;
}

export interface SessionExplainResult {
  ok: boolean;
  sessionId: string | null;
  manifest: {
    generatedAt: string | null;
    skillCount: number;
    excludedSkills: SkillExclusion[];
    parity: {
      ok: boolean;
      missingFromManifest: string[];
      extraInManifest: string[];
    };
  };
  routing: {
    decisionCount: number;
    latestDecisionId: string | null;
    latestHook: string | null;
    latestPolicyScenario: string | null;
  };
  verification: {
    hasStories: boolean;
    missingBoundaries: string[];
    satisfiedBoundaries: string[];
    primaryNextAction: VerificationPlanResult["primaryNextAction"];
    directive: VerificationDirective | null;
    env: Record<string, string>;
  };
  exposures: {
    pending: number;
    wins: number;
    directiveWins: number;
    staleMisses: number;
  };
  diagnosis: SessionExplainDiagnosis[];
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export function runSessionExplain(
  sessionId: string | null,
  projectRoot: string,
  json = false,
): string {
  const manifestPath = join(projectRoot, "generated", "skill-manifest.json");
  const skillsDir = join(projectRoot, "skills");
  const diagnosis: SessionExplainDiagnosis[] = [];

  // --- Manifest ---
  let generatedAt: string | null = null;
  let manifestSkills: Record<string, unknown> = {};
  let manifestExcludedSkills: SkillExclusion[] = [];

  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      generatedAt = manifest.generatedAt ?? null;
      manifestSkills = manifest.skills ?? {};
      manifestExcludedSkills = manifest.excludedSkills ?? [];
    } catch (err: any) {
      diagnosis.push({
        severity: "error",
        code: "MANIFEST_PARSE_FAILED",
        message: `Failed to parse generated/skill-manifest.json: ${err.message}`,
        hint: "Run `bun run build:manifest` to regenerate it",
      });
    }
  } else {
    diagnosis.push({
      severity: "warning",
      code: "MANIFEST_MISSING",
      message: "No generated/skill-manifest.json found",
      hint: "Run `bun run build:manifest`",
    });
  }

  // --- Live scan with exclusion policy ---
  let liveNames = new Set<string>();
  let liveExcluded: SkillExclusion[] = [];

  if (existsSync(skillsDir)) {
    const live = loadValidatedSkillMap(skillsDir);
    const filteredLive = filterExcludedSkillMap(live.skills);
    liveNames = new Set(Object.keys(filteredLive.included));
    liveExcluded = filteredLive.excluded;
  }

  // Use manifest exclusions if available, otherwise fall back to live scan
  const excludedSkills = manifestExcludedSkills.length > 0
    ? manifestExcludedSkills
    : liveExcluded;

  // Emit exclusion diagnosis for each excluded skill
  for (const ex of excludedSkills) {
    diagnosis.push({
      severity: "info",
      code: "SKILL_EXCLUDED_BY_POLICY",
      message: `${ex.slug} is intentionally excluded from the runtime manifest`,
      hint: "Rename the skill if it should ship at runtime",
    });
  }

  // --- Manifest parity ---
  const manifestNames = new Set(Object.keys(manifestSkills));
  const missingFromManifest = [...liveNames].filter((s) => !manifestNames.has(s)).sort();
  const extraInManifest = [...manifestNames].filter((s) => !liveNames.has(s)).sort();

  // --- Routing traces ---
  const traces = readRoutingDecisionTrace(sessionId);
  const latest = traces[traces.length - 1] ?? null;

  // --- Verification plan ---
  const emptyPlan: VerificationPlanResult = {
    hasStories: false,
    stories: [],
    observationCount: 0,
    satisfiedBoundaries: [],
    missingBoundaries: [],
    recentRoutes: [],
    primaryNextAction: null,
    blockedReasons: [],
  };

  let plan: VerificationPlanResult;
  if (sessionId) {
    const cached = loadCachedPlanResult(sessionId);
    plan = cached ?? computePlan(sessionId);
  } else {
    plan = emptyPlan;
  }

  const directive = buildVerificationDirective(plan);
  const env = buildVerificationEnv(directive);

  // --- Exposures ---
  const exposures = sessionId ? loadSessionExposures(sessionId) : [];

  // --- Assemble result ---
  const result: SessionExplainResult = {
    ok: true,
    sessionId,
    manifest: {
      generatedAt,
      skillCount: Object.keys(manifestSkills).length,
      excludedSkills,
      parity: {
        ok: missingFromManifest.length === 0 && extraInManifest.length === 0,
        missingFromManifest,
        extraInManifest,
      },
    },
    routing: {
      decisionCount: traces.length,
      latestDecisionId: latest?.decisionId ?? null,
      latestHook: latest?.hook ?? null,
      latestPolicyScenario: latest?.policyScenario ?? null,
    },
    verification: {
      hasStories: plan.hasStories,
      missingBoundaries: [...plan.missingBoundaries],
      satisfiedBoundaries: [...plan.satisfiedBoundaries],
      primaryNextAction: plan.primaryNextAction,
      directive,
      env,
    },
    exposures: {
      pending: exposures.filter((e) => e.outcome === "pending").length,
      wins: exposures.filter((e) => e.outcome === "win").length,
      directiveWins: exposures.filter((e) => e.outcome === "directive-win").length,
      staleMisses: exposures.filter((e) => e.outcome === "stale-miss").length,
    },
    diagnosis,
  };

  // Log structured state transition
  console.error(JSON.stringify({
    event: "session_explain",
    sessionId,
    skillCount: result.manifest.skillCount,
    excludedCount: excludedSkills.length,
    routingDecisions: traces.length,
    hasVerificationStories: plan.hasStories,
    diagnosisCount: diagnosis.length,
  }));

  if (json) return JSON.stringify(result, null, 2);
  return formatSessionExplainText(result);
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

function formatSessionExplainText(result: SessionExplainResult): string {
  const lines: string[] = [
    `Session: ${result.sessionId ?? "none"}`,
    `Manifest: ${result.manifest.skillCount} skills`,
    `Excluded: ${result.manifest.excludedSkills.map((s) => s.slug).join(", ") || "none"}`,
    `Parity: ${result.manifest.parity.ok ? "ok" : "drift detected"}`,
    `Routing traces: ${result.routing.decisionCount}`,
    `Latest hook: ${result.routing.latestHook ?? "none"}`,
    `Verification stories: ${result.verification.hasStories ? "yes" : "no"}`,
    result.verification.primaryNextAction
      ? `Next action: ${result.verification.primaryNextAction.action}`
      : "Next action: none",
    `Pending exposures: ${result.exposures.pending}`,
  ];

  if (result.diagnosis.length > 0) {
    lines.push("");
    lines.push("Diagnosis:");
    for (const d of result.diagnosis) {
      lines.push(`  [${d.severity}] ${d.code}: ${d.message}`);
      if (d.hint) lines.push(`    -> ${d.hint}`);
    }
  }

  return lines.join("\n") + "\n";
}
