import assert from "node:assert/strict";
import {
  applyVerifiedPlaybookInsertion,
  buildPlaybookExposureRoles,
} from "../hooks/pretooluse-skill-inject.mjs";

const banner =
  "**[Verified Playbook]** verification → agent-browser-verify → investigation-mode";

// Case 1: applies new playbook steps
const applied = applyVerifiedPlaybookInsertion({
  rankedSkills: ["verification", "env-vars"],
  matched: new Set(["verification", "env-vars"]),
  injectedSkills: new Set(),
  dedupOff: false,
  forceSummarySkills: new Set(),
  selection: {
    anchorSkill: "verification",
    insertedSkills: ["agent-browser-verify", "investigation-mode"],
    banner,
  },
});

assert.equal(applied.applied, true);
assert.deepEqual(applied.rankedSkills, [
  "verification",
  "agent-browser-verify",
  "investigation-mode",
  "env-vars",
]);
assert.deepEqual(applied.appliedOrderedSkills, [
  "verification",
  "agent-browser-verify",
  "investigation-mode",
]);
assert.deepEqual(applied.appliedInsertedSkills, [
  "agent-browser-verify",
  "investigation-mode",
]);
assert.equal(applied.banner, banner);

// Case 2: suppresses banner on noop (all inserted skills already present)
const noop = applyVerifiedPlaybookInsertion({
  rankedSkills: ["verification", "agent-browser-verify", "investigation-mode"],
  matched: new Set([
    "verification",
    "agent-browser-verify",
    "investigation-mode",
  ]),
  injectedSkills: new Set(),
  dedupOff: false,
  forceSummarySkills: new Set(),
  selection: {
    anchorSkill: "verification",
    insertedSkills: ["agent-browser-verify", "investigation-mode"],
    banner,
  },
});

assert.equal(noop.applied, false);
assert.deepEqual(noop.appliedOrderedSkills, []);
assert.deepEqual(noop.appliedInsertedSkills, []);
assert.equal(noop.banner, null);

// Case 3: builds candidate + context exposure roles
const roles = buildPlaybookExposureRoles([
  "verification",
  "agent-browser-verify",
  "investigation-mode",
]);

assert.deepEqual(roles, [
  {
    skill: "verification",
    attributionRole: "candidate",
    candidateSkill: "verification",
  },
  {
    skill: "agent-browser-verify",
    attributionRole: "context",
    candidateSkill: "verification",
  },
  {
    skill: "investigation-mode",
    attributionRole: "context",
    candidateSkill: "verification",
  },
]);

// Case 4: anchor missing returns applied: false
const noAnchor = applyVerifiedPlaybookInsertion({
  rankedSkills: ["env-vars"],
  matched: new Set(["env-vars"]),
  injectedSkills: new Set(),
  dedupOff: false,
  forceSummarySkills: new Set(),
  selection: {
    anchorSkill: "verification",
    insertedSkills: ["agent-browser-verify"],
    banner,
  },
});

assert.equal(noAnchor.applied, false);
assert.deepEqual(noAnchor.appliedOrderedSkills, []);
assert.deepEqual(noAnchor.appliedInsertedSkills, []);
assert.equal(noAnchor.banner, null);

// Case 5: null selection returns applied: false
const nullSelection = applyVerifiedPlaybookInsertion({
  rankedSkills: ["verification"],
  matched: new Set(["verification"]),
  injectedSkills: new Set(),
  dedupOff: false,
  forceSummarySkills: new Set(),
  selection: null,
});

assert.equal(nullSelection.applied, false);
assert.deepEqual(nullSelection.appliedOrderedSkills, []);
assert.deepEqual(nullSelection.appliedInsertedSkills, []);
assert.equal(nullSelection.banner, null);

console.log(
  JSON.stringify(
    {
      ok: true,
      cases: [
        "applies-new-playbook-steps",
        "suppresses-banner-on-noop",
        "builds-candidate-context-exposure-roles",
        "anchor-missing-returns-noop",
        "null-selection-returns-noop",
      ],
    },
    null,
    2,
  ),
);
