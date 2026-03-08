#!/usr/bin/env node
/**
 * UserPromptSubmit hook: injects relevant SKILL.md content as additionalContext
 * when the user's prompt matches skill promptSignals.
 *
 * Input: JSON on stdin with { prompt, session_id, cwd, hook_event_name }
 * Output: JSON on stdout with { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "..." } } or {}
 *
 * Scoring (from prompt-patterns.mts):
 *   - phrases:  +6 per hit (exact substring, case-insensitive)
 *   - allOf:    +4 per conjunction group where ALL terms match
 *   - anyOf:    +1 per term hit, capped at +2
 *   - noneOf:   hard suppress (score → -Infinity)
 *   Threshold: score >= minScore (default 6) with at least one phrase hit.
 *
 * Max 2 skills injected per prompt, 8KB total budget.
 * Deduplicates via VERCEL_PLUGIN_SEEN_SKILLS env var.
 */

import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAuditLog,
  listSessionKeys,
  pluginRoot as resolvePluginRoot,
  readSessionFile,
  safeReadFile,
  syncSessionFileFromClaims,
  tryClaimSessionKey,
  writeSessionFile,
} from "./hook-env.mjs";
import { loadSkills, injectSkills } from "./pretooluse-skill-inject.mjs";
import type { LoadedSkills } from "./pretooluse-skill-inject.mjs";
import { parseSeenSkills, appendSeenSkill, mergeSeenSkillStates, rankEntries } from "./patterns.mjs";
import type { CompiledSkillEntry } from "./patterns.mjs";
import { normalizePromptText, compilePromptSignals, matchPromptWithReason } from "./prompt-patterns.mjs";
import type { CompiledPromptSignals } from "./prompt-patterns.mjs";
import { analyzePrompt } from "./prompt-analysis.mjs";
import type { PromptAnalysisReport } from "./prompt-analysis.mjs";
import { createLogger } from "./logger.mjs";
import type { Logger } from "./logger.mjs";

const MAX_SKILLS = 2;
const DEFAULT_INJECTION_BUDGET_BYTES = 8_000;
const MIN_PROMPT_LENGTH = 10;
const PLUGIN_ROOT = resolvePluginRoot();
const SKILL_INJECTION_VERSION = 1;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @returns comma-delimited seen skills from env, or "" */
function getSeenSkillsEnv(): string {
  return typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string"
    ? process.env.VERCEL_PLUGIN_SEEN_SKILLS
    : "";
}

/** Resolve the injection byte budget from env or default. */
function getInjectionBudget(): number {
  const envVal = process.env.VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET;
  if (envVal != null && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INJECTION_BUDGET_BYTES;
}

export interface PromptSeenSkillState {
  dedupOff: boolean;
  hasFileDedup: boolean;
  hasEnvDedup: boolean;
  seenEnv: string;
  seenClaims: string;
  seenFile: string;
  seenState: string;
}

export function resolvePromptSeenSkillState(sessionId: string | null): PromptSeenSkillState {
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasFileDedup = !dedupOff && !!sessionId;
  const seenEnv = typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string"
    ? process.env.VERCEL_PLUGIN_SEEN_SKILLS
    : "";
  const seenClaims = hasFileDedup ? listSessionKeys(sessionId as string, "seen-skills").join(",") : "";
  const seenFile = hasFileDedup ? readSessionFile(sessionId as string, "seen-skills") : "";
  const seenState = hasFileDedup ? mergeSeenSkillStates(seenEnv, seenFile, seenClaims) : seenEnv;

  if (!dedupOff) {
    process.env.VERCEL_PLUGIN_SEEN_SKILLS = seenState;
  }
  if (hasFileDedup) {
    writeSessionFile(sessionId as string, "seen-skills", seenState);
  }

  return {
    dedupOff,
    hasFileDedup,
    hasEnvDedup: !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string",
    seenEnv,
    seenClaims,
    seenFile,
    seenState,
  };
}

export function syncPromptSeenSkillClaims(sessionId: string, loadedSkills: string[]): string {
  for (const skill of loadedSkills) {
    tryClaimSessionKey(sessionId, "seen-skills", skill);
  }
  const synced = syncSessionFileFromClaims(sessionId, "seen-skills");
  process.env.VERCEL_PLUGIN_SEEN_SKILLS = mergeSeenSkillStates(
    process.env.VERCEL_PLUGIN_SEEN_SKILLS || "",
    synced,
  );
  return synced;
}

// ---------------------------------------------------------------------------
// Pipeline stage 1: parsePromptInput
// ---------------------------------------------------------------------------

export interface ParsedPromptInput {
  prompt: string;
  sessionId: string | null;
  cwd: string | null;
}

/**
 * Parse raw stdin JSON into a normalized input descriptor.
 * Returns null if input is empty, unparseable, or prompt is too short.
 */
export function parsePromptInput(raw: string, logger?: Logger): ParsedPromptInput | null {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    l.debug("stdin-empty", {});
    return null;
  }

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(trimmed);
  } catch (err) {
    l.issue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON", { error: String(err) });
    return null;
  }

  const prompt = (input.prompt as string) || "";
  const sessionId = (input.session_id as string) || process.env.SESSION_ID || null;
  const cwdCandidate = input.cwd ?? input.working_directory;
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : null;

  if (prompt.length < MIN_PROMPT_LENGTH) {
    l.debug("prompt-too-short", { length: prompt.length, min: MIN_PROMPT_LENGTH });
    return null;
  }

  l.debug("input-parsed", { promptLength: prompt.length, sessionId: sessionId as string });

  return { prompt, sessionId, cwd };
}

// ---------------------------------------------------------------------------
// Pipeline stage 2: matchPromptSignals
// ---------------------------------------------------------------------------

export interface PromptMatchEntry {
  skill: string;
  score: number;
  reason: string;
  priority: number;
}

/**
 * Evaluate all skills with promptSignals against the normalized prompt.
 * Returns matched entries sorted by score DESC then priority DESC.
 */
export function matchPromptSignals(
  normalizedPrompt: string,
  skills: LoadedSkills,
  logger?: Logger,
): PromptMatchEntry[] {
  const l = logger || log;
  const { skillMap } = skills;
  const matches: PromptMatchEntry[] = [];

  for (const [skill, config] of Object.entries(skillMap)) {
    if (!config.promptSignals) continue;

    const compiled = compilePromptSignals(config.promptSignals);
    const result = matchPromptWithReason(normalizedPrompt, compiled);

    l.trace("prompt-signal-eval", {
      skill,
      matched: result.matched,
      score: result.score,
      reason: result.reason,
    });

    if (result.matched) {
      matches.push({
        skill,
        score: result.score,
        reason: result.reason,
        priority: config.priority,
      });
    }
  }

  // Sort by score DESC, then priority DESC, then skill name ASC
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.skill.localeCompare(b.skill);
  });

  l.debug("prompt-matches", {
    totalWithSignals: Object.values(skillMap).filter((c) => c.promptSignals).length,
    matched: matches.map((m) => ({ skill: m.skill, score: m.score })),
  });

  return matches;
}

// ---------------------------------------------------------------------------
// Pipeline stage 3: dedup + rank + inject
// ---------------------------------------------------------------------------

export interface PromptInjectResult {
  parts: string[];
  loaded: string[];
  summaryOnly: string[];
  droppedByCap: string[];
  droppedByBudget: string[];
  matchedSkills: string[];
}

/**
 * Filter seen skills, cap at MAX_SKILLS, load SKILL.md bodies, enforce budget.
 */
export function deduplicateAndInject(
  matches: PromptMatchEntry[],
  skills: LoadedSkills,
  logger?: Logger,
): PromptInjectResult {
  const l = logger || log;
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const seenEnv = getSeenSkillsEnv();
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const injectedSkills: Set<string> = hasEnvDedup ? parseSeenSkills(seenEnv) : new Set();
  const budget = getInjectionBudget();

  const allMatched = matches.map((m) => m.skill);

  // Filter already-seen skills
  const newMatches = dedupOff
    ? matches
    : matches.filter((m) => !injectedSkills.has(m.skill));

  if (newMatches.length === 0) {
    l.debug("all-prompt-matches-deduped", { matched: allMatched, seen: [...injectedSkills] });
    return { parts: [], loaded: [], summaryOnly: [], droppedByCap: [], droppedByBudget: [], matchedSkills: allMatched };
  }

  // Cap at MAX_SKILLS — take the top-scored entries
  const rankedSkills = newMatches.slice(0, MAX_SKILLS).map((m) => m.skill);
  const droppedByCap = newMatches.slice(MAX_SKILLS).map((m) => m.skill);

  l.debug("prompt-dedup", {
    rankedSkills,
    droppedByCap,
    previouslyInjected: [...injectedSkills],
  });

  // Reuse injectSkills from pretooluse with our budget/cap
  const result = injectSkills(rankedSkills, {
    pluginRoot: PLUGIN_ROOT,
    hasEnvDedup,
    injectedSkills,
    budgetBytes: budget,
    maxSkills: MAX_SKILLS,
    skillMap: skills.skillMap,
    logger: l,
  });

  return {
    ...result,
    droppedByCap: [...result.droppedByCap, ...droppedByCap],
    matchedSkills: allMatched,
  };
}

// ---------------------------------------------------------------------------
// Pipeline stage 4: formatOutput
// ---------------------------------------------------------------------------

export function formatOutput(
  parts: string[],
  matchedSkills: string[],
  injectedSkills: string[],
  summaryOnly: string[],
  droppedByCap: string[],
  droppedByBudget: string[],
): string {
  if (parts.length === 0) {
    return "{}";
  }

  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    hookEvent: "UserPromptSubmit",
    matchedSkills,
    injectedSkills,
    summaryOnly,
    droppedByCap,
    droppedByBudget,
  };

  const metaComment = `<!-- skillInjection: ${JSON.stringify(skillInjection)} -->`;

  const output: SyncHookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit" as const,
      additionalContext: parts.join("\n\n") + "\n" + metaComment,
    },
  };
  return JSON.stringify(output);
}

// ---------------------------------------------------------------------------
// Orchestrator: run()
// ---------------------------------------------------------------------------

export function run(): string {
  const timing: Record<string, number> = {};
  const tPhase = log.active ? log.now() : 0;

  // Stage 1: parsePromptInput
  let raw: string;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
  const parsed = parsePromptInput(raw, log);
  if (!parsed) return "{}";
  if (log.active) timing.stdin_parse = Math.round(log.now() - tPhase);

  const { prompt, sessionId, cwd } = parsed;
  const normalizedPrompt = normalizePromptText(prompt);

  if (!normalizedPrompt) {
    log.debug("normalized-prompt-empty", {});
    return "{}";
  }

  // Stage 2: loadSkills (reuse from pretooluse)
  const tSkillmap = log.active ? log.now() : 0;
  const skills = loadSkills(PLUGIN_ROOT, log);
  if (!skills) return "{}";
  if (log.active) timing.skillmap_load = Math.round(log.now() - tSkillmap);

  // Stage 3: analyzePrompt — structured analysis of matching + dedup + cap
  const tAnalyze = log.active ? log.now() : 0;
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasFileDedup = !dedupOff && !!sessionId;
  const seenEnv = typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string"
    ? process.env.VERCEL_PLUGIN_SEEN_SKILLS
    : "";
  const seenClaims = hasFileDedup ? listSessionKeys(sessionId as string, "seen-skills").join(",") : "";
  const seenFile = hasFileDedup ? readSessionFile(sessionId as string, "seen-skills") : "";
  const seenState = hasFileDedup ? mergeSeenSkillStates(seenEnv, seenFile, seenClaims) : seenEnv;
  if (!dedupOff) {
    process.env.VERCEL_PLUGIN_SEEN_SKILLS = seenState;
  }
  if (hasFileDedup) {
    writeSessionFile(sessionId as string, "seen-skills", seenState);
  }
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const budget = getInjectionBudget();
  const report = analyzePrompt(prompt, skills.skillMap, seenState, budget, MAX_SKILLS);
  if (log.active) timing.analyze = Math.round(log.now() - tAnalyze);

  // --- Trace: full report ---
  log.trace("prompt-analysis-full", report as unknown as Record<string, unknown>);

  // --- Debug: per-skill breakdown ---
  for (const [skill, r] of Object.entries(report.perSkillResults)) {
    log.debug("prompt-signal-eval", {
      skill,
      score: r.score,
      reason: r.reason,
      matched: r.matched,
      suppressed: r.suppressed,
    });
  }

  log.debug("prompt-selection", {
    selectedSkills: report.selectedSkills,
    droppedByCap: report.droppedByCap,
    droppedByBudget: report.droppedByBudget,
    dedupStrategy: report.dedupState.strategy,
    filteredByDedup: report.dedupState.filteredByDedup,
    budgetBytes: report.budgetBytes,
    timingMs: report.timingMs,
  });

  // No matches at all
  const allMatched = Object.entries(report.perSkillResults)
    .filter(([, r]) => r.matched)
    .map(([skill]) => skill);

  if (allMatched.length === 0) {
    log.debug("prompt-analysis-issue", {
      issue: "no_prompt_matches",
      evaluatedSkills: Object.keys(report.perSkillResults),
      suppressedSkills: Object.entries(report.perSkillResults)
        .filter(([, r]) => r.suppressed)
        .map(([skill]) => skill),
    });
    log.complete("no_prompt_matches", { matchedCount: 0 }, log.active ? timing : null);
    return "{}";
  }

  // All matched but filtered by dedup
  if (report.selectedSkills.length === 0) {
    log.debug("prompt-analysis-issue", {
      issue: "all_deduped",
      matchedSkills: allMatched,
      seenSkills: report.dedupState.seenSkills,
      dedupStrategy: report.dedupState.strategy,
    });
    log.complete("all_deduped", {
      matchedCount: allMatched.length,
      dedupedCount: allMatched.length,
    }, log.active ? timing : null);
    return "{}";
  }

  // Stage 4: inject selected skills (file I/O for SKILL.md bodies)
  const tInject = log.active ? log.now() : 0;
  const injectedSkills = hasEnvDedup ? parseSeenSkills(seenState) : new Set<string>();

  const injectResult = injectSkills(report.selectedSkills, {
    pluginRoot: PLUGIN_ROOT,
    hasEnvDedup,
    sessionId,
    injectedSkills,
    budgetBytes: budget,
    maxSkills: MAX_SKILLS,
    skillMap: skills.skillMap,
    logger: log,
  });
  if (log.active) timing.inject = Math.round(log.now() - tInject);

  const { parts, loaded, summaryOnly } = injectResult;
  if (hasFileDedup) {
    syncPromptSeenSkillClaims(sessionId as string, loaded);
  }
  const droppedByCap = [...injectResult.droppedByCap, ...report.droppedByCap];
  const droppedByBudget = [...injectResult.droppedByBudget, ...report.droppedByBudget];
  const matchedSkills = allMatched;

  if (parts.length === 0) {
    log.complete("all_deduped", {
      matchedCount: matchedSkills.length,
      dedupedCount: matchedSkills.length,
    }, log.active ? timing : null);
    return "{}";
  }

  if (log.active) timing.total = log.elapsed();
  log.complete("injected", {
    matchedCount: matchedSkills.length,
    injectedCount: loaded.length,
    dedupedCount: matchedSkills.length - loaded.length - droppedByCap.length - droppedByBudget.length,
    cappedCount: droppedByCap.length + droppedByBudget.length,
  }, log.active ? timing : null);

  // Audit log
  if (loaded.length > 0) {
    appendAuditLog({
      event: "prompt-skill-injection",
      hookEvent: "UserPromptSubmit",
      matchedSkills,
      injectedSkills: loaded,
      summaryOnly,
      droppedByCap,
      droppedByBudget,
    }, cwd);
  }

  // Stage 5: formatOutput
  return formatOutput(parts, matchedSkills, loaded, summaryOnly, droppedByCap, droppedByBudget);
}

// ---------------------------------------------------------------------------
// Execute (only when run directly)
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  try {
    const scriptPath = realpathSync(resolve(process.argv[1] || ""));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const output = run();
    process.stdout.write(output);
  } catch (err) {
    const entry = [
      `[${new Date().toISOString()}] CRASH in user-prompt-submit-skill-inject.mts`,
      `  error: ${(err as Error)?.message || String(err)}`,
      `  stack: ${(err as Error)?.stack || "(no stack)"}`,
      `  PLUGIN_ROOT: ${PLUGIN_ROOT}`,
      `  argv: ${JSON.stringify(process.argv)}`,
      `  cwd: ${process.cwd()}`,
      "",
    ].join("\n");
    process.stderr.write(entry);
    process.stdout.write("{}");
  }
}
