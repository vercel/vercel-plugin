// hooks/src/routing-policy.mts
function createEmptyRoutingPolicy() {
  return {
    version: 1,
    scenarios: {}
  };
}
function scenarioKey(input) {
  return [
    input.hook,
    input.storyKind ?? "none",
    input.targetBoundary ?? "none",
    input.toolName
  ].join("|");
}
function scenarioKeyWithRoute(input) {
  return [
    input.hook,
    input.storyKind ?? "none",
    input.targetBoundary ?? "none",
    input.toolName,
    input.routeScope ?? "*"
  ].join("|");
}
function scenarioKeyCandidates(input) {
  const keys = [];
  if (input.routeScope && input.routeScope !== "*") {
    keys.push(scenarioKeyWithRoute(input));
  }
  keys.push(scenarioKeyWithRoute({ ...input, routeScope: "*" }));
  keys.push(scenarioKey(input));
  return [...new Set(keys)];
}
function computePolicySuccessRate(stats) {
  const weightedWins = stats.wins + stats.directiveWins * 0.25;
  return weightedWins / Math.max(stats.exposures, 1);
}
function lookupPolicyStats(policy, input, skill) {
  for (const key of scenarioKeyCandidates(input)) {
    const stats = policy.scenarios[key]?.[skill];
    if (stats) return { scenario: key, stats };
  }
  return { scenario: null, stats: void 0 };
}
function ensureScenario(policy, scenario, skill, now) {
  if (!policy.scenarios[scenario]) policy.scenarios[scenario] = {};
  if (!policy.scenarios[scenario][skill]) {
    policy.scenarios[scenario][skill] = {
      exposures: 0,
      wins: 0,
      directiveWins: 0,
      staleMisses: 0,
      lastUpdatedAt: now
    };
  }
  return policy.scenarios[scenario][skill];
}
function recordExposure(policy, input) {
  const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
  for (const key of scenarioKeyCandidates(input)) {
    const stats = ensureScenario(policy, key, input.skill, now);
    stats.exposures += 1;
    stats.lastUpdatedAt = now;
  }
  return policy;
}
function recordOutcome(policy, input) {
  const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
  for (const key of scenarioKeyCandidates(input)) {
    const stats = ensureScenario(policy, key, input.skill, now);
    if (input.outcome === "win") {
      stats.wins += 1;
    } else if (input.outcome === "directive-win") {
      stats.wins += 1;
      stats.directiveWins += 1;
    } else {
      stats.staleMisses += 1;
    }
    stats.lastUpdatedAt = now;
  }
  return policy;
}
function derivePolicyBoost(stats) {
  if (!stats) return 0;
  if (stats.exposures < 3) return 0;
  const weightedWins = stats.wins + stats.directiveWins * 0.25;
  const successRate = weightedWins / Math.max(stats.exposures, 1);
  if (successRate >= 0.8) return 8;
  if (successRate >= 0.65) return 5;
  if (successRate >= 0.4) return 2;
  if (stats.exposures >= 5 && successRate < 0.15) return -2;
  return 0;
}
function applyPolicyBoosts(entries, policy, scenarioInput) {
  return entries.map((entry) => {
    const { scenario, stats } = lookupPolicyStats(policy, scenarioInput, entry.skill);
    const boost = derivePolicyBoost(stats);
    const base = typeof entry.effectivePriority === "number" ? entry.effectivePriority : entry.priority;
    return {
      ...entry,
      effectivePriority: base + boost,
      policyBoost: boost,
      policyReason: stats && scenario ? `${scenario}: ${stats.wins} wins / ${stats.exposures} exposures, ${stats.directiveWins} directive wins, ${stats.staleMisses} stale misses` : null
    };
  });
}
function matchRulebookRule(rulebook, scenarioInput, skill) {
  if (rulebook.rules.length === 0) return null;
  for (const key of scenarioKeyCandidates(scenarioInput)) {
    const rule = rulebook.rules.find(
      (r) => r.scenario === key && r.skill === skill
    );
    if (rule) return { rule, matchedScenario: key };
  }
  return null;
}
function applyRulebookBoosts(entries, rulebook, scenarioInput, rulebookFilePath) {
  return entries.map((entry) => {
    const match = matchRulebookRule(rulebook, scenarioInput, entry.skill);
    if (!match) {
      return {
        ...entry,
        matchedRuleId: null,
        ruleBoost: 0,
        ruleReason: null,
        rulebookPath: null
      };
    }
    const { rule } = match;
    const ruleBoost = rule.action === "promote" ? rule.boost : -rule.boost;
    const base = (typeof entry.effectivePriority === "number" ? entry.effectivePriority : entry.priority) - entry.policyBoost;
    return {
      ...entry,
      effectivePriority: base + ruleBoost,
      policyBoost: 0,
      // suppressed — rulebook takes precedence
      policyReason: null,
      matchedRuleId: rule.id,
      ruleBoost,
      ruleReason: rule.reason,
      rulebookPath: rulebookFilePath
    };
  });
}
export {
  applyPolicyBoosts,
  applyRulebookBoosts,
  computePolicySuccessRate,
  createEmptyRoutingPolicy,
  derivePolicyBoost,
  ensureScenario,
  lookupPolicyStats,
  matchRulebookRule,
  recordExposure,
  recordOutcome,
  scenarioKey,
  scenarioKeyCandidates,
  scenarioKeyWithRoute
};
