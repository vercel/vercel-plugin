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
import {
  loadProjectRoutingPolicy,
  loadSessionExposures,
} from "../../hooks/src/routing-policy-ledger.mts";
import {
  computePlan,
  loadCachedPlanResult,
  selectActiveStory,
  type VerificationPlanResult,
} from "../../hooks/src/verification-plan.mts";
import {
  explainPolicyRecall,
  parsePolicyScenario,
  type PolicyRecallDiagnosis,
  type RoutingDiagnosisHint,
} from "../../hooks/src/routing-diagnosis.mts";
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

export interface SessionExplainDoctorRankedSkill {
  skill: string;
  basePriority: number;
  effectivePriority: number;
  policyBoost: number;
  policyReason: string | null;
  synthetic: boolean;
  droppedReason: string | null;
}

export interface CompanionRecallDoctorEntry {
  companionSkill: string;
  candidateSkill: string | null;
  patternType: string;
  patternValue: string;
  synthetic: boolean;
  droppedReason: string | null;
}

export interface CompanionRecallDiagnosis {
  detected: boolean;
  entries: CompanionRecallDoctorEntry[];
}

export interface SessionExplainDoctorCause {
  code: string;
  stage: string;
  skill: string;
  synthetic: boolean;
  scoreDelta: number;
  message: string;
  detail: Record<string, unknown>;
}

export interface SessionExplainDoctorEdge {
  fromSkill: string;
  toSkill: string;
  relation: string;
  code: string;
  detail: Record<string, unknown>;
}

export interface SessionExplainDoctor {
  latestDecisionId: string | null;
  latestScenario: string | null;
  latestRanked: SessionExplainDoctorRankedSkill[];
  policyRecall: PolicyRecallDiagnosis | null;
  companionRecall: CompanionRecallDiagnosis;
  hints: RoutingDiagnosisHint[];
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
    candidateWins: number;
    contextWins: number;
  };
  diagnosis: SessionExplainDiagnosis[];
  doctor: SessionExplainDoctor | null;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map((item) => toRecord(item)).filter((item) => Object.keys(item).length > 0)
    : [];
}

function readDecisionCauses(
  trace: Record<string, unknown>,
): SessionExplainDoctorCause[] {
  return toRecordArray(trace.causes).map((cause) => ({
    code: stringOrNull(cause.code) ?? "unknown",
    stage: stringOrNull(cause.stage) ?? "unknown",
    skill: stringOrNull(cause.skill) ?? "unknown",
    synthetic: cause.synthetic === true,
    scoreDelta: typeof cause.scoreDelta === "number" ? cause.scoreDelta : 0,
    message: stringOrNull(cause.message) ?? "",
    detail: toRecord(cause.detail),
  }));
}

function readDecisionEdges(
  trace: Record<string, unknown>,
): SessionExplainDoctorEdge[] {
  return toRecordArray(trace.edges).map((edge) => ({
    fromSkill: stringOrNull(edge.fromSkill) ?? "unknown",
    toSkill: stringOrNull(edge.toSkill) ?? "unknown",
    relation: stringOrNull(edge.relation) ?? "unknown",
    code: stringOrNull(edge.code) ?? "unknown",
    detail: toRecord(edge.detail),
  }));
}

function buildCompanionRecallDiagnosis(
  trace: Record<string, unknown>,
  rankedSource: unknown[],
): CompanionRecallDiagnosis {
  // Prefer explicit causes/edges from the causality system
  const causes = readDecisionCauses(trace);
  const edges = readDecisionEdges(trace);

  const explicitEntries = causes
    .filter((cause) => cause.code === "verified-companion")
    .map<CompanionRecallDoctorEntry>((cause) => {
      const edge = edges.find(
        (item) =>
          item.code === "verified-companion" &&
          item.toSkill === cause.skill,
      );
      return {
        companionSkill: cause.skill,
        candidateSkill: edge
          ? edge.fromSkill
          : stringOrNull(cause.detail.candidateSkill),
        patternType: cause.code,
        patternValue: stringOrNull(cause.detail.scenario) ?? "scenario-companion-rulebook",
        synthetic: cause.synthetic,
        droppedReason: stringOrNull(cause.detail.droppedReason),
      };
    });

  if (explicitEntries.length > 0) {
    return { detected: true, entries: explicitEntries };
  }

  // Backward-compatible fallback for old traces without causes/edges
  const fallbackEntries: CompanionRecallDoctorEntry[] = [];
  for (const entry of rankedSource) {
    const obj = toRecord(entry);
    const pattern = toRecord(obj.pattern);
    if (stringOrNull(pattern.type) !== "verified-companion") continue;
    const skill = stringOrNull(obj.skill);
    if (!skill) continue;

    let candidateSkill: string | null = null;
    const idx = rankedSource.indexOf(entry);
    for (let i = idx - 1; i >= 0; i--) {
      const prev = toRecord(rankedSource[i]);
      const prevPattern = toRecord(prev.pattern);
      if (stringOrNull(prevPattern.type) !== "verified-companion") {
        candidateSkill = stringOrNull(prev.skill);
        break;
      }
    }

    fallbackEntries.push({
      companionSkill: skill,
      candidateSkill,
      patternType: String(pattern.type),
      patternValue: stringOrNull(pattern.value) ?? "scenario-companion-rulebook",
      synthetic: obj.synthetic === true,
      droppedReason: stringOrNull(obj.droppedReason),
    });
  }

  return { detected: fallbackEntries.length > 0, entries: fallbackEntries };
}

function buildRoutingDoctor(
  latestTrace: unknown,
  plan: VerificationPlanResult,
  projectRoot: string,
): SessionExplainDoctor | null {
  const trace = toRecord(latestTrace);
  if (Object.keys(trace).length === 0) return null;

  const rankedSource = Array.isArray(trace.ranked) ? trace.ranked : [];
  const latestRanked = rankedSource
    .map((entry) => {
      const obj = toRecord(entry);
      const skill = stringOrNull(obj.skill);
      if (!skill) return null;
      return {
        skill,
        basePriority: numberOrZero(obj.basePriority),
        effectivePriority: numberOrZero(obj.effectivePriority),
        policyBoost: numberOrZero(obj.policyBoost),
        policyReason: stringOrNull(obj.policyReason),
        synthetic: obj.synthetic === true,
        droppedReason: stringOrNull(obj.droppedReason),
      };
    })
    .filter(
      (entry): entry is SessionExplainDoctorRankedSkill => entry !== null,
    );

  const latestScenario = stringOrNull(trace.policyScenario);
  const parsedScenario = parsePolicyScenario(latestScenario);

  const primaryStory = selectActiveStory(plan);
  const primaryStoryRecord = toRecord(trace.primaryStory);
  const routeScope =
    stringOrNull(trace.observedRoute) ??
    stringOrNull(primaryStoryRecord.storyRoute) ??
    primaryStory?.route ??
    null;

  const scenario = parsedScenario
    ? {
        ...parsedScenario,
        routeScope: parsedScenario.routeScope ?? routeScope,
      }
    : null;

  const injectedSkills = Array.isArray(trace.injectedSkills)
    ? trace.injectedSkills.map((skill) => String(skill))
    : [];

  const excludeSkills = new Set<string>([
    ...latestRanked.map((entry) => entry.skill),
    ...injectedSkills,
  ]);

  const policy = loadProjectRoutingPolicy(projectRoot);
  const policyRecall =
    scenario &&
    scenario.targetBoundary
      ? explainPolicyRecall(policy, scenario, {
          excludeSkills,
          maxCandidates: 1,
        })
      : null;

  // --- Companion recall extraction: prefer explicit causes/edges, fall back to ranked[] ---
  const companionRecall = buildCompanionRecallDiagnosis(trace, rankedSource);

  const hints: RoutingDiagnosisHint[] = [...(policyRecall?.hints ?? [])];

  if (latestRanked.length === 0) {
    hints.push({
      severity: "warning",
      code: "ROUTING_TRACE_MISSING_RANKED",
      message:
        "Latest routing trace has no ranked[] candidates",
      hint: "Ensure PreToolUse/UserPromptSubmit persists ranked[] into the routing decision trace",
    });
  }

  if (companionRecall.detected) {
    for (const ce of companionRecall.entries) {
      if (!ce.candidateSkill) {
        hints.push({
          severity: "warning",
          code: "COMPANION_EDGE_MISSING",
          message: `Companion-recalled skill ${ce.companionSkill} has no explicit candidateSkill in the trace`,
          hint: "Write a verified-companion edge into the routing trace instead of inferring from ranked order",
        });
      }
      if (!ce.synthetic) {
        hints.push({
          severity: "warning",
          code: "COMPANION_RECALL_NOT_SYNTHETIC",
          message: `Companion-recalled skill ${ce.companionSkill} is not marked synthetic in the routing trace`,
          hint: "Companion-recalled skills must be synthetic to preserve causal attribution",
        });
      }
    }
  }

  return {
    latestDecisionId: stringOrNull(trace.decisionId),
    latestScenario,
    latestRanked,
    policyRecall,
    companionRecall,
    hints,
  };
}

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

  // Emit hard diagnosis when live exclusions exist but manifest reports none
  if (liveExcluded.length > 0 && manifestExcludedSkills.length === 0) {
    diagnosis.push({
      severity: "error",
      code: "MANIFEST_EXCLUSION_DRIFT",
      message:
        "Live exclusion policy found excluded skills, but generated/skill-manifest.json lists none.",
      hint: "Run `bun run build:manifest` and commit the regenerated artifact.",
    });
  }

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
    activeStoryId: null,
    stories: [],
    storyStates: [],
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

  // --- Routing doctor ---
  const doctor = buildRoutingDoctor(latest, plan, projectRoot);

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
      candidateWins: exposures.filter((e) =>
        (e.outcome === "win" || e.outcome === "directive-win") &&
        (e as any).attributionRole === "candidate"
      ).length,
      contextWins: exposures.filter((e) =>
        (e.outcome === "win" || e.outcome === "directive-win") &&
        (e as any).attributionRole === "context"
      ).length,
    },
    diagnosis,
    doctor,
  };

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

  if (result.doctor) {
    lines.push("");
    lines.push("Routing doctor:");
    lines.push(`  Decision: ${result.doctor.latestDecisionId ?? "none"}`);
    lines.push(`  Scenario: ${result.doctor.latestScenario ?? "none"}`);
    if (result.doctor.latestRanked.length > 0) {
      const top = result.doctor.latestRanked
        .slice(0, 3)
        .map((entry) => `${entry.skill}=${entry.effectivePriority}`)
        .join(", ");
      lines.push(`  Top ranked: ${top}`);
    }
    if (result.doctor.policyRecall) {
      lines.push(
        `  Recall bucket: ${result.doctor.policyRecall.selectedBucket ?? "none"}`,
      );
      lines.push(
        `  Recall selected: ${
          result.doctor.policyRecall.selected
            .map((candidate) => candidate.skill)
            .join(", ") || "none"
        }`,
      );
    }
    if (result.doctor.companionRecall.detected) {
      const companions = result.doctor.companionRecall.entries
        .map((e) => `${e.companionSkill}→${e.candidateSkill ?? "?"}`)
        .join(", ");
      lines.push(`  Companion recall: ${companions}`);
    }
    for (const hint of result.doctor.hints) {
      lines.push(`  [${hint.severity}] ${hint.code}: ${hint.message}`);
      if (hint.hint) lines.push(`    -> ${hint.hint}`);
    }
  }

  return lines.join("\n") + "\n";
}
