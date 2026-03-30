#!/usr/bin/env node
/**
 * SubagentStart hook: injects project context into spawned subagents.
 *
 * Input: JSON on stdin with { session_id, cwd, agent_id, agent_type, hook_event_name }
 * Output: JSON on stdout with { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "..." } } or {}
 *
 * Reads the cached profiler results from disk (profile.json) rather than
 * re-running the profiler, falling back to env var when cache is unavailable.
 *
 * Agent type budgets:
 *   Explore            — minimal  (~1KB): project profile + top skill names only
 *   Plan               — light    (~3KB): profile + top skill summaries + deployment constraints
 *   general-purpose    — standard (~8KB): profile + top skills with full bodies
 *   other / custom     — standard (~8KB): treat as general-purpose
 */

import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginRoot as resolvePluginRoot, profileCachePath, safeReadFile, safeReadJson, tryClaimSessionKey } from "./hook-env.mjs";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";
import { compilePromptSignals, matchPromptWithReason, normalizePromptText } from "./prompt-patterns.mjs";
import { loadSkills } from "./pretooluse-skill-inject.mjs";
import { extractFrontmatter } from "./skill-map-frontmatter.mjs";
import { claimPendingLaunch } from "./subagent-state.mjs";
import {
  computePlan,
  loadCachedPlanResult,
  selectActiveStory,
  type VerificationPlanResult,
} from "./verification-plan.mjs";
import {
  buildVerificationDirective,
  buildVerificationEnv,
  type VerificationDirective,
} from "./verification-directive.mjs";

const PLUGIN_ROOT = resolvePluginRoot();

/** Budget caps per agent type category (bytes). */
export const MINIMAL_BUDGET_BYTES = 1_024;
export const LIGHT_BUDGET_BYTES = 3_072;
export const STANDARD_BUDGET_BYTES = 8_000;

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface SubagentStartInput {
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  hook_event_name?: string;
}

function parseInput(): SubagentStartInput | null {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as SubagentStartInput;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Profile cache
// ---------------------------------------------------------------------------

interface ProfileCache {
  projectRoot: string;
  likelySkills: string[];
  greenfield: boolean;
  bootstrapHints: string[];
  resourceHints: string[];
  setupMode: boolean;
  agentBrowserAvailable: boolean;
  timestamp: string;
}

/**
 * Read likely skills from the cached profile on disk, falling back to the
 * VERCEL_PLUGIN_LIKELY_SKILLS env var if the cache is unavailable.
 */
function getLikelySkills(sessionId: string | undefined): string[] {
  // Try disk cache first
  if (sessionId) {
    const cache = safeReadJson<ProfileCache>(profileCachePath(sessionId));
    if (cache && Array.isArray(cache.likelySkills) && cache.likelySkills.length > 0) {
      log.debug("subagent-start-bootstrap:profile-cache-hit", { sessionId, skills: cache.likelySkills });
      return cache.likelySkills;
    }
    log.debug("subagent-start-bootstrap:profile-cache-miss", { sessionId });
  }

  // Fallback to env var
  const raw = process.env.VERCEL_PLUGIN_LIKELY_SKILLS;
  if (!raw || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Budget category resolution
// ---------------------------------------------------------------------------

type BudgetCategory = "minimal" | "light" | "standard";

function resolveBudgetCategory(agentType: string): BudgetCategory {
  if (agentType === "Explore") return "minimal";
  if (agentType === "Plan") return "light";
  return "standard";
}

function budgetBytesForCategory(category: BudgetCategory): number {
  switch (category) {
    case "minimal": return MINIMAL_BUDGET_BYTES;
    case "light": return LIGHT_BUDGET_BYTES;
    case "standard": return STANDARD_BUDGET_BYTES;
  }
}

interface PromptMatchedSkill {
  skill: string;
  score: number;
  priority: number;
}

function getPromptMatchedSkills(promptText: string): PromptMatchedSkill[] {
  const normalizedPrompt = normalizePromptText(promptText);
  if (!normalizedPrompt) return [];

  try {
    const loaded = loadSkills(PLUGIN_ROOT, log);
    if (!loaded) return [];

    const matches: PromptMatchedSkill[] = [];
    for (const [skill, config] of Object.entries(loaded.skillMap)) {
      if (!config.promptSignals) continue;

      const compiled = compilePromptSignals(config.promptSignals);
      const result = matchPromptWithReason(normalizedPrompt, compiled);
      if (!result.matched) continue;

      matches.push({
        skill,
        score: result.score,
        priority: config.priority,
      });
    }

    matches.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.skill.localeCompare(right.skill);
    });

    log.debug("subagent-start-bootstrap:prompt-skill-match", {
      promptLength: promptText.length,
      matchedSkills: matches.map(({ skill, score }) => ({ skill, score })),
    });
    return matches;
  } catch (error) {
    logCaughtError(log, "subagent-start-bootstrap:prompt-skill-match-failed", error, {
      promptLength: promptText.length,
    });
    return [];
  }
}

function mergeLikelySkills(likelySkills: string[], promptMatchedSkills: PromptMatchedSkill[]): string[] {
  if (promptMatchedSkills.length === 0) return likelySkills;
  const promptSkillNames = promptMatchedSkills.map((entry) => entry.skill);
  return [...new Set([...promptSkillNames, ...likelySkills])];
}

function resolveLikelySkillsFromPendingLaunch(
  sessionId: string | undefined,
  agentType: string,
  likelySkills: string[],
): string[] {
  if (!sessionId) return likelySkills;

  try {
    const pendingLaunch = claimPendingLaunch(sessionId, agentType);
    if (!pendingLaunch) {
      log.debug("subagent-start-bootstrap:pending-launch", {
        sessionId,
        agentType,
        claimedLaunch: false,
        likelySkills,
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
      likelySkills: effectiveLikelySkills,
    });

    return effectiveLikelySkills;
  } catch (error) {
    logCaughtError(log, "subagent-start-bootstrap:pending-launch-route-failed", error, {
      sessionId,
      agentType,
      likelySkills,
    });
    return likelySkills;
  }
}

// ---------------------------------------------------------------------------
// Verification plan resolution (cached → fresh fallback)
// ---------------------------------------------------------------------------

/**
 * Resolve the verification plan for a session, trying the cached state first
 * and falling back to a fresh computation from the ledger when the cache is
 * missing or empty but ledger data exists.
 */
function resolveVerificationPlan(
  sessionId: string | undefined,
): VerificationPlanResult | null {
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
      sessionId,
    });
  }

  try {
    const fresh = computePlan(sessionId, {
      agentBrowserAvailable: process.env.VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE !== "0",
      lastAttemptedAction: process.env.VERCEL_PLUGIN_VERIFICATION_ACTION || null,
    });
    if (fresh.hasStories) {
      log.debug("subagent-start-bootstrap:verification-plan-fresh", { sessionId });
      return fresh;
    }
    log.debug("subagent-start-bootstrap:verification-plan-empty", { sessionId });
  } catch (error) {
    logCaughtError(log, "subagent-start-bootstrap:verification-plan-fresh-failed", error, {
      sessionId,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Verification context scoping
// ---------------------------------------------------------------------------

/**
 * Format a scoped verification context snippet from a resolved plan.
 * Uses deterministic story selection via selectPrimaryStory.
 *
 * - minimal: story kind + route only
 * - light: story + missing boundaries + candidate actions
 * - standard: story + full primary action + evidence summary
 */
function buildVerificationContextFromPlan(
  plan: VerificationPlanResult,
  category: BudgetCategory,
): string | null {
  if (!plan.hasStories || plan.stories.length === 0) return null;

  const story = selectActiveStory(plan);
  if (!story) return null;

  const routePart = story.route ? ` (${story.route})` : "";

  switch (category) {
    case "minimal": {
      return [
        `<!-- verification-context scope="minimal" -->`,
        `Verification story: ${story.kind}${routePart}`,
        `<!-- /verification-context -->`,
      ].join("\n");
    }
    case "light": {
      const lines: string[] = [
        `<!-- verification-context scope="light" -->`,
        `Verification story: ${story.kind}${routePart} — "${story.promptExcerpt}"`,
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
      const lines: string[] = [
        `<!-- verification-context scope="standard" -->`,
        `Verification story: ${story.kind}${routePart} — "${story.promptExcerpt}"`,
        `Evidence: ${plan.satisfiedBoundaries.length}/4 boundaries [${plan.satisfiedBoundaries.join(", ") || "none"}]`,
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

/**
 * Load verification plan for the session and format a scoped snippet
 * appropriate for the agent type's budget category.
 *
 * Uses resolveVerificationPlan for cached→fresh fallback, and
 * selectPrimaryStory for deterministic story selection.
 *
 * Returns null if no verification plan exists or no stories are active.
 */
function buildVerificationContext(
  sessionId: string | undefined,
  category: BudgetCategory,
): string | null {
  const plan = resolveVerificationPlan(sessionId);
  return plan ? buildVerificationContextFromPlan(plan, category) : null;
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

function profileLine(agentType: string, likelySkills: string[]): string {
  return "Vercel plugin active. Project likely uses: " + (likelySkills.length > 0 ? likelySkills.join(", ") : "unknown stack") + ".";
}

/**
 * Build minimal context (~1KB): project profile + skill name list.
 * Used for Explore agents that only need orientation.
 */
function buildMinimalContext(agentType: string, likelySkills: string[], sessionId?: string): string {
  const parts: string[] = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="minimal" -->`);
  parts.push(profileLine(agentType, likelySkills));

  // Append verification context if present (minimal: story + route)
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

/**
 * Build light context (~3KB): profile + skill summaries + deployment constraints.
 * Used for Plan agents that need enough context to architect solutions.
 */
function buildLightContext(agentType: string, likelySkills: string[], budgetBytes: number, sessionId?: string): string {
  const parts: string[] = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="light" -->`);
  parts.push(profileLine(agentType, likelySkills));

  let usedBytes = Buffer.byteLength(parts.join("\n"), "utf8");

  // Add skill summaries
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

  // Add deployment constraints if budget allows
  const constraints = [
    "Deployment targets Vercel. Use framework conventions (e.g. Next.js app router, API routes).",
    "Environment variables are managed via `vercel env`. Do not hardcode secrets.",
  ];
  for (const constraint of constraints) {
    const lineBytes = Buffer.byteLength(constraint, "utf8");
    if (usedBytes + lineBytes + 1 > budgetBytes) break;
    parts.push(constraint);
    usedBytes += lineBytes + 1;
  }

  // Append verification context if present (light: story + missing boundaries + candidates)
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

/**
 * Build standard context (~8KB): profile + top skill full bodies.
 * Used for general-purpose agents that need actionable skill content.
 */
function buildStandardContext(agentType: string, likelySkills: string[], budgetBytes: number, sessionId?: string): string {
  const parts: string[] = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" budget="standard" -->`);
  parts.push(profileLine(agentType, likelySkills));

  let usedBytes = Buffer.byteLength(parts.join("\n"), "utf8");

  // Load skill map once for summary fallbacks
  const loaded = loadSkills(PLUGIN_ROOT, log);

  // Inject full skill bodies for likely skills, falling back to summaries
  for (const skill of likelySkills) {
    const skillPath = join(PLUGIN_ROOT, "skills", skill, "SKILL.md");
    const raw = safeReadFile(skillPath);
    if (raw !== null) {
      const { body } = extractFrontmatter(raw);
      const content = body.trimStart();
      const wrapped = `<!-- skill:${skill} -->\n${content}\n<!-- /skill:${skill} -->`;
      const byteLen = Buffer.byteLength(wrapped, "utf8");

      if (usedBytes + byteLen + 1 <= budgetBytes) {
        parts.push(wrapped);
        usedBytes += byteLen + 1;
        continue;
      }
    }

    // Fallback to summary if full body doesn't fit or file is missing
    const summary = loaded?.skillMap[skill]?.summary;
    if (summary) {
      const line = `<!-- skill:${skill} mode:summary -->\n${summary}\n<!-- /skill:${skill} -->`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (usedBytes + lineBytes + 1 <= budgetBytes) {
        parts.push(line);
        usedBytes += lineBytes + 1;
      }
    }
  }

  // Append verification context if present (standard: full evidence + primary action)
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
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
    profilerLikelySkills,
  );

  const category = resolveBudgetCategory(agentType);
  const maxBytes = budgetBytesForCategory(category);

  let context: string;
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

  // Hard-truncate if over budget (safety net)
  if (Buffer.byteLength(context, "utf8") > maxBytes) {
    context = Buffer.from(context, "utf8").subarray(0, maxBytes).toString("utf8");
  }

  // Persist dedup claims so PreToolUse won't re-inject the same skills.
  // Scope claims by agentId so sibling subagents don't cross-contaminate.
  const scopeId = agentId !== "unknown" ? agentId : undefined;
  if (sessionId && likelySkills.length > 0) {
    const claimed: string[] = [];
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

  // Determine whether a pending launch was matched (profiler vs pending-launch divergence)
  const pendingLaunchMatched = likelySkills.length !== profilerLikelySkills.length
    || likelySkills.some((s) => !profilerLikelySkills.includes(s));

  // Build verification directive for downstream hooks
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
    verification_env_keys: Object.keys(verificationEnv),
  });

  const output: SyncHookJSONOutput & { env?: Record<string, string> } = {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context,
    },
    ...(Object.keys(verificationEnv).length > 0 ? { env: verificationEnv } : {}),
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

const ENTRYPOINT = fileURLToPath(import.meta.url);
const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === ENTRYPOINT
  : false;

if (isEntrypoint) {
  main();
}

// Exports for testing
export {
  parseInput,
  buildMinimalContext,
  buildLightContext,
  buildStandardContext,
  buildVerificationContext,
  buildVerificationContextFromPlan,
  buildVerificationDirective,
  buildVerificationEnv,
  resolveVerificationPlan,
  getLikelySkills,
  resolveBudgetCategory,
  main,
};
export type { VerificationDirective } from "./verification-directive.mjs";
export type { SubagentStartInput, ProfileCache, BudgetCategory };
