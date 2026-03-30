import {
  readDecisionCapsule,
  type DecisionCapsuleV1,
} from "../../hooks/src/routing-decision-capsule.mts";

export interface DecisionCatResult {
  ok: boolean;
  capsule: DecisionCapsuleV1 | null;
  error?: string;
}

export function runDecisionCat(
  artifactPath: string,
  json = false,
): { output: string; ok: boolean } {
  const capsule = readDecisionCapsule(artifactPath);

  if (json) {
    const result: DecisionCatResult = {
      ok: capsule !== null,
      capsule,
      ...(capsule === null ? { error: `Cannot read capsule: ${artifactPath}` } : {}),
    };
    return { output: JSON.stringify(result, null, 2), ok: result.ok };
  }

  if (!capsule) {
    return {
      output: `Decision capsule not found: ${artifactPath}`,
      ok: false,
    };
  }

  return { output: formatDecisionCapsule(capsule), ok: true };
}

export function formatDecisionCapsule(capsule: DecisionCapsuleV1): string {
  const lines: string[] = [
    `Decision: ${capsule.decisionId}`,
    `Hook: ${capsule.hook}`,
    `Tool: ${capsule.input.toolName}`,
    `Target: ${capsule.input.toolTarget}`,
    `Story: ${capsule.activeStory.kind ?? "none"}${capsule.activeStory.route ? ` (${capsule.activeStory.route})` : ""}`,
    `Injected: ${capsule.injectedSkills.join(", ") || "none"}`,
    `Candidate: ${capsule.attribution?.candidateSkill ?? "none"}`,
    `Rule: ${capsule.rulebookProvenance?.matchedRuleId ?? "none"}`,
    ...(capsule.rulebookProvenance
      ? [
          `Rule Boost: ${capsule.rulebookProvenance.ruleBoost}`,
          `Rule Reason: ${capsule.rulebookProvenance.ruleReason}`,
          `Rulebook: ${capsule.rulebookProvenance.rulebookPath}`,
        ]
      : []),
    `SHA256: ${capsule.sha256}`,
  ];

  if (capsule.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of capsule.issues) {
      lines.push(`  - [${issue.severity}] ${issue.code}: ${issue.message}`);
      if (issue.action) lines.push(`    action: ${issue.action}`);
    }
  }

  return lines.join("\n");
}
