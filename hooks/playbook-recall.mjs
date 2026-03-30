// hooks/src/playbook-recall.mts
import {
  loadPlaybookRulebook
} from "./learned-playbook-rulebook.mjs";
import {
  scenarioKeyCandidates
} from "./routing-policy.mjs";
function rankRule(rule, candidateSkills) {
  const anchorIdx = candidateSkills.indexOf(rule.anchorSkill);
  return [
    anchorIdx === -1 ? Number.MAX_SAFE_INTEGER : anchorIdx,
    -rule.support,
    -rule.liftVsAnchorBaseline,
    -rule.precision,
    rule.id
  ];
}
function formatPlaybookBanner(selected) {
  return [
    "<!-- verified-playbook -->",
    "**[Verified Playbook]**",
    `Anchor: \`${selected.anchorSkill}\``,
    `Sequence: ${selected.orderedSkills.map((s) => `\`${s}\``).join(" \u2192 ")}`,
    `Evidence: support=${selected.support}, precision=${selected.precision}, lift=${selected.lift}`,
    "Use the sequence before inventing a new debugging workflow.",
    "<!-- /verified-playbook -->"
  ].join("\n");
}
function recallVerifiedPlaybook(params) {
  const loaded = loadPlaybookRulebook(params.projectRoot);
  if (!loaded.ok) {
    return { selected: null, banner: null, rejected: [] };
  }
  const exclude = new Set(params.excludeSkills ?? []);
  const maxInsertedSkills = Math.max(0, params.maxInsertedSkills ?? 2);
  const rejected = [];
  for (const scenario of scenarioKeyCandidates(params.scenario)) {
    const eligible = loaded.rulebook.rules.filter(
      (rule) => rule.confidence === "promote" && rule.scenario === scenario && params.candidateSkills.includes(rule.anchorSkill)
    ).sort((a, b) => {
      const ra = rankRule(a, params.candidateSkills);
      const rb = rankRule(b, params.candidateSkills);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || ra[3] - rb[3] || ra[4].localeCompare(rb[4]);
    });
    for (const rule of eligible) {
      const anchorPos = rule.orderedSkills.indexOf(rule.anchorSkill);
      const tail = anchorPos === -1 ? rule.orderedSkills.slice(1) : rule.orderedSkills.slice(anchorPos + 1);
      const insertedSkills = tail.filter((skill) => !exclude.has(skill)).slice(0, maxInsertedSkills);
      if (insertedSkills.length === 0) {
        rejected.push({
          ruleId: rule.id,
          reason: "all_playbook_steps_already_present_or_no_budget"
        });
        continue;
      }
      const selected = {
        ruleId: rule.id,
        scenario: rule.scenario,
        anchorSkill: rule.anchorSkill,
        orderedSkills: rule.orderedSkills,
        insertedSkills,
        support: rule.support,
        precision: rule.precision,
        lift: rule.liftVsAnchorBaseline
      };
      return {
        selected,
        banner: formatPlaybookBanner(selected),
        rejected
      };
    }
  }
  return { selected: null, banner: null, rejected };
}
export {
  recallVerifiedPlaybook
};
