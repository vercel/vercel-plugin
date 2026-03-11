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
import { parseSeenSkills, appendSeenSkill, mergeSeenSkillStates, rankEntries, buildDocsBlock } from "./patterns.mjs";
import type { CompiledSkillEntry } from "./patterns.mjs";
import { normalizePromptText, compilePromptSignals, matchPromptWithReason, scorePromptWithLexical, classifyTroubleshootingIntent } from "./prompt-patterns.mjs";
import type { CompiledPromptSignals, TroubleshootingIntentResult } from "./prompt-patterns.mjs";
import { searchSkills, initializeLexicalIndex } from "./lexical-index.mjs";
import { analyzePrompt } from "./prompt-analysis.mjs";
import type { PromptAnalysisReport } from "./prompt-analysis.mjs";
import { createLogger, logDecision } from "./logger.mjs";
import type { Logger } from "./logger.mjs";
import { isTelemetryEnabled, trackEvents } from "./telemetry.mjs";

const MAX_SKILLS = 2;
const DEFAULT_INJECTION_BUDGET_BYTES = 8_000;
const MIN_PROMPT_LENGTH = 10;
const PLUGIN_ROOT = resolvePluginRoot();
const SKILL_INJECTION_VERSION = 1;

/**
 * Companion skills for investigation-mode, in priority order.
 * When investigation-mode triggers, the second slot is given to the
 * highest-scoring companion that independently matched (score >= its minScore).
 */
export const INVESTIGATION_COMPANION_SKILLS = [
  "workflow",
  "agent-browser-verify",
  "vercel-cli",
] as const;

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
 *
 * When lexical is true (VERCEL_PLUGIN_LEXICAL_PROMPT=1), uses
 * scorePromptWithLexical() for hybrid exact+lexical matching with
 * adaptive boost tiers. Default (false) preserves exact-match behavior.
 */
export function matchPromptSignals(
  normalizedPrompt: string,
  skills: LoadedSkills,
  logger?: Logger,
  options?: { lexical?: boolean },
): PromptMatchEntry[] {
  const l = logger || log;
  const lexical = options?.lexical ?? false;
  const { skillMap } = skills;
  const matches: PromptMatchEntry[] = [];

  // Pre-compute lexical hits once for all skills when enabled
  const lexicalHits = lexical ? searchSkills(normalizedPrompt) : undefined;

  for (const [skill, config] of Object.entries(skillMap)) {
    if (!config.promptSignals) continue;

    const compiled = compilePromptSignals(config.promptSignals);

    if (lexical) {
      // Lexical path: use scorePromptWithLexical for hybrid scoring
      const lexResult = scorePromptWithLexical(normalizedPrompt, skill, compiled, lexicalHits);
      const isMatched = lexResult.score >= compiled.minScore;

      const reason = lexResult.source === "exact"
        ? matchPromptWithReason(normalizedPrompt, compiled).reason
        : `${matchPromptWithReason(normalizedPrompt, compiled).reason}; lexical ${lexResult.source} (score ${lexResult.lexicalScore.toFixed(1)}, tier ${lexResult.boostTier ?? "none"})`;

      l.trace("prompt-signal-eval", {
        skill,
        matched: isMatched,
        score: lexResult.score,
        reason,
        source: lexResult.source,
        boostTier: lexResult.boostTier,
      });

      if (isMatched) {
        matches.push({
          skill,
          score: lexResult.score,
          reason,
          priority: config.priority,
        });
      }
    } else {
      // Exact-match path (default): unchanged behavior
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
    lexical,
  });

  return matches;
}

// ---------------------------------------------------------------------------
// Pipeline stage 2b: investigation companion selection
// ---------------------------------------------------------------------------

export interface CompanionSelection {
  companion: string | null;
  reason: string;
}

/**
 * When investigation-mode is in the selected skills, pick the best companion
 * from INVESTIGATION_COMPANION_SKILLS based on match scores.
 *
 * Returns the companion skill name if one matched independently, or null.
 * Priority tiebreaker: workflow > agent-browser-verify > vercel-cli.
 */
export function selectInvestigationCompanion(
  selectedSkills: string[],
  perSkillResults: Record<string, { score: number; matched: boolean }>,
): CompanionSelection {
  if (!selectedSkills.includes("investigation-mode")) {
    return { companion: null, reason: "investigation-mode not selected" };
  }

  let bestCompanion: string | null = null;
  let bestScore = -Infinity;

  for (const candidate of INVESTIGATION_COMPANION_SKILLS) {
    const result = perSkillResults[candidate];
    if (result && result.matched && result.score > bestScore) {
      bestScore = result.score;
      bestCompanion = candidate;
    }
  }

  if (!bestCompanion) {
    return { companion: null, reason: "no companion scored high enough" };
  }

  return {
    companion: bestCompanion,
    reason: `companion "${bestCompanion}" scored ${bestScore}`,
  };
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
  promptMatchReasons?: Record<string, string>,
  skillMap?: Record<string, { docs?: string[]; sitemap?: string }>,
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

  // Build banner describing why skills were auto-suggested
  const bannerLines: string[] = ["[vercel-plugin] Best practices auto-suggested based on prompt analysis:"];
  for (const skill of injectedSkills) {
    const reason = promptMatchReasons?.[skill];
    if (reason) {
      bannerLines.push(`  - "${skill}" matched: ${reason}`);
    } else {
      bannerLines.push(`  - "${skill}"`);
    }
  }
  const banner = bannerLines.join("\n");
  const docsBlock = buildDocsBlock(injectedSkills, skillMap);

  const sections = [banner];
  if (docsBlock) sections.push(docsBlock);
  sections.push(parts.join("\n\n"));

  const output: SyncHookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit" as const,
      additionalContext: sections.join("\n\n") + "\n" + metaComment,
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

  if (isTelemetryEnabled() && sessionId) {
    trackEvents(sessionId, [
      { key: "prompt:text", value: prompt },
    ]).catch(() => {});
  }

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
  const lexicalEnabled = process.env.VERCEL_PLUGIN_LEXICAL_PROMPT === "1";
  if (lexicalEnabled) {
    initializeLexicalIndex(new Map(Object.entries(skills.skillMap)));
  }
  const report = analyzePrompt(prompt, skills.skillMap, seenState, budget, MAX_SKILLS, { lexicalEnabled });
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

  // Stage 3b: troubleshooting intent routing
  const intentResult = classifyTroubleshootingIntent(normalizedPrompt);
  if (intentResult.intent) {
    // Ensure intent-routed skills appear in selectedSkills
    for (const skill of intentResult.skills) {
      if (
        !report.selectedSkills.includes(skill) &&
        report.selectedSkills.length < MAX_SKILLS
      ) {
        report.selectedSkills.push(skill);
      }
    }
    logDecision(log, {
      hook: "UserPromptSubmit",
      event: "troubleshooting_intent_routed",
      intent: intentResult.intent,
      skills: intentResult.skills,
      reason: intentResult.reason,
      durationMs: log.active ? log.elapsed() : undefined,
    });
  } else if (intentResult.reason === "suppressed by test framework mention") {
    // Suppress all verification-family skills
    const suppressSet = new Set(["verification", "investigation-mode", "agent-browser-verify"]);
    const before = report.selectedSkills.length;
    report.selectedSkills = report.selectedSkills.filter((s: string) => !suppressSet.has(s));
    if (report.selectedSkills.length < before) {
      logDecision(log, {
        hook: "UserPromptSubmit",
        event: "verification_family_suppressed",
        reason: intentResult.reason,
        durationMs: log.active ? log.elapsed() : undefined,
      });
    }
  }

  // Detect investigation/debugging intent from matched skills
  const investigationSkills = ["investigation-mode", "observability", "workflow"];
  const matchedInvestigation = Object.entries(report.perSkillResults)
    .filter(([skill, r]) => r.matched && investigationSkills.includes(skill));
  if (matchedInvestigation.length > 0) {
    logDecision(log, {
      hook: "UserPromptSubmit",
      event: "investigation_intent_detected",
      reason: "frustration_or_debug_signals",
      skills: matchedInvestigation.map(([skill, r]) => ({ skill, score: r.score })),
      durationMs: log.active ? log.elapsed() : undefined,
    });
  }

  // Investigation-mode companion selection: when investigation-mode is selected,
  // ensure the second slot goes to the best companion skill.
  const companionResult = selectInvestigationCompanion(
    report.selectedSkills,
    report.perSkillResults,
  );
  if (companionResult.companion) {
    const companion = companionResult.companion;
    // Ensure investigation-mode is first, companion is second
    const newSelected = ["investigation-mode"];
    if (!report.selectedSkills.includes(companion)) {
      // Companion wasn't already selected — add it, possibly displacing another skill
      newSelected.push(companion);
    } else {
      // Companion was already selected — just reorder
      newSelected.push(companion);
    }
    report.selectedSkills.length = 0;
    report.selectedSkills.push(...newSelected);

    logDecision(log, {
      hook: "UserPromptSubmit",
      event: "companion_selected",
      skill: "investigation-mode",
      companion,
      reason: companionResult.reason,
      durationMs: log.active ? log.elapsed() : undefined,
    });
  } else if (report.selectedSkills.length > 1) {
    logDecision(log, {
      hook: "UserPromptSubmit",
      event: "companion_selected",
      skill: report.selectedSkills[0],
      companion: report.selectedSkills[1],
      reason: "multi_skill_prompt_match",
      durationMs: log.active ? log.elapsed() : undefined,
    });
  }

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

  if (isTelemetryEnabled() && sessionId && loaded.length > 0) {
    const telemetryEntries: Array<{ key: string; value: string }> = [];
    for (const skill of loaded) {
      const r = report.perSkillResults[skill];
      telemetryEntries.push(
        { key: "prompt:skill", value: skill },
        { key: "prompt:score", value: String(r?.score ?? 0) },
        { key: "prompt:hook", value: "UserPromptSubmit" },
      );
    }
    trackEvents(sessionId, telemetryEntries).catch(() => {});
  }

  // Stage 5: formatOutput
  // Build prompt match reasons for the banner
  const promptMatchReasons: Record<string, string> = {};
  for (const skill of loaded) {
    const r = report.perSkillResults[skill];
    if (r?.reason) {
      promptMatchReasons[skill] = r.reason;
    }
  }
  return formatOutput(parts, matchedSkills, loaded, summaryOnly, droppedByCap, droppedByBudget, promptMatchReasons, skills.skillMap);
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
