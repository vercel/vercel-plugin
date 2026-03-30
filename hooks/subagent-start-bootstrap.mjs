#!/usr/bin/env node

// hooks/src/subagent-start-bootstrap.mts
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { pluginRoot as resolvePluginRoot, profileCachePath, safeReadFile, safeReadJson, tryClaimSessionKey } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import { compilePromptSignals, matchPromptWithReason, normalizePromptText } from "./prompt-patterns.mjs";
import { loadSkills } from "./pretooluse-skill-inject.mjs";
import { extractFrontmatter } from "./skill-map-frontmatter.mjs";
import { claimPendingLaunch } from "./subagent-state.mjs";
import {
  computePlan,
  loadCachedPlanResult,
  selectActiveStory
} from "./verification-plan.mjs";
import {
  buildVerificationDirective,
  buildVerificationEnv
} from "./verification-directive.mjs";
var PLUGIN_ROOT = resolvePluginRoot();
var MINIMAL_BUDGET_BYTES = 1024;
var LIGHT_BUDGET_BYTES = 3072;
var STANDARD_BUDGET_BYTES = 8e3;
var log = createLogger();
function parseInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function getLikelySkills(sessionId) {
  if (sessionId) {
    const cache = safeReadJson(profileCachePath(sessionId));
    if (cache && Array.isArray(cache.likelySkills) && cache.likelySkills.length > 0) {
      log.debug("subagent-start-bootstrap:profile-cache-hit", { sessionId, skills: cache.likelySkills });
      return cache.likelySkills;
    }
    log.debug("subagent-start-bootstrap:profile-cache-miss", { sessionId });
  }
  const raw = process.env.VERCEL_PLUGIN_LIKELY_SKILLS;
  if (!raw || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function resolveBudgetCategory(agentType) {
  if (agentType === "Explore") return "minimal";
  if (agentType === "Plan") return "light";
  return "standard";
}
function budgetBytesForCategory(category) {
  switch (category) {
    case "minimal":
      return MINIMAL_BUDGET_BYTES;
    case "light":
      return LIGHT_BUDGET_BYTES;
    case "standard":
      return STANDARD_BUDGET_BYTES;
  }
}
function getPromptMatchedSkills(promptText) {
  const normalizedPrompt = normalizePromptText(promptText);
  if (!normalizedPrompt) return [];
  try {
    const loaded = loadSkills(PLUGIN_ROOT, log);
    if (!loaded) return [];
    const matches = [];
    for (const [skill, config] of Object.entries(loaded.skillMap)) {
      if (!config.promptSignals) continue;
      const compiled = compilePromptSignals(config.promptSignals);
      const result = matchPromptWithReason(normalizedPrompt, compiled);
      if (!result.matched) continue;
      matches.push({
        skill,
        score: result.score,
        priority: config.priority
      });
    }
    matches.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.skill.localeCompare(right.skill);
    });
    log.debug("subagent-start-bootstrap:prompt-skill-match", {
      promptLength: promptText.length,
      matchedSkills: matches.map(({ skill, score }) => ({ skill, score }))
    });
    return matches;
  } catch (error) {
    logCaughtError(log, "subagent-start-bootstrap:prompt-skill-match-failed", error, {
      promptLength: promptText.length
    });
    return [];
  }
}
function mergeLikelySkills(likelySkills, promptMatchedSkills) {
  if (promptMatchedSkills.length === 0) return likelySkills;
  const promptSkillNames = promptMatchedSkills.map((entry) => entry.skill);
  return [.../* @__PURE__ */ new Set([...promptSkillNames, ...likelySkills])];
}
function resolveLikelySkillsFromPendingLaunch(sessionId, agentType, likelySkills) {
  if (!sessionId) return likelySkills;
  try {
    const pendingLaunch = claimPendingLaunch(sessionId, agentType);
    if (!pendingLaunch) {
      log.debug("subagent-start-bootstrap:pending-launch", {
        sessionId,
        agentType,
        claimedLaunch: false,
        likelySkills
      });
      return likelySkills;
    }
    const promptText = `${pendingLaunch.description} ${pendingLaunch.prompt}`.trim();
    const promptMatchedSkills = getPromptMatchedSkills(promptText);
    const effectiveLikelySkills = mergeLikelySkills(likelySkills, promptMatchedSkills);
    log.debug("subagent-start-bootstrap:pending-launch", {
      sessionId,
      agentType,
      claimedLaunch: true,
      promptMatchedSkills: promptMatchedSkills.map(({ skill, score }) => ({ skill, score })),
      likelySkills: effectiveLikelySkills
    });
    return effectiveLikelySkills;
  } catch (error) {
    logCaughtError(log, "subagent-start-bootstrap:pending-launch-route-failed", error, {
      sessionId,
      agentType,
      likelySkills
    });
    return likelySkills;
  }
}
function resolveVerificationPlan(sessionId) {
  if (!sessionId) return null;
  try {
    const cached = loadCachedPlanResult(sessionId);
    if (cached?.hasStories) {
      log.debug("subagent-start-bootstrap:verification-plan-cached", { sessionId });
      return cached;
    }
    log.debug("subagent-start-bootstrap:verification-plan-cache-miss", { sessionId });
  } catch (error) {
    logCaughtError(log, "subagent-start-bootstrap:verification-plan-cache-failed", error, {
      sessionId
    });
  }
  try {
    const fresh = computePlan(sessionId, {
      agentBrowserAvailable: process.env.VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE !== "0",
      lastAttemptedAction: process.env.VERCEL_PLUGIN_VERIFICATION_ACTION || null
    });
    if (fresh.hasStories) {
      log.debug("subagent-start-bootstrap:verification-plan-fresh", { sessionId });
      return fresh;
    }
    log.debug("subagent-start-bootstrap:verification-plan-empty", { sessionId });
  } catch (error) {
    logCaughtError(log, "subagent-start-bootstrap:verification-plan-fresh-failed", error, {
      sessionId
    });
  }
  return null;
}
function buildVerificationContextFromPlan(plan, category) {
  if (!plan.hasStories || plan.stories.length === 0) return null;
  const story = selectActiveStory(plan);
  if (!story) return null;
  const routePart = story.route ? ` (${story.route})` : "";
  switch (category) {
    case "minimal": {
      return [
        `<!-- verification-context scope="minimal" -->`,
        `Verification story: ${story.kind}${routePart}`,
        `<!-- /verification-context -->`
      ].join("\n");
    }
    case "light": {
      const lines = [
        `<!-- verification-context scope="light" -->`,
        `Verification story: ${story.kind}${routePart} \u2014 "${story.promptExcerpt}"`
      ];
      if (plan.missingBoundaries.length > 0) {
        lines.push(`Missing boundaries: ${plan.missingBoundaries.join(", ")}`);
      }
      if (plan.primaryNextAction) {
        lines.push(`Candidate action: ${plan.primaryNextAction.action}`);
      }
      if (plan.blockedReasons.length > 0) {
        lines.push(`Blocked: ${plan.blockedReasons[0]}`);
      }
      lines.push(`<!-- /verification-context -->`);
      return lines.join("\n");
    }
    case "standard": {
      const lines = [
        `<!-- verification-context scope="standard" -->`,
        `Verification story: ${story.kind}${routePart} \u2014 "${story.promptExcerpt}"`,
        `Evidence: ${plan.satisfiedBoundaries.length}/4 boundaries [${plan.satisfiedBoundaries.join(", ") || "none"}]`
      ];
      if (plan.missingBoundaries.length > 0) {
        lines.push(`Missing: ${plan.missingBoundaries.join(", ")}`);
      }
      if (plan.primaryNextAction) {
        lines.push(`Primary action: \`${plan.primaryNextAction.action}\``);
        lines.push(`Reason: ${plan.primaryNextAction.reason}`);
      }
      if (plan.blockedReasons.length > 0) {
        for (const reason of plan.blockedReasons) {
          lines.push(`Blocked: ${reason}`);
        }
      }
      if (plan.recentRoutes.length > 0) {
        lines.push(`Recent routes: ${plan.recentRoutes.join(", ")}`);
      }
      lines.push(`<!-- /verification-context -->`);
      return lines.join("\n");
    }
  }
}
function buildVerificationContext(sessionId, category) {
  const plan = resolveVerificationPlan(sessionId);
  return plan ? buildVerificationContextFromPlan(plan, category) : null;
}
function profileLine(agentType, likelySkills) {
  return "Vercel plugin active. Project likely uses: " + (likelySkills.length > 0 ? likelySkills.join(", ") : "unknown stack") + ".";
}
function buildMinimalContext(agentType, likelySkills, sessionId) {
  const parts = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="minimal" -->`);
  parts.push(profileLine(agentType, likelySkills));
  const verificationCtx = buildVerificationContext(sessionId, "minimal");
  if (verificationCtx) {
    const verBytes = Buffer.byteLength(verificationCtx, "utf8");
    const currentBytes = Buffer.byteLength(parts.join("\n"), "utf8");
    if (currentBytes + verBytes + 50 <= MINIMAL_BUDGET_BYTES) {
      parts.push(verificationCtx);
    }
  }
  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return parts.join("\n");
}
function buildLightContext(agentType, likelySkills, budgetBytes, sessionId) {
  const parts = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="light" -->`);
  parts.push(profileLine(agentType, likelySkills));
  let usedBytes = Buffer.byteLength(parts.join("\n"), "utf8");
  const loaded = loadSkills(PLUGIN_ROOT, log);
  if (loaded) {
    for (const skill of likelySkills) {
      const config = loaded.skillMap[skill];
      if (!config) continue;
      const summary = config.summary;
      if (!summary) continue;
      const line = `- **${skill}**: ${summary}`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (usedBytes + lineBytes + 1 > budgetBytes) break;
      parts.push(line);
      usedBytes += lineBytes + 1;
    }
  }
  const constraints = [
    "Deployment targets Vercel. Use framework conventions (e.g. Next.js app router, API routes).",
    "Environment variables are managed via `vercel env`. Do not hardcode secrets."
  ];
  for (const constraint of constraints) {
    const lineBytes = Buffer.byteLength(constraint, "utf8");
    if (usedBytes + lineBytes + 1 > budgetBytes) break;
    parts.push(constraint);
    usedBytes += lineBytes + 1;
  }
  const verificationCtx = buildVerificationContext(sessionId, "light");
  if (verificationCtx) {
    const verBytes = Buffer.byteLength(verificationCtx, "utf8");
    if (usedBytes + verBytes + 1 <= budgetBytes) {
      parts.push(verificationCtx);
      usedBytes += verBytes + 1;
    }
  }
  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return parts.join("\n");
}
function buildStandardContext(agentType, likelySkills, budgetBytes, sessionId) {
  const parts = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="standard" -->`);
  parts.push(profileLine(agentType, likelySkills));
  let usedBytes = Buffer.byteLength(parts.join("\n"), "utf8");
  const loaded = loadSkills(PLUGIN_ROOT, log);
  for (const skill of likelySkills) {
    const skillPath = join(PLUGIN_ROOT, "skills", skill, "SKILL.md");
    const raw = safeReadFile(skillPath);
    if (raw !== null) {
      const { body } = extractFrontmatter(raw);
      const content = body.trimStart();
      const wrapped = `<!-- skill:${skill} -->
${content}
<!-- /skill:${skill} -->`;
      const byteLen = Buffer.byteLength(wrapped, "utf8");
      if (usedBytes + byteLen + 1 <= budgetBytes) {
        parts.push(wrapped);
        usedBytes += byteLen + 1;
        continue;
      }
    }
    const summary = loaded?.skillMap[skill]?.summary;
    if (summary) {
      const line = `<!-- skill:${skill} mode:summary -->
${summary}
<!-- /skill:${skill} -->`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (usedBytes + lineBytes + 1 <= budgetBytes) {
        parts.push(line);
        usedBytes += lineBytes + 1;
      }
    }
  }
  const verificationCtx = buildVerificationContext(sessionId, "standard");
  if (verificationCtx) {
    const verBytes = Buffer.byteLength(verificationCtx, "utf8");
    if (usedBytes + verBytes + 1 <= budgetBytes) {
      parts.push(verificationCtx);
      usedBytes += verBytes + 1;
    }
  }
  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return parts.join("\n");
}
function main() {
  const input = parseInput();
  if (!input) {
    process.exit(0);
  }
  const agentId = input.agent_id ?? "unknown";
  const agentType = input.agent_type ?? "unknown";
  const sessionId = input.session_id;
  log.debug("subagent-start-bootstrap", { agentId, agentType, sessionId });
  const profilerLikelySkills = getLikelySkills(sessionId);
  const likelySkills = resolveLikelySkillsFromPendingLaunch(
    sessionId,
    agentType,
    profilerLikelySkills
  );
  const category = resolveBudgetCategory(agentType);
  const maxBytes = budgetBytesForCategory(category);
  let context;
  switch (category) {
    case "minimal":
      context = buildMinimalContext(agentType, likelySkills, sessionId);
      break;
    case "light":
      context = buildLightContext(agentType, likelySkills, maxBytes, sessionId);
      break;
    case "standard":
      context = buildStandardContext(agentType, likelySkills, maxBytes, sessionId);
      break;
  }
  if (Buffer.byteLength(context, "utf8") > maxBytes) {
    context = Buffer.from(context, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  const scopeId = agentId !== "unknown" ? agentId : void 0;
  if (sessionId && likelySkills.length > 0) {
    const claimed = [];
    for (const skill of likelySkills) {
      if (tryClaimSessionKey(sessionId, "seen-skills", skill, scopeId)) {
        claimed.push(skill);
      }
    }
    if (claimed.length > 0) {
      log.debug("subagent-start-bootstrap:dedup-claims", { sessionId, agentId, scopeId, claimed });
    }
  }
  const budgetUsed = Buffer.byteLength(context, "utf8");
  const pendingLaunchMatched = likelySkills.length !== profilerLikelySkills.length || likelySkills.some((s) => !profilerLikelySkills.includes(s));
  const verificationPlan = resolveVerificationPlan(sessionId);
  const verificationDirective = buildVerificationDirective(verificationPlan);
  const verificationEnv = buildVerificationEnv(verificationDirective);
  log.summary("subagent-start-bootstrap:complete", {
    agent_id: agentId,
    agent_type: agentType,
    claimed_skills: likelySkills.length,
    budget_used: budgetUsed,
    budget_max: maxBytes,
    budget_category: category,
    pending_launch_matched: pendingLaunchMatched,
    verification_directive: verificationDirective !== null,
    verification_env_keys: Object.keys(verificationEnv)
  });
  const output = {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context
    },
    ...Object.keys(verificationEnv).length > 0 ? { env: verificationEnv } : {}
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
var ENTRYPOINT = fileURLToPath(import.meta.url);
var isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === ENTRYPOINT : false;
if (isEntrypoint) {
  main();
}
export {
  LIGHT_BUDGET_BYTES,
  MINIMAL_BUDGET_BYTES,
  STANDARD_BUDGET_BYTES,
  buildLightContext,
  buildMinimalContext,
  buildStandardContext,
  buildVerificationContext,
  buildVerificationContextFromPlan,
  buildVerificationDirective,
  buildVerificationEnv,
  getLikelySkills,
  main,
  parseInput,
  resolveBudgetCategory,
  resolveVerificationPlan
};
