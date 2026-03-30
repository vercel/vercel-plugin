/**
 * playbook-recall.mts — Recall verified playbook sequences during hook injection.
 *
 * When a promoted playbook rule matches the current scenario and one of the
 * candidate skills is the playbook's anchor, the missing follow-on steps are
 * inserted after the anchor in ranked order. This upgrades injection from
 * recalling isolated winners to recalling proven multi-skill procedures.
 *
 * No-ops safely when:
 * - The playbook rulebook artifact is missing, invalid, or unsupported
 * - No promoted rule matches the current scenario
 * - All playbook steps are already present or excluded
 */

import {
  loadPlaybookRulebook,
  type LearnedPlaybookRule,
} from "./learned-playbook-rulebook.mjs";
import {
  scenarioKeyCandidates,
  type RoutingPolicyScenario,
} from "./routing-policy.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelectedPlaybook {
  ruleId: string;
  scenario: string;
  anchorSkill: string;
  orderedSkills: string[];
  insertedSkills: string[];
  support: number;
  precision: number;
  lift: number;
}

export interface RecallPlaybookResult {
  selected: SelectedPlaybook | null;
  banner: string | null;
  rejected: Array<{ ruleId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function rankRule(
  rule: LearnedPlaybookRule,
  candidateSkills: string[],
): [number, number, number, number, string] {
  const anchorIdx = candidateSkills.indexOf(rule.anchorSkill);
  return [
    anchorIdx === -1 ? Number.MAX_SAFE_INTEGER : anchorIdx,
    -rule.support,
    -rule.liftVsAnchorBaseline,
    -rule.precision,
    rule.id,
  ];
}

// ---------------------------------------------------------------------------
// Banner formatting
// ---------------------------------------------------------------------------

function formatPlaybookBanner(selected: SelectedPlaybook): string {
  return [
    "<!-- verified-playbook -->",
    "**[Verified Playbook]**",
    `Anchor: \`${selected.anchorSkill}\``,
    `Sequence: ${selected.orderedSkills.map((s) => `\`${s}\``).join(" → ")}`,
    `Evidence: support=${selected.support}, precision=${selected.precision}, lift=${selected.lift}`,
    "Use the sequence before inventing a new debugging workflow.",
    "<!-- /verified-playbook -->",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main recall function
// ---------------------------------------------------------------------------

export function recallVerifiedPlaybook(params: {
  projectRoot: string;
  scenario: RoutingPolicyScenario;
  candidateSkills: string[];
  excludeSkills?: Iterable<string>;
  maxInsertedSkills?: number;
}): RecallPlaybookResult {
  const loaded = loadPlaybookRulebook(params.projectRoot);
  if (!loaded.ok) {
    return { selected: null, banner: null, rejected: [] };
  }

  const exclude = new Set(params.excludeSkills ?? []);
  const maxInsertedSkills = Math.max(0, params.maxInsertedSkills ?? 2);
  const rejected: Array<{ ruleId: string; reason: string }> = [];

  for (const scenario of scenarioKeyCandidates(params.scenario)) {
    const eligible = loaded.rulebook.rules
      .filter(
        (rule) =>
          rule.confidence === "promote" &&
          rule.scenario === scenario &&
          params.candidateSkills.includes(rule.anchorSkill),
      )
      .sort((a, b) => {
        const ra = rankRule(a, params.candidateSkills);
        const rb = rankRule(b, params.candidateSkills);
        return (
          ra[0] - rb[0] ||
          ra[1] - rb[1] ||
          ra[2] - rb[2] ||
          ra[3] - rb[3] ||
          ra[4].localeCompare(rb[4])
        );
      });

    for (const rule of eligible) {
      const anchorPos = rule.orderedSkills.indexOf(rule.anchorSkill);
      const tail =
        anchorPos === -1
          ? rule.orderedSkills.slice(1)
          : rule.orderedSkills.slice(anchorPos + 1);
      const insertedSkills = tail
        .filter((skill) => !exclude.has(skill))
        .slice(0, maxInsertedSkills);

      if (insertedSkills.length === 0) {
        rejected.push({
          ruleId: rule.id,
          reason: "all_playbook_steps_already_present_or_no_budget",
        });
        continue;
      }

      const selected: SelectedPlaybook = {
        ruleId: rule.id,
        scenario: rule.scenario,
        anchorSkill: rule.anchorSkill,
        orderedSkills: rule.orderedSkills,
        insertedSkills,
        support: rule.support,
        precision: rule.precision,
        lift: rule.liftVsAnchorBaseline,
      };

      return {
        selected,
        banner: formatPlaybookBanner(selected),
        rejected,
      };
    }
  }

  return { selected: null, banner: null, rejected };
}
