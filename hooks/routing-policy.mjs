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
  const scenario = scenarioKey(input);
  const stats = ensureScenario(policy, scenario, input.skill, now);
  stats.exposures += 1;
  stats.lastUpdatedAt = now;
  return policy;
}
function recordOutcome(policy, input) {
  const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const scenario = scenarioKey(input);
  const stats = ensureScenario(policy, scenario, input.skill, now);
  if (input.outcome === "win") {
    stats.wins += 1;
  } else if (input.outcome === "directive-win") {
    stats.wins += 1;
    stats.directiveWins += 1;
  } else {
    stats.staleMisses += 1;
  }
  stats.lastUpdatedAt = now;
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
  const scenario = scenarioKey(scenarioInput);
  const bucket = policy.scenarios[scenario] ?? {};
  return entries.map((entry) => {
    const stats = bucket[entry.skill];
    const boost = derivePolicyBoost(stats);
    const base = typeof entry.effectivePriority === "number" ? entry.effectivePriority : entry.priority;
    return {
      ...entry,
      effectivePriority: base + boost,
      policyBoost: boost,
      policyReason: stats ? `${scenario}: ${stats.wins} wins / ${stats.exposures} exposures, ${stats.directiveWins} directive wins, ${stats.staleMisses} stale misses` : null
    };
  });
}
export {
  applyPolicyBoosts,
  createEmptyRoutingPolicy,
  derivePolicyBoost,
  ensureScenario,
  recordExposure,
  recordOutcome,
  scenarioKey
};
