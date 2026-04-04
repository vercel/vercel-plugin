#!/usr/bin/env node

// hooks/src/subagent-start-bootstrap.mts
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { pluginRoot as resolvePluginRoot, profileCachePath, safeReadJson, tryClaimSessionKey } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import { compilePromptSignals, matchPromptWithReason, normalizePromptText } from "./prompt-patterns.mjs";
import { loadSkills } from "./pretooluse-skill-inject.mjs";
import { createSkillStore } from "./skill-store.mjs";
import { claimPendingLaunch } from "./subagent-state.mjs";
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
function resolveBootstrapProjectRoot(sessionId) {
  if (sessionId) {
    const cache = safeReadJson(profileCachePath(sessionId));
    if (cache?.projectRoot && cache.projectRoot.trim() !== "") {
      return cache.projectRoot;
    }
  }
  return process.env.CLAUDE_PROJECT_ROOT ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();
}
function getPromptMatchedSkills(promptText, projectRoot) {
  const normalizedPrompt = normalizePromptText(promptText);
  if (!normalizedPrompt) return [];
  try {
    const loaded = loadSkills(PLUGIN_ROOT, log, projectRoot);
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
function resolveLikelySkillsFromPendingLaunch(sessionId, agentType, likelySkills, projectRoot) {
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
    const promptMatchedSkills = getPromptMatchedSkills(promptText, projectRoot);
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
function profileLine(agentType, likelySkills) {
  return "Vercel plugin active. Project likely uses: " + (likelySkills.length > 0 ? likelySkills.join(", ") : "unknown stack") + ".";
}
function buildMinimalContext(agentType, likelySkills) {
  const parts = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="minimal" -->`);
  parts.push(profileLine(agentType, likelySkills));
  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return { context: parts.join("\n"), includedSkills: [] };
}
function buildLightContext(agentType, likelySkills, budgetBytes, sessionId) {
  const projectRoot = resolveBootstrapProjectRoot(sessionId);
  const parts = [];
  const includedSkills = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="light" -->`);
  parts.push(profileLine(agentType, likelySkills));
  let usedBytes = Buffer.byteLength(parts.join("\n"), "utf8");
  const loaded = loadSkills(PLUGIN_ROOT, log, projectRoot);
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
      includedSkills.push(skill);
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
  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return { context: parts.join("\n"), includedSkills };
}
function buildStandardContext(agentType, likelySkills, budgetBytes, sessionId) {
  const projectRoot = resolveBootstrapProjectRoot(sessionId);
  const parts = [];
  const includedSkills = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="standard" -->`);
  parts.push(profileLine(agentType, likelySkills));
  let usedBytes = Buffer.byteLength(parts.join("\n"), "utf8");
  const loaded = loadSkills(PLUGIN_ROOT, log, projectRoot);
  const store = createSkillStore({
    projectRoot,
    pluginRoot: PLUGIN_ROOT,
    includeRulesManifest: process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1"
  });
  for (const skill of likelySkills) {
    const resolved = store.resolveSkillPayload(skill, log);
    if (resolved?.mode === "body" && resolved.body) {
      const content = resolved.body;
      const wrapped = `<!-- skill:${skill} -->
${content}
<!-- /skill:${skill} -->`;
      const byteLen = Buffer.byteLength(wrapped, "utf8");
      if (usedBytes + byteLen + 1 <= budgetBytes) {
        parts.push(wrapped);
        includedSkills.push(skill);
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
        includedSkills.push(skill);
        usedBytes += lineBytes + 1;
      }
    }
  }
  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return { context: parts.join("\n"), includedSkills };
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
  const projectRoot = resolveBootstrapProjectRoot(sessionId);
  const profilerLikelySkills = getLikelySkills(sessionId);
  const likelySkills = resolveLikelySkillsFromPendingLaunch(
    sessionId,
    agentType,
    profilerLikelySkills,
    projectRoot
  );
  const category = resolveBudgetCategory(agentType);
  const maxBytes = budgetBytesForCategory(category);
  let built;
  switch (category) {
    case "minimal":
      built = buildMinimalContext(agentType, likelySkills);
      break;
    case "light":
      built = buildLightContext(agentType, likelySkills, maxBytes, sessionId);
      break;
    case "standard":
      built = buildStandardContext(agentType, likelySkills, maxBytes, sessionId);
      break;
  }
  let context = built.context;
  const includedSkills = built.includedSkills;
  if (Buffer.byteLength(context, "utf8") > maxBytes) {
    log.debug("subagent-start-bootstrap:context-truncated", {
      agentId,
      agentType,
      budgetMax: maxBytes,
      budgetActual: Buffer.byteLength(context, "utf8")
    });
    context = Buffer.from(context, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  log.debug("subagent-start-bootstrap:included-skills", {
    agentId,
    agentType,
    budgetCategory: category,
    likelySkills,
    includedSkills
  });
  const scopeId = agentId !== "unknown" ? agentId : void 0;
  if (sessionId && includedSkills.length > 0) {
    const claimed = [];
    for (const skill of includedSkills) {
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
  log.summary("subagent-start-bootstrap:complete", {
    agent_id: agentId,
    agent_type: agentType,
    claimed_skills: includedSkills.length,
    included_skills: includedSkills,
    likely_skills: likelySkills,
    budget_used: budgetUsed,
    budget_max: maxBytes,
    budget_category: category,
    pending_launch_matched: pendingLaunchMatched
  });
  const output = {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context
    }
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
  getLikelySkills,
  main,
  parseInput,
  resolveBootstrapProjectRoot
};
