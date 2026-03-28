/**
 * `vercel-plugin learn` — Distill verified routing wins into learned rules.
 *
 * Reads routing decision traces, exposure ledgers, and verification outcomes
 * from session history, distills high-precision routing rules, replays them
 * against historical traces to guard against regressions, and outputs or
 * writes the result as a deterministic JSON artifact.
 *
 * Usage:
 *   vercel-plugin learn --project . --json
 *   vercel-plugin learn --project . --write
 */

import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { readRoutingDecisionTrace } from "../../hooks/src/routing-decision-trace.mts";
import { loadSessionExposures, loadProjectRoutingPolicy } from "../../hooks/src/routing-policy-ledger.mts";
import { distillRulesFromTrace } from "../../hooks/src/rule-distillation.mts";
import { distillCompanionRules } from "../../hooks/src/companion-distillation.mts";
import {
  companionRulebookPath,
  saveCompanionRulebook,
} from "../../hooks/src/learned-companion-rulebook.mts";
import { distillPlaybooks } from "../../hooks/src/playbook-distillation.mts";
import {
  createEmptyPlaybookRulebook,
  playbookRulebookPath,
  savePlaybookRulebook,
} from "../../hooks/src/learned-playbook-rulebook.mts";
import type { LearnedRoutingRulesFile } from "../../hooks/src/rule-distillation.mts";
import type { LearnedCompanionRulebook } from "../../hooks/src/learned-companion-rulebook.mts";
import type { LearnedPlaybookRulebook } from "../../hooks/src/learned-playbook-rulebook.mts";
import type { RoutingDecisionTrace } from "../../hooks/src/routing-decision-trace.mts";
import type { SkillExposure } from "../../hooks/src/routing-policy-ledger.mts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LearnCommandOptions {
  project?: string;
  json?: boolean;
  write?: boolean;
  session?: string;
  minSupport?: number;
  minPrecision?: number;
  minLift?: number;
}

export interface LearnCommandOutput {
  rules: LearnedRoutingRulesFile;
  companions: LearnedCompanionRulebook;
  companionPath: string;
  playbooks: LearnedPlaybookRulebook;
  playbookPath: string;
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

/**
 * Discover session IDs from tmpdir by scanning for trace directories and
 * keeping only sessions whose exposure ledger belongs to the target project.
 * Pattern: vercel-plugin-<sessionId>-trace/
 */
function discoverSessionIds(projectRoot: string): string[] {
  const tmp = tmpdir();
  try {
    const entries = readdirSync(tmp);
    const ids: string[] = [];
    for (const entry of entries) {
      const match = entry.match(/^vercel-plugin-(.+)-trace$/);
      if (!match || !match[1]) continue;
      const sessionExposures = loadSessionExposures(match[1]);
      if (
        sessionExposures.some((exposure) => exposure.projectRoot === projectRoot)
      ) {
        ids.push(match[1]);
      }
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/**
 * Load all traces, optionally scoped to a single session.
 */
function loadTraces(
  sessionId: string | null,
  projectRoot: string,
): RoutingDecisionTrace[] {
  if (sessionId) {
    return readRoutingDecisionTrace(sessionId);
  }
  // Aggregate across all discovered sessions
  const sessionIds = discoverSessionIds(projectRoot);
  const all: RoutingDecisionTrace[] = [];
  for (const id of sessionIds) {
    all.push(...readRoutingDecisionTrace(id));
  }
  return all;
}

/**
 * Load all exposures, optionally scoped to a single session.
 */
function loadExposures(
  sessionId: string | null,
  projectRoot: string,
): SkillExposure[] {
  if (sessionId) {
    return loadSessionExposures(sessionId);
  }
  const sessionIds = discoverSessionIds(projectRoot);
  const all: SkillExposure[] = [];
  for (const id of sessionIds) {
    all.push(...loadSessionExposures(id));
  }
  return all;
}

// ---------------------------------------------------------------------------
// Output path
// ---------------------------------------------------------------------------

export function learnedRulesPath(projectRoot: string): string {
  return join(projectRoot, "generated", "learned-routing-rules.json");
}

// ---------------------------------------------------------------------------
// Core command
// ---------------------------------------------------------------------------

export async function runLearnCommand(options: LearnCommandOptions): Promise<number> {
  const projectRoot = resolve(options.project ?? ".");
  const jsonOutput = options.json ?? false;
  const writeOutput = options.write ?? false;
  const sessionId = options.session ?? null;

  // Validate project root
  const skillsDir = join(projectRoot, "skills");
  if (!existsSync(skillsDir)) {
    const msg = `error: no skills/ directory found at ${projectRoot}`;
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(msg);
    }
    return 2;
  }

  // Load inputs
  const traces = loadTraces(sessionId, projectRoot);
  const exposures = loadExposures(sessionId, projectRoot);
  const policy = loadProjectRoutingPolicy(projectRoot);

  console.error(JSON.stringify({
    event: "learn_inputs_loaded",
    traceCount: traces.length,
    exposureCount: exposures.length,
    sessionScope: sessionId ?? "all",
  }));

  if (traces.length === 0) {
    const result: LearnedRoutingRulesFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      projectRoot,
      rules: [],
      replay: { baselineWins: 0, baselineDirectiveWins: 0, learnedWins: 0, learnedDirectiveWins: 0, deltaWins: 0, deltaDirectiveWins: 0, regressions: [] },
      promotion: { accepted: true, errorCode: null, reason: "No traces to evaluate" },
    };
    const emptyCompanions = distillCompanionRules({
      projectRoot,
      traces: [],
      exposures: [],
    });
    const emptyPlaybooks = createEmptyPlaybookRulebook(projectRoot);
    const output: LearnCommandOutput = {
      rules: result,
      companions: emptyCompanions,
      companionPath: companionRulebookPath(projectRoot),
      playbooks: emptyPlaybooks,
      playbookPath: playbookRulebookPath(projectRoot),
    };
    if (jsonOutput) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error("No routing decision traces found. Run some sessions first.");
      // Still emit human-readable summary for consistent output
      console.log([
        "Learned routing rules: 0",
        "  promoted: 0",
        "  candidate: 0",
        "  holdout-fail: 0",
        "",
        "Replay:",
        "  baseline wins:           0",
        "  baseline directive wins: 0",
        "  learned wins:            0",
        "  learned directive wins:  0",
        "  delta:                   0",
        "  delta directive:         0",
        "  regressions:             0",
        "",
        "Companion rules: 0",
        "  promoted: 0",
        "",
        "Playbooks: 0",
        "  promoted: 0",
      ].join("\n"));
    }
    if (writeOutput) {
      const outPath = learnedRulesPath(projectRoot);
      writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
      console.error(JSON.stringify({ event: "learn_written", path: outPath }));
      saveCompanionRulebook(projectRoot, emptyCompanions);
      console.error(JSON.stringify({ event: "learn_companion_written", path: companionRulebookPath(projectRoot) }));
      savePlaybookRulebook(projectRoot, emptyPlaybooks);
      console.error(JSON.stringify({ event: "learn_playbooks_written", path: playbookRulebookPath(projectRoot) }));
    }
    return 0;
  }

  // Distill single-skill rules
  const result = distillRulesFromTrace({
    projectRoot,
    traces,
    exposures,
    policy,
    minSupport: options.minSupport,
    minPrecision: options.minPrecision,
    minLift: options.minLift,
  });

  // Distill companion rules
  const companionRulebook = distillCompanionRules({
    projectRoot,
    traces,
    exposures,
    minSupport: options.minSupport ?? 4,
    minPrecision: options.minPrecision ?? 0.75,
    minLift: options.minLift ?? 1.25,
  });

  // Distill playbook rules
  const playbookRulebook = distillPlaybooks({
    projectRoot,
    exposures,
    minSupport: options.minSupport ?? 3,
    minPrecision: options.minPrecision ?? 0.75,
    minLift: options.minLift ?? 1.25,
    maxSkills: 3,
  });

  const promoted = result.rules.filter((r) => r.confidence === "promote").length;
  const candidates = result.rules.filter((r) => r.confidence === "candidate").length;
  const holdoutFail = result.rules.filter((r) => r.confidence === "holdout-fail").length;
  const companionPromoted = companionRulebook.rules.filter((r) => r.confidence === "promote").length;
  const companionHoldoutFail = companionRulebook.rules.filter((r) => r.confidence === "holdout-fail").length;
  const playbookPromoted = playbookRulebook.rules.filter((r) => r.confidence === "promote").length;

  console.error(JSON.stringify({
    event: "learn_distill_complete",
    ruleCount: result.rules.length,
    promoted,
    candidates,
    holdoutFail,
    replayDelta: result.replay.deltaWins,
    regressions: result.replay.regressions.length,
    companionRuleCount: companionRulebook.rules.length,
    companionPromoted,
    companionHoldoutFail,
    playbookRuleCount: playbookRulebook.rules.length,
    playbookPromoted,
  }));

  const output: LearnCommandOutput = {
    rules: result,
    companions: companionRulebook,
    companionPath: companionRulebookPath(projectRoot),
    playbooks: playbookRulebook,
    playbookPath: playbookRulebookPath(projectRoot),
  };

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Human-readable summary
    const lines: string[] = [
      `Learned routing rules: ${result.rules.length}`,
      `  promoted: ${promoted}`,
      `  candidate: ${candidates}`,
      `  holdout-fail: ${holdoutFail}`,
      "",
      `Replay:`,
      `  baseline wins:           ${result.replay.baselineWins}`,
      `  baseline directive wins: ${result.replay.baselineDirectiveWins}`,
      `  learned wins:            ${result.replay.learnedWins}`,
      `  learned directive wins:  ${result.replay.learnedDirectiveWins}`,
      `  delta:                   ${result.replay.deltaWins > 0 ? "+" : ""}${result.replay.deltaWins}`,
      `  delta directive:         ${result.replay.deltaDirectiveWins > 0 ? "+" : ""}${result.replay.deltaDirectiveWins}`,
      `  regressions:             ${result.replay.regressions.length}`,
    ];

    lines.push("");
    lines.push(`Promotion: ${result.promotion.accepted ? "ACCEPTED" : "REJECTED"}`);
    if (result.promotion.errorCode) {
      lines.push(`  error code: ${result.promotion.errorCode}`);
    }
    lines.push(`  reason: ${result.promotion.reason}`);

    if (result.replay.regressions.length > 0) {
      lines.push("");
      lines.push("Regression decision IDs:");
      for (const id of result.replay.regressions) {
        lines.push(`  - ${id}`);
      }
    }

    if (promoted > 0) {
      lines.push("");
      lines.push("Promoted rules:");
      for (const rule of result.rules) {
        if (rule.confidence !== "promote") continue;
        lines.push(`  ${rule.id} (${rule.kind}, precision=${rule.precision}, lift=${rule.lift}, support=${rule.support})`);
      }
    }

    // Companion rules summary
    lines.push("");
    lines.push(`Companion rules: ${companionRulebook.rules.length}`);
    lines.push(`  promoted: ${companionPromoted}`);
    lines.push(`  holdout-fail: ${companionHoldoutFail}`);

    if (companionPromoted > 0) {
      lines.push("");
      lines.push("Promoted companions:");
      for (const rule of companionRulebook.rules) {
        if (rule.confidence !== "promote") continue;
        lines.push(`  ${rule.candidateSkill} -> ${rule.companionSkill} (precision=${rule.precisionWithCompanion}, lift=${rule.liftVsCandidateAlone}, support=${rule.support})`);
      }
    }

    // Playbook rules summary
    lines.push("");
    lines.push(`Playbooks: ${playbookRulebook.rules.length}`);
    lines.push(`  promoted: ${playbookPromoted}`);

    if (playbookPromoted > 0) {
      lines.push("");
      lines.push("Promoted playbooks:");
      for (const rule of playbookRulebook.rules) {
        if (rule.confidence !== "promote") continue;
        lines.push(`  ${rule.orderedSkills.join(" → ")} (precision=${rule.precision}, lift=${rule.liftVsAnchorBaseline}, support=${rule.support})`);
      }
    }

    console.log(lines.join("\n"));
  }

  // Write
  if (writeOutput) {
    const outPath = learnedRulesPath(projectRoot);
    const payload = JSON.stringify(result, null, 2) + "\n";
    writeFileSync(outPath, payload);
    console.error(JSON.stringify({ event: "learn_written", path: outPath }));

    saveCompanionRulebook(projectRoot, companionRulebook);
    console.error(JSON.stringify({ event: "learn_companion_written", path: companionRulebookPath(projectRoot) }));

    savePlaybookRulebook(projectRoot, playbookRulebook);
    console.error(JSON.stringify({ event: "learn_playbooks_written", path: playbookRulebookPath(projectRoot) }));
  }

  // Non-zero exit if regressions detected
  if (result.replay.regressions.length > 0) {
    console.error(JSON.stringify({
      event: "learn_regressions_detected",
      count: result.replay.regressions.length,
    }));
    return 1;
  }

  return 0;
}
