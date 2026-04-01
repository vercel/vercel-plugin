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
 *   Threshold: score >= minScore (default 6). Project-context skills get +3.
 *   When one skill scores >= 600, scores under 50 are filtered out.
 *
 * Max 2 skills injected per prompt, 8KB total budget.
 * Deduplicates via session seen-skill state when available.
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
import {
  COMPACTION_REINJECT_MIN_PRIORITY,
  parseSeenSkills,
  mergeSeenSkillStates,
  mergeSeenSkillStatesWithCompactionReset,
  buildDocsBlock,
} from "./patterns.mjs";
import { normalizePromptText, compilePromptSignals, matchPromptWithReason, scorePromptWithLexical, classifyTroubleshootingIntent, lexicalFallbackMeetsFloor } from "./prompt-patterns.mjs";
import { searchSkills, initializeLexicalIndex } from "./lexical-index.mjs";
import { analyzePrompt } from "./prompt-analysis.mjs";
import type { PromptAnalysisReport } from "./prompt-analysis.mjs";
import { createLogger, logDecision } from "./logger.mjs";
import type { Logger } from "./logger.mjs";
import { trackBaseEvents } from "./telemetry.mjs";
import { selectManagedContextChunk } from "./vercel-context.mjs";

const MAX_SKILLS = 2;
const DEFAULT_INJECTION_BUDGET_BYTES = 8_000;
const MIN_PROMPT_LENGTH = 10;
const PLUGIN_ROOT = resolvePluginRoot();
const SKILL_INJECTION_VERSION = 1;
const ENV_SEEN_SKILLS_KEY = "VERCEL_PLUGIN_SEEN_SKILLS";
const ENV_CONTEXT_COMPACTED_KEY = "VERCEL_PLUGIN_CONTEXT_COMPACTED";
const DEFAULT_PROMPT_MIN_SCORE = 6;
const PROJECT_CONTEXT_PROMPT_SCORE_BOOST = 3;
const DOMINANT_TOPIC_SCORE_THRESHOLD = 600;
const DOMINANT_TOPIC_MIN_SCORE = 50;

export type PromptHookPlatform = "claude-code" | "cursor";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @returns comma-delimited seen skills from env, or "" */
function getSeenSkillsEnv(): string {
  return typeof process.env[ENV_SEEN_SKILLS_KEY] === "string"
    ? process.env[ENV_SEEN_SKILLS_KEY]
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function detectPromptHookPlatform(input: Record<string, unknown>): PromptHookPlatform {
  if ("conversation_id" in input || "cursor_version" in input) {
    return "cursor";
  }

  return "claude-code";
}

function detectPromptHookPlatformFromRaw(raw: string): PromptHookPlatform {
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed)) {
      return detectPromptHookPlatform(parsed);
    }
  } catch {
    // Fall back to Claude-compatible empty output when stdin is invalid.
  }

  return "claude-code";
}

function resolvePromptSessionId(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string | null {
  return nonEmptyString(input.session_id)
    ?? nonEmptyString(input.conversation_id)
    ?? nonEmptyString(env.SESSION_ID);
}

function resolvePromptCwd(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  const workspaceRoot = Array.isArray(input.workspace_roots)
    ? input.workspace_roots.find((entry) => typeof entry === "string" && entry.trim() !== "")
    : null;

  return nonEmptyString(input.cwd)
    ?? (typeof workspaceRoot === "string" ? workspaceRoot : null)
    ?? nonEmptyString(env.CURSOR_PROJECT_DIR)
    ?? nonEmptyString(env.CLAUDE_PROJECT_ROOT)
    ?? process.cwd();
}

function resolvePromptText(input: Record<string, unknown>): string {
  return nonEmptyString(input.prompt)
    ?? nonEmptyString(input.message)
    ?? "";
}

function formatEmptyOutput(platform: PromptHookPlatform, env?: Record<string, string>): string {
  if (platform === "cursor") {
    const output: Record<string, unknown> = { continue: true };
    if (env && Object.keys(env).length > 0) {
      output.env = env;
    }
    return JSON.stringify(output);
  }

  return "{}";
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
  seenClaims: string;
  seenFile: string;
  seenEnv: string;
  seenState: string;
  compactionResetApplied: boolean;
  clearedSkills: string[];
}

function capturePromptEnvSnapshot(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return {
    [ENV_SEEN_SKILLS_KEY]: env[ENV_SEEN_SKILLS_KEY],
    [ENV_CONTEXT_COMPACTED_KEY]: env[ENV_CONTEXT_COMPACTED_KEY],
  };
}

function finalizePromptEnvUpdates(
  platform: PromptHookPlatform,
  before: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (platform !== "cursor") return undefined;

  const updates: Record<string, string> = {};
  for (const key of [ENV_SEEN_SKILLS_KEY, ENV_CONTEXT_COMPACTED_KEY]) {
    const nextValue = env[key];
    if (typeof nextValue === "string" && nextValue !== before[key]) {
      updates[key] = nextValue;
    }
  }

  return Object.keys(updates).length > 0 ? updates : undefined;
}

export function resolvePromptSeenSkillState(
  sessionId: string | null,
  skillMap?: LoadedSkills["skillMap"],
): PromptSeenSkillState {
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasFileDedup = !dedupOff && !!sessionId;
  const seenEnv = getSeenSkillsEnv();
  const seenClaims = hasFileDedup ? listSessionKeys(sessionId as string, "seen-skills").join(",") : "";
  const seenFile = hasFileDedup ? readSessionFile(sessionId as string, "seen-skills") : "";
  const seenStateResult = dedupOff
    ? {
      seenEnv,
      seenState: hasFileDedup ? mergeSeenSkillStates(seenFile, seenClaims) : seenEnv,
      compactionResetApplied: false,
      clearedSkills: [] as string[],
    }
    : mergeSeenSkillStatesWithCompactionReset(seenEnv, seenFile, seenClaims, {
      sessionId: hasFileDedup ? sessionId : undefined,
      includeEnv: !hasFileDedup,
      skillMap,
    });
  const seenState = seenStateResult.seenState;

  if (hasFileDedup) {
    writeSessionFile(sessionId as string, "seen-skills", seenState);
  }

  return {
    dedupOff,
    hasFileDedup,
    seenClaims,
    seenFile,
    seenEnv: seenStateResult.seenEnv,
    seenState,
    compactionResetApplied: seenStateResult.compactionResetApplied,
    clearedSkills: seenStateResult.clearedSkills,
  };
}

export function syncPromptSeenSkillClaims(sessionId: string, loadedSkills: string[]): string {
  for (const skill of loadedSkills) {
    tryClaimSessionKey(sessionId, "seen-skills", skill);
  }
  return syncSessionFileFromClaims(sessionId, "seen-skills");
}

// ---------------------------------------------------------------------------
// Pipeline stage 1: parsePromptInput
// ---------------------------------------------------------------------------

export interface ParsedPromptInput {
  prompt: string;
  platform: PromptHookPlatform;
  sessionId: string | null;
  cwd: string;
}

/**
 * Parse raw stdin JSON into a normalized input descriptor.
 * Returns null if input is empty, unparseable, or prompt is too short.
 */
export function parsePromptInput(raw: string, logger?: Logger, env: NodeJS.ProcessEnv = process.env): ParsedPromptInput | null {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    l.debug("stdin-empty", {});
    return null;
  }

  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      l.debug("stdin-not-object", {});
      return null;
    }
    input = parsed;
  } catch (err) {
    l.issue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON", { error: String(err) });
    return null;
  }

  const platform = detectPromptHookPlatform(input);
  const prompt = resolvePromptText(input);
  const sessionId = resolvePromptSessionId(input, env);
  const cwd = resolvePromptCwd(input, env);

  if (prompt.length < MIN_PROMPT_LENGTH) {
    l.debug("prompt-too-short", { length: prompt.length, min: MIN_PROMPT_LENGTH });
    return null;
  }

  l.debug("input-parsed", {
    promptLength: prompt.length,
    sessionId,
    cwd,
    platform,
  });

  return { prompt, platform, sessionId, cwd };
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

interface PromptScoreState extends PromptMatchEntry {
  matched: boolean;
  minScore: number;
  suppressed: boolean;
}

function parseLikelySkillsEnv(envValue = process.env.VERCEL_PLUGIN_LIKELY_SKILLS): Set<string> {
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return new Set();
  }

  return new Set(
    envValue
      .split(",")
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0),
  );
}

function getPromptSignalMinScore(skillConfig: LoadedSkills["skillMap"][string] | undefined): number {
  const minScore = skillConfig?.promptSignals?.minScore;
  return typeof minScore === "number" && !Number.isNaN(minScore)
    ? minScore
    : DEFAULT_PROMPT_MIN_SCORE;
}

function formatPromptScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function extractLexicalScore(reason: string): number | null {
  const match = reason.match(/lexical [^(]*\((?:raw |score )([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function extractBelowThresholdScore(reason: string): number | null {
  const match = reason.match(/below threshold: score (-?[0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function applyLexicalFallbackFloor(entry: PromptScoreState): PromptScoreState {
  const lexicalScore = extractLexicalScore(entry.reason);
  if (lexicalScore == null || lexicalFallbackMeetsFloor(lexicalScore) || entry.score === -Infinity) {
    return entry;
  }

  const exactScore = extractBelowThresholdScore(entry.reason);
  const score = exactScore ?? entry.score;

  return {
    ...entry,
    score,
    matched: score >= entry.minScore,
    reason: `${entry.reason}; lexical floor rejected (raw ${formatPromptScore(lexicalScore)} < 20)`,
  };
}

function applyProjectContextBoost(
  entry: PromptScoreState,
  likelySkills: Set<string>,
): PromptScoreState {
  if (!likelySkills.has(entry.skill) || entry.score === -Infinity) {
    return entry;
  }

  const boostedScore = entry.score + PROJECT_CONTEXT_PROMPT_SCORE_BOOST;
  const boostReason = `project-context +${PROJECT_CONTEXT_PROMPT_SCORE_BOOST} (${formatPromptScore(entry.score)} -> ${formatPromptScore(boostedScore)})`;
  const reason = entry.reason.startsWith("below threshold:") && boostedScore >= entry.minScore
    ? boostReason
    : entry.reason
      ? `${entry.reason}; ${boostReason}`
      : boostReason;

  return {
    ...entry,
    score: boostedScore,
    reason,
    matched: boostedScore >= entry.minScore,
  };
}

function applyDominantTopicSuppression(
  entry: PromptScoreState,
  topScore: number,
): PromptScoreState {
  if (
    !entry.matched
    || !Number.isFinite(entry.score)
    || entry.score >= DOMINANT_TOPIC_MIN_SCORE
    || topScore < DOMINANT_TOPIC_SCORE_THRESHOLD
  ) {
    return entry;
  }

  return {
    ...entry,
    matched: false,
    suppressed: true,
    reason: `${entry.reason}; suppressed by dominant topic (${formatPromptScore(topScore)} >= ${DOMINANT_TOPIC_SCORE_THRESHOLD}, score < ${DOMINANT_TOPIC_MIN_SCORE})`,
  };
}

function applyPromptScoreAdjustments(
  entries: PromptScoreState[],
  logger?: Logger,
): PromptScoreState[] {
  const l = logger || log;
  const likelySkills = parseLikelySkillsEnv();
  const lexicalFloorRejected: string[] = [];
  const flooredEntries = entries.map((entry) => {
    const adjusted = applyLexicalFallbackFloor(entry);
    if (adjusted !== entry) {
      lexicalFloorRejected.push(entry.skill);
    }
    return adjusted;
  });
  const boostedSkills: string[] = [];

  if (lexicalFloorRejected.length > 0) {
    l.debug("prompt-lexical-floor-rejected", {
      minRawScore: 20,
      rejectedSkills: lexicalFloorRejected,
    });
  }

  const boostedEntries = flooredEntries.map((entry) => {
    const boosted = applyProjectContextBoost(entry, likelySkills);
    if (boosted !== entry) {
      boostedSkills.push(entry.skill);
    }
    return boosted;
  });

  if (boostedSkills.length > 0) {
    l.debug("prompt-project-context-boost", {
      boost: PROJECT_CONTEXT_PROMPT_SCORE_BOOST,
      boostedSkills,
    });
  }

  const topScore = boostedEntries.reduce((max, entry) => {
    if (Number.isFinite(entry.score) && entry.score > max) {
      return entry.score;
    }
    return max;
  }, -Infinity);

  if (topScore < DOMINANT_TOPIC_SCORE_THRESHOLD) {
    return boostedEntries;
  }

  const suppressedSkills: string[] = [];
  const adjustedEntries = boostedEntries.map((entry) => {
    const adjusted = applyDominantTopicSuppression(entry, topScore);
    if (adjusted !== entry) {
      suppressedSkills.push(entry.skill);
    }
    return adjusted;
  });

  if (suppressedSkills.length > 0) {
    l.debug("prompt-dominant-topic-suppression", {
      topScore,
      minScore: DOMINANT_TOPIC_MIN_SCORE,
      suppressedSkills,
    });
  }

  return adjustedEntries;
}

function sortPromptScoreStates<T extends Pick<PromptMatchEntry, "skill" | "score" | "priority">>(entries: T[]): void {
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.skill.localeCompare(b.skill);
  });
}

function estimatePromptSkillSize(skillConfig: LoadedSkills["skillMap"][string] | undefined): number {
  return skillConfig?.summary
    ? Math.max(skillConfig.summary.length * 10, 500)
    : 500;
}

function rerankPromptAnalysisReport(
  report: PromptAnalysisReport,
  skillMap: LoadedSkills["skillMap"],
  maxSkills: number,
  budgetBytes: number,
): void {
  const ranked = Object.entries(report.perSkillResults)
    .filter(([, result]) => result.matched)
    .map(([skill, result]) => ({
      skill,
      score: result.score,
      reason: result.reason,
      priority: skillMap[skill]?.priority ?? 0,
      matched: true,
      minScore: getPromptSignalMinScore(skillMap[skill]),
      suppressed: result.suppressed,
    }));

  sortPromptScoreStates(ranked);

  const dedupDisabled = report.dedupState.strategy === "disabled";
  const seenSkills = new Set(report.dedupState.seenSkills);
  const filteredByDedup: string[] = [];
  const afterDedup = ranked.filter((entry) => {
    if (!dedupDisabled && seenSkills.has(entry.skill)) {
      filteredByDedup.push(entry.skill);
      return false;
    }
    return true;
  });

  report.dedupState.filteredByDedup = filteredByDedup;
  report.droppedByCap = afterDedup.slice(maxSkills).map((entry) => entry.skill);

  const droppedByBudget: string[] = [];
  const selectedSkills: string[] = [];
  let usedBytes = 0;
  for (const entry of afterDedup.slice(0, maxSkills)) {
    const estimatedSize = estimatePromptSkillSize(skillMap[entry.skill]);
    if (usedBytes + estimatedSize > budgetBytes && selectedSkills.length > 0) {
      droppedByBudget.push(entry.skill);
      continue;
    }
    usedBytes += estimatedSize;
    selectedSkills.push(entry.skill);
  }

  report.selectedSkills = selectedSkills;
  report.droppedByBudget = droppedByBudget;
}

function applyPromptScoreAdjustmentsToReport(
  report: PromptAnalysisReport,
  skillMap: LoadedSkills["skillMap"],
  logger?: Logger,
  options?: { maxSkills?: number; budgetBytes?: number },
): PromptAnalysisReport {
  const scoredEntries: PromptScoreState[] = Object.entries(report.perSkillResults).map(
    ([skill, result]) => ({
      skill,
      score: result.score,
      reason: result.reason,
      priority: skillMap[skill]?.priority ?? 0,
      matched: result.matched,
      minScore: getPromptSignalMinScore(skillMap[skill]),
      suppressed: result.suppressed,
    }),
  );

  const adjustedEntries = applyPromptScoreAdjustments(scoredEntries, logger);
  for (const entry of adjustedEntries) {
    report.perSkillResults[entry.skill] = {
      score: entry.score,
      reason: entry.reason,
      matched: entry.matched,
      suppressed: entry.suppressed,
    };
  }

  rerankPromptAnalysisReport(
    report,
    skillMap,
    options?.maxSkills ?? MAX_SKILLS,
    options?.budgetBytes ?? report.budgetBytes,
  );

  return report;
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
  const scoredEntries: PromptScoreState[] = [];

  // Pre-compute lexical hits once for all skills when enabled
  const lexicalHits = lexical ? searchSkills(normalizedPrompt) : undefined;

  for (const [skill, config] of Object.entries(skillMap)) {
    if (!config.promptSignals) continue;

    const compiled = compilePromptSignals(config.promptSignals);

    if (lexical) {
      // Lexical path: use scorePromptWithLexical for hybrid scoring
      const lexResult = scorePromptWithLexical(normalizedPrompt, skill, compiled, lexicalHits);
      const lexicalFloorRejected = lexResult.source !== "exact"
        && !lexicalFallbackMeetsFloor(lexResult.lexicalScore);
      const isMatched = lexResult.score >= compiled.minScore && !lexicalFloorRejected;

      const reason = lexResult.source === "exact"
        ? matchPromptWithReason(normalizedPrompt, compiled).reason
        : `${matchPromptWithReason(normalizedPrompt, compiled).reason}; lexical ${lexResult.source} (score ${lexResult.lexicalScore.toFixed(1)}, tier ${lexResult.boostTier ?? "none"})${lexicalFloorRejected ? "; lexical floor rejected" : ""}`;

      scoredEntries.push({
        skill,
        score: lexResult.score,
        reason,
        priority: config.priority,
        matched: isMatched,
        minScore: compiled.minScore,
        suppressed: lexResult.score === -Infinity,
      });
    } else {
      // Exact-match path (default): unchanged behavior
      const result = matchPromptWithReason(normalizedPrompt, compiled);

      scoredEntries.push({
        skill,
        matched: result.matched,
        score: result.score,
        reason: result.reason,
        priority: config.priority,
        minScore: compiled.minScore,
        suppressed: result.score === -Infinity,
      });
    }
  }

  const adjustedEntries = applyPromptScoreAdjustments(scoredEntries, l);
  for (const entry of adjustedEntries) {
    l.trace("prompt-signal-eval", {
      skill: entry.skill,
      matched: entry.matched,
      score: entry.score,
      reason: entry.reason,
      suppressed: entry.suppressed,
    });
  }

  const matches = adjustedEntries
    .filter((entry) => entry.matched)
    .map(({ skill, score, reason, priority }) => ({
      skill,
      score,
      reason,
      priority,
    }));

  // Sort by score DESC, then priority DESC, then skill name ASC
  sortPromptScoreStates(matches);

  l.debug("prompt-matches", {
    totalWithSignals: Object.values(skillMap).filter((c) => c.promptSignals).length,
    matched: matches.map((m) => ({ skill: m.skill, score: m.score })),
    lexical,
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
  platform?: PromptHookPlatform,
): PromptInjectResult {
  const l = logger || log;
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const seenState = getSeenSkillsEnv();
  const injectedSkills: Set<string> = dedupOff ? new Set() : parseSeenSkills(seenState);
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
    hasEnvDedup: !dedupOff,
    injectedSkills,
    budgetBytes: budget,
    maxSkills: MAX_SKILLS,
    skillMap: skills.skillMap,
    logger: l,
    platform: platform ?? "claude-code",
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
  contextChunks: string[],
  summaryOnly: string[],
  droppedByCap: string[],
  droppedByBudget: string[],
  promptMatchReasons?: Record<string, string>,
  skillMap?: Record<string, { docs?: string[]; sitemap?: string }>,
  platform: PromptHookPlatform = "claude-code",
  env?: Record<string, string>,
): string {
  if (parts.length === 0) {
    return formatEmptyOutput(platform, env);
  }

  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    hookEvent: "UserPromptSubmit",
    matchedSkills,
    injectedSkills,
    contextChunks,
    summaryOnly,
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

  const additionalContext = sections.join("\n\n") + "\n" + metaComment;

  if (platform === "cursor") {
    const output: Record<string, unknown> = {
      additional_context: additionalContext,
      continue: true,
    };
    if (env && Object.keys(env).length > 0) {
      output.env = env;
    }
    return JSON.stringify(output);
  }

  const output: SyncHookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit" as const,
      additionalContext,
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
  const platform = detectPromptHookPlatformFromRaw(raw);
  const parsed = parsePromptInput(raw, log);
  if (!parsed) return formatEmptyOutput(platform);
  if (log.active) timing.stdin_parse = Math.round(log.now() - tPhase);

  const { prompt, sessionId, cwd } = parsed;
  const promptEnvBefore = capturePromptEnvSnapshot();

  // prompt:text telemetry is handled by user-prompt-submit-telemetry.mts
  // where it is awaited before process.exit(), ensuring reliable delivery.

  const normalizedPrompt = normalizePromptText(prompt);

  if (!normalizedPrompt) {
    log.debug("normalized-prompt-empty", {});
    return formatEmptyOutput(platform);
  }

  // Stage 2: loadSkills (reuse from pretooluse)
  const tSkillmap = log.active ? log.now() : 0;
  const skills = loadSkills(PLUGIN_ROOT, log);
  if (!skills) return formatEmptyOutput(platform);
  if (log.active) timing.skillmap_load = Math.round(log.now() - tSkillmap);

  // Stage 3: analyzePrompt — structured analysis of matching + dedup + cap
  const tAnalyze = log.active ? log.now() : 0;
  const seenSkillState = resolvePromptSeenSkillState(sessionId, skills.skillMap);
  const { dedupOff, hasFileDedup, seenState } = seenSkillState;
  if (seenSkillState.compactionResetApplied) {
    log.debug("dedup-compaction-reset", {
      sessionId,
      threshold: COMPACTION_REINJECT_MIN_PRIORITY,
      clearedSkills: seenSkillState.clearedSkills,
    });
  }
  const budget = getInjectionBudget();
  const lexicalEnabled = process.env.VERCEL_PLUGIN_LEXICAL_PROMPT !== "0";
  if (lexicalEnabled) {
    initializeLexicalIndex(new Map(Object.entries(skills.skillMap)));
  }
  const report = analyzePrompt(prompt, skills.skillMap, seenState, budget, MAX_SKILLS, { lexicalEnabled });
  applyPromptScoreAdjustmentsToReport(report, skills.skillMap, log, {
    maxSkills: MAX_SKILLS,
    budgetBytes: budget,
  });
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
    const suppressSet = new Set(["verification"]);
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
  const investigationSkills = ["workflow"];
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
    return formatEmptyOutput(platform, finalizePromptEnvUpdates(platform, promptEnvBefore));
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
    return formatEmptyOutput(platform, finalizePromptEnvUpdates(platform, promptEnvBefore));
  }

  // Stage 4: inject selected skills (file I/O for SKILL.md bodies)
  const tInject = log.active ? log.now() : 0;
  const injectedSkills = dedupOff ? new Set<string>() : parseSeenSkills(seenState);

  const injectResult = injectSkills(report.selectedSkills, {
    pluginRoot: PLUGIN_ROOT,
    hasEnvDedup: !dedupOff,
    sessionId,
    injectedSkills,
    budgetBytes: budget,
    maxSkills: MAX_SKILLS,
    skillMap: skills.skillMap,
    logger: log,
    platform: platform as "claude-code" | "cursor",
  });
  if (log.active) timing.inject = Math.round(log.now() - tInject);

  const { parts, loaded, summaryOnly } = injectResult;
  const injectedContextChunks: string[] = [];
  const chunk = selectManagedContextChunk(loaded, {
    pluginRoot: PLUGIN_ROOT,
    sessionId,
  });
  if (chunk) {
    parts.push(chunk.wrapped);
    injectedContextChunks.push(chunk.chunkId);
    log.debug("managed-context-chunk-injected", {
      chunkId: chunk.chunkId,
      skill: chunk.skill,
      bytes: chunk.bytes,
    });
  }
  let syncedSeenSkills = seenState;
  if (hasFileDedup) {
    syncedSeenSkills = syncPromptSeenSkillClaims(sessionId as string, loaded);
  }
  const droppedByCap = [...injectResult.droppedByCap, ...report.droppedByCap];
  const droppedByBudget = [...injectResult.droppedByBudget, ...report.droppedByBudget];
  const matchedSkills = allMatched;

  if (parts.length === 0) {
    log.complete("all_deduped", {
      matchedCount: matchedSkills.length,
      dedupedCount: matchedSkills.length,
    }, log.active ? timing : null);
    return formatEmptyOutput(platform);
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
      contextChunks: injectedContextChunks,
      summaryOnly,
      droppedByCap,
      droppedByBudget,
    }, cwd);
  }

  // Base telemetry — always-on (no opt-in required)
  if (sessionId && loaded.length > 0) {
    const telemetryEntries: Array<{ key: string; value: string }> = [];
    for (const skill of loaded) {
      const r = report.perSkillResults[skill];
      telemetryEntries.push(
        { key: "prompt:skill", value: skill },
        { key: "prompt:score", value: String(r?.score ?? 0) },
        { key: "prompt:hook", value: "UserPromptSubmit" },
      );
    }
    trackBaseEvents(sessionId, telemetryEntries).catch(() => {});
  }

  let outputEnv: Record<string, string> | undefined;
  const envFile = nonEmptyString(process.env.CLAUDE_ENV_FILE);
  const seenSkills = hasFileDedup ? syncedSeenSkills : seenState;
  if (platform === "cursor") {
    if (!envFile) {
      process.env[ENV_SEEN_SKILLS_KEY] = seenSkills;
    }
    outputEnv = finalizePromptEnvUpdates(platform, promptEnvBefore);
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
  return formatOutput(
    parts,
    matchedSkills,
    loaded,
    injectedContextChunks,
    summaryOnly,
    droppedByCap,
    droppedByBudget,
    promptMatchReasons,
    skills.skillMap,
    platform,
    outputEnv,
  );
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
