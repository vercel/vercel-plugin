#!/usr/bin/env node
/**
 * PreToolUse hook: injects relevant SKILL.md content as additionalContext
 * when Claude reads/edits/writes files or runs bash commands that match
 * skill-map patterns.
 *
 * Input: JSON on stdin with tool_name, tool_input, session_id, cwd
 * Output: Claude Code emits { hookSpecificOutput: { additionalContext: "..." } } or {},
 * while Cursor emits { additional_context: "..." } or {}.
 *
 * Injects skills in priority order until byte budget (default 18KB) is exhausted,
 * with a hard ceiling of 3 skills. Deduplicates per session.
 *
 * Log levels (VERCEL_PLUGIN_LOG_LEVEL): off | summary | debug | trace
 * Legacy: VERCEL_PLUGIN_DEBUG=1 / VERCEL_PLUGIN_HOOK_DEBUG=1 → debug level
 *
 * Pipeline stages (each independently importable and testable):
 *   parseInput → loadSkills → matchSkills → deduplicateSkills → injectSkills → formatOutput
 */

import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectPlatform,
  type HookPlatform,
} from "./compat.mjs";
import {
  appendAuditLog,
  generateVerificationId,
  listSessionKeys,
  pluginRoot as resolvePluginRoot,
  readSessionFile,
  safeReadJson,
  safeReadFile,
  syncSessionFileFromClaims,
  tryClaimSessionKey,
  writeSessionFile,
} from "./hook-env.mjs";

import { buildSkillMap, extractFrontmatter, validateSkillMap } from "./skill-map-frontmatter.mjs";
import type { SkillConfig } from "./skill-map-frontmatter.mjs";
import {
  COMPACTION_REINJECT_MIN_PRIORITY,
  parseSeenSkills,
  mergeSeenSkillStates,
  mergeSeenSkillStatesWithCompactionReset,
  parseLikelySkills,
  compileSkillPatterns,
  matchPathWithReason,
  matchBashWithReason,
  matchImportWithReason,
  rankEntries,
  buildDocsBlock,
} from "./patterns.mjs";
import type { CompiledSkillEntry, CompiledPattern, CompileCallbacks, ManifestSkill } from "./patterns.mjs";
import { createSkillStore } from "./skill-store.mjs";
import type { ResolvedSkillPayload, SkillStore } from "./skill-store.mjs";
import { resolveProjectStatePaths, resolveVercelPluginHome } from "./project-state-paths.mjs";
import { resolveVercelJsonSkills, isVercelJsonPath, VERCEL_JSON_SKILLS } from "./vercel-config.mjs";
import type { VercelJsonRouting } from "./vercel-config.mjs";
import { createLogger, logDecision } from "./logger.mjs";
import type { Logger } from "./logger.mjs";
import { trackBaseEvents } from "./telemetry.mjs";

const MAX_SKILLS = 10;
const DEFAULT_INJECTION_BUDGET_BYTES = 100_000;
const SETUP_MODE_BOOTSTRAP_SKILL = "bootstrap";
const SETUP_MODE_PRIORITY_BOOST = 50;
const PLUGIN_ROOT = resolvePluginRoot();
const SUPPORTED_TOOLS = ["Read", "Edit", "Write", "Bash"];

// TSX review trigger constants
const TSX_REVIEW_SKILL = "react-best-practices";
const DEFAULT_REVIEW_THRESHOLD = 3;
const TSX_REVIEW_PRIORITY_BOOST = 40;
const REVIEW_MARKER = "<!-- marker:review-injected -->";
const TSX_EDIT_COUNT_SESSION_KEY = "tsx-edit-count";

// Dev-server verification constants
const DEV_SERVER_VERIFY_SKILL = "agent-browser-verify";
const DEV_SERVER_VERIFY_PRIORITY_BOOST = 45;
const DEV_SERVER_VERIFY_MAX_ITERATIONS = 2;
const DEV_SERVER_VERIFY_MARKER = "<!-- marker:dev-server-verify -->";
const DEV_VERIFY_COUNT_SESSION_KEY = "dev-verify-count";

// Companion skills co-injected alongside agent-browser-verify on dev server detection.
// These share the same iteration guard and loop-guard bypass logic.
const DEV_SERVER_COMPANION_SKILLS: string[] = ["verification"];
const DEV_SERVER_UNAVAILABLE_WARNING = `<!-- agent-browser-unavailable -->
**Recommendation: Install agent-browser for automatic verification**

We detected a dev server starting. Normally, after several files have been changed, we run \`agent-browser\` to do a browser verification pass — checking that pages load correctly, there are no console errors, and UI elements render as expected. This catches visual regressions and runtime issues that static analysis misses.

\`agent-browser\` is not currently installed. To enable automatic browser verification:

\`\`\`bash
npm install -g agent-browser && agent-browser install
\`\`\`

**Tell the user**: "I'd normally run a browser verification pass at this point to make sure everything looks right, but \`agent-browser\` isn't installed yet. You can install it globally with \`npm install -g agent-browser && agent-browser install\` — it takes about a minute and lets me visually verify your app after changes."
<!-- /agent-browser-unavailable -->`;
const VERCEL_ENV_HELP_ONCE_KEY = 'vercel-env-help';
const VERCEL_ENV_COMMAND = /\bvercel\s+env\s+(add|update|pull)\b/;
const VERCEL_ENV_HELP = `<!-- vercel-env-help -->
**Vercel env quick reference**
- Add and paste the value at the prompt: vercel env add NAME production
- Add from stdin/file: vercel env add NAME production < .env-value
- Branch-specific preview var: vercel env add NAME preview feature-branch
- Update an existing variable: vercel env update NAME production
- Pull cloud envs locally after changes: vercel env pull .env.local --yes
- Do NOT pass NAME=value as a positional argument. vercel env add reads the value from stdin or from the interactive prompt.
<!-- /vercel-env-help -->`;

/**
 * Regex patterns to detect dev-server startup commands.
 * These match the same patterns as agent-browser-verify's bashPatterns
 * plus vercel.json devCommand support via env var.
 */
const DEV_SERVER_PATTERNS: RegExp[] = [
  /\bnext\s+dev\b/,
  /\bnpm\s+run\s+dev\b/,
  /\bpnpm\s+dev\b/,
  /\bbun\s+(run\s+)?dev\b/,
  /\byarn\s+dev\b/,
  /\bvite\s+dev\b/,
  /\bvite\b(?!.*build)/,
  /\bnuxt\s+dev\b/,
  /\bvercel\s+dev\b/,
  /\bastro\s+dev\b/,
];

/** Resolve the injection byte budget from env or default. */
function getInjectionBudget(): number {
  const envVal = process.env.VERCEL_PLUGIN_INJECTION_BUDGET;
  if (envVal != null && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INJECTION_BUDGET_BYTES;
}

// ---------------------------------------------------------------------------
// Logger (replaces boolean DEBUG flag)
// ---------------------------------------------------------------------------

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// TSX review trigger: session-file-backed edit counter
// ---------------------------------------------------------------------------

/** Get the configured review threshold from env or default. */
export function getReviewThreshold(): number {
  const envVal = process.env.VERCEL_PLUGIN_REVIEW_THRESHOLD;
  if (envVal != null && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_REVIEW_THRESHOLD;
}

function parsePersistentCounter(raw: string | undefined): number {
  if (raw == null || raw === "") return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function readPersistentCounter(
  sessionId: string | undefined,
  sessionKey: string,
  envKey: keyof NodeJS.ProcessEnv,
): number {
  if (sessionId) {
    const sessionValue = readSessionFile(sessionId, sessionKey);
    if (sessionValue !== "") {
      return parsePersistentCounter(sessionValue);
    }
  }

  return parsePersistentCounter(process.env[envKey]);
}

function writePersistentCounter(
  sessionId: string | undefined,
  sessionKey: string,
  envKey: keyof NodeJS.ProcessEnv,
  value: number,
): void {
  const nextValue = String(value);
  process.env[envKey] = nextValue;
  if (sessionId) {
    writeSessionFile(sessionId, sessionKey, nextValue);
  }
}

/** Read current TSX edit count from session file or env fallback. */
function getTsxEditCount(sessionId?: string): number {
  return readPersistentCounter(sessionId, TSX_EDIT_COUNT_SESSION_KEY, "VERCEL_PLUGIN_TSX_EDIT_COUNT");
}

/** Increment and persist TSX edit count. Returns new count. */
function incrementTsxEditCount(sessionId?: string): number {
  const next = getTsxEditCount(sessionId) + 1;
  writePersistentCounter(sessionId, TSX_EDIT_COUNT_SESSION_KEY, "VERCEL_PLUGIN_TSX_EDIT_COUNT", next);
  return next;
}

/** Reset TSX edit count after review injection. */
function resetTsxEditCount(sessionId?: string): void {
  writePersistentCounter(sessionId, TSX_EDIT_COUNT_SESSION_KEY, "VERCEL_PLUGIN_TSX_EDIT_COUNT", 0);
}

/** Check if the current tool call is an Edit/Write on a .tsx file. */
function isTsxEditTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "Edit" && toolName !== "Write") return false;
  const filePath = (toolInput.file_path as string) || "";
  return /\.tsx$/.test(filePath);
}

/** Check if the current tool call targets a client-side React file (not an API route/server action). */
function isClientReactFile(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "Write" && toolName !== "Edit") return false;
  const filePath = (toolInput.file_path as string) || "";
  if (!/\.[jt]sx$/.test(filePath)) return false;
  return !/\/(api|actions)\//.test(filePath) && !/\broute\.[jt]sx?$/.test(filePath);
}

export interface TsxReviewTriggerResult {
  triggered: boolean;
  count: number;
  threshold: number;
  debounced: boolean;
}
export type { HookPlatform };

const RUNTIME_ENV_KEYS = [
  "VERCEL_PLUGIN_CONTEXT_COMPACTED",
  "VERCEL_PLUGIN_SEEN_SKILLS",
  "VERCEL_PLUGIN_TSX_EDIT_COUNT",
  "VERCEL_PLUGIN_DEV_VERIFY_COUNT",
] as const;

type RuntimeEnvKey = (typeof RUNTIME_ENV_KEYS)[number];

export type RuntimeEnvSnapshot = Record<RuntimeEnvKey, string | undefined>;
export type RuntimeEnvUpdates = Partial<Record<RuntimeEnvKey, string>>;

export interface CoInjectApplication {
  sourceSkill: string;
  targetSkill: string;
  mode: "force" | "prefer";
}

export interface ApplyCoInjectRulesOptions {
  rankedSkills: string[];
  /** All skills that matched patterns, including those capped/deduped out of rankedSkills. */
  allMatchedSkills?: string[];
  skillMap: Record<string, SkillConfig>;
  projectFacts: Set<string>;
  runtimeFacts: Set<string>;
  injectedSkills: Set<string>;
  matched?: Set<string>;
  forceSummarySkills?: Set<string>;
  maxSkills?: number;
  dedupOff?: boolean;
  logger?: Logger;
}

export interface ApplyCoInjectRulesResult {
  rankedSkills: string[];
  applied: CoInjectApplication[];
  evictedSkills: string[];
}

export function captureRuntimeEnvSnapshot(env: NodeJS.ProcessEnv = process.env): RuntimeEnvSnapshot {
  return {
    VERCEL_PLUGIN_CONTEXT_COMPACTED: env.VERCEL_PLUGIN_CONTEXT_COMPACTED,
    VERCEL_PLUGIN_SEEN_SKILLS: env.VERCEL_PLUGIN_SEEN_SKILLS,
    VERCEL_PLUGIN_TSX_EDIT_COUNT: env.VERCEL_PLUGIN_TSX_EDIT_COUNT,
    VERCEL_PLUGIN_DEV_VERIFY_COUNT: env.VERCEL_PLUGIN_DEV_VERIFY_COUNT,
  };
}

export function collectRuntimeEnvUpdates(
  before: RuntimeEnvSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeEnvUpdates {
  const updates: RuntimeEnvUpdates = {};

  for (const key of RUNTIME_ENV_KEYS) {
    const next = env[key];
    if (typeof next === "string" && next !== before[key]) {
      updates[key] = next;
    }
  }

  return updates;
}

export function parseFactSet(value: string | undefined): Set<string> {
  if (!value) return new Set<string>();
  return new Set(
    value
      .split(",")
      .map((fact) => fact.trim())
      .filter((fact) => fact !== ""),
  );
}

function matchesCoInjectWhen(
  when: NonNullable<NonNullable<SkillConfig["coInject"]>[number]["when"]> | undefined,
  projectFacts: Set<string>,
  runtimeFacts: Set<string>,
): boolean {
  if (!when) return true;
  if (when.allProjectFacts && !when.allProjectFacts.every((fact) => projectFacts.has(fact))) {
    return false;
  }
  if (when.allRuntimeFacts && !when.allRuntimeFacts.every((fact) => runtimeFacts.has(fact))) {
    return false;
  }
  return true;
}

export function applyCoInjectRules({
  rankedSkills,
  allMatchedSkills,
  skillMap,
  projectFacts,
  runtimeFacts,
  injectedSkills,
  matched,
  forceSummarySkills,
  maxSkills = MAX_SKILLS,
  dedupOff = false,
  logger,
}: ApplyCoInjectRulesOptions): ApplyCoInjectRulesResult {
  const l = logger || log;
  const nextRanked = [...rankedSkills];
  const forcedSkills = new Set<string>();
  const applied: CoInjectApplication[] = [];
  const evictedSkills: string[] = [];

  const moveAdjacentToSource = (sourceSkill: string, targetSkill: string): void => {
    const existingIndex = nextRanked.indexOf(targetSkill);
    if (existingIndex !== -1) {
      nextRanked.splice(existingIndex, 1);
    }
    const sourceIndex = nextRanked.indexOf(sourceSkill);
    nextRanked.splice(sourceIndex === -1 ? nextRanked.length : sourceIndex + 1, 0, targetSkill);
  };

  // Check coInject rules for ALL matched skills (including those capped out
  // of rankedSkills). A skill like ai-sdk may match via import pattern but
  // get capped — its coInject rules should still fire to bring in ai-gateway.
  const skillsToCheck = allMatchedSkills && allMatchedSkills.length > 0
    ? [...new Set([...nextRanked, ...allMatchedSkills])]
    : nextRanked;

  for (const sourceSkill of skillsToCheck) {
    const rules = skillMap[sourceSkill]?.coInject;
    if (!rules || rules.length === 0) continue;

    for (const rule of rules) {
      if (!matchesCoInjectWhen(rule.when, projectFacts, runtimeFacts)) continue;

      const targetSkill = rule.targetSkill;
      const alreadyPresent = nextRanked.includes(targetSkill);
      if (alreadyPresent && rule.mode === "prefer") continue;

      if (!dedupOff && injectedSkills.has(targetSkill) && forceSummarySkills) {
        forceSummarySkills.add(targetSkill);
      }

      if (rule.mode === "force") {
        forcedSkills.add(targetSkill);
      }

      if (!alreadyPresent) {
        moveAdjacentToSource(sourceSkill, targetSkill);
        matched?.add(targetSkill);
      } else if (rule.mode === "force") {
        moveAdjacentToSource(sourceSkill, targetSkill);
      }

      if (rule.mode === "prefer" && nextRanked.length > maxSkills) {
        const insertedIndex = nextRanked.indexOf(targetSkill);
        if (insertedIndex !== -1 && !alreadyPresent) {
          nextRanked.splice(insertedIndex, 1);
        }
        l.debug("coinject-prefer-skipped-cap", { sourceSkill, targetSkill, maxSkills });
        continue;
      }

      applied.push({ sourceSkill, targetSkill, mode: rule.mode });
      l.debug("coinject-applied", { sourceSkill, targetSkill, mode: rule.mode });

      while (nextRanked.length > maxSkills) {
        let evictIndex = -1;
        for (let candidateIndex = nextRanked.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
          const candidate = nextRanked[candidateIndex];
          if (forcedSkills.has(candidate)) continue;
          evictIndex = candidateIndex;
          break;
        }
        if (evictIndex === -1) {
          break;
        }
        const [evicted] = nextRanked.splice(evictIndex, 1);
        evictedSkills.push(evicted);
        if (!dedupOff && injectedSkills.has(evicted) && forceSummarySkills) {
          forceSummarySkills.add(evicted);
        }
        l.debug("coinject-evicted", { sourceSkill, targetSkill, evictedSkill: evicted, mode: rule.mode });
      }
    }
  }

  return { rankedSkills: nextRanked, applied, evictedSkills };
}

function finalizeRuntimeEnvUpdates(
  platform: HookPlatform,
  before: RuntimeEnvSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeEnvUpdates | undefined {
  if (platform !== "cursor") return undefined;

  const updates = collectRuntimeEnvUpdates(before, env);
  return Object.keys(updates).length > 0 ? updates : undefined;
}

/**
 * Check and potentially trigger TSX review injection.
 * Increments counter on .tsx edits, triggers when threshold reached.
 *
 * Dedup bypass: This trigger is decoupled from SEEN_SKILLS dedup.
 * The counter resets after each injection, so re-injection happens naturally
 * when the counter reaches the threshold again — even if the slug is already
 * in SEEN_SKILLS. The counter itself prevents duplicate injection within a cycle.
 */
export function checkTsxReviewTrigger(
  toolName: string,
  toolInput: Record<string, unknown>,
  _injectedSkills: Set<string>,
  dedupOff: boolean,
  sessionId?: string,
  logger?: Logger,
): TsxReviewTriggerResult {
  const l = logger || log;
  const threshold = getReviewThreshold();

  // Disabled when dedup is off
  if (dedupOff) {
    l.debug("tsx-review-not-fired", { reason: "dedup-off" });
    return { triggered: false, count: 0, threshold, debounced: false };
  }

  // Only count Edit/Write on .tsx files
  if (!isTsxEditTool(toolName, toolInput)) {
    l.debug("tsx-review-not-fired", { reason: "not-tsx-edit", tool: toolName });
    return { triggered: false, count: getTsxEditCount(sessionId), threshold, debounced: false };
  }

  const prevCount = getTsxEditCount(sessionId);
  const count = incrementTsxEditCount(sessionId);
  const delta = count - prevCount;
  l.debug("tsx-edit-count", { count, threshold, file: (toolInput.file_path as string) || "" });
  l.trace("tsx-edit-counter-state", { previous: prevCount, current: count, delta, threshold, remaining: Math.max(0, threshold - count), file: (toolInput.file_path as string) || "" });

  if (count >= threshold) {
    l.debug("tsx-review-triggered", { count, threshold });
    return { triggered: true, count, threshold, debounced: false };
  }

  l.debug("tsx-review-not-fired", { reason: "below-threshold", count, threshold });
  return { triggered: false, count, threshold, debounced: false };
}

// ---------------------------------------------------------------------------
// Dev-server verification trigger
// ---------------------------------------------------------------------------

/** Read current dev-server verify iteration count from session file or env fallback. */
export function getDevServerVerifyCount(sessionId?: string): number {
  return readPersistentCounter(sessionId, DEV_VERIFY_COUNT_SESSION_KEY, "VERCEL_PLUGIN_DEV_VERIFY_COUNT");
}

/** Increment and persist dev-server verify count. Returns new count. */
export function incrementDevServerVerifyCount(sessionId?: string): number {
  const next = getDevServerVerifyCount(sessionId) + 1;
  writePersistentCounter(sessionId, DEV_VERIFY_COUNT_SESSION_KEY, "VERCEL_PLUGIN_DEV_VERIFY_COUNT", next);
  return next;
}

/** Reset dev-server verify count. */
export function resetDevServerVerifyCount(sessionId?: string): void {
  writePersistentCounter(sessionId, DEV_VERIFY_COUNT_SESSION_KEY, "VERCEL_PLUGIN_DEV_VERIFY_COUNT", 0);
}

/** Check if a Bash command is a dev-server startup command. */
export function isDevServerCommand(command: string): boolean {
  if (!command) return false;
  // Check vercel.json devCommand if set
  const devCommand = process.env.VERCEL_PLUGIN_DEV_COMMAND;
  if (devCommand && command.includes(devCommand)) return true;
  return DEV_SERVER_PATTERNS.some((re) => re.test(command));
}

export interface DevServerVerifyResult {
  triggered: boolean;
  unavailable: boolean;
  loopGuardHit: boolean;
  iterationCount: number;
}

/**
 * Check if dev-server verification should be injected.
 * Triggers when a Bash command matches dev-server patterns.
 * Loop guard: max DEV_SERVER_VERIFY_MAX_ITERATIONS per session.
 * Graceful degradation: if agent-browser is unavailable, returns unavailable=true.
 *
 * Dedup bypass: This trigger is decoupled from SEEN_SKILLS dedup.
 * The iteration counter (DEV_VERIFY_COUNT) is the sole gate — it allows
 * re-injection up to MAX_ITERATIONS even when the slug is in SEEN_SKILLS.
 * The loop guard (count >= max) is the hard stop.
 */
export function checkDevServerVerify(
  toolName: string,
  toolInput: Record<string, unknown>,
  _injectedSkills: Set<string>,
  _dedupOff: boolean,
  sessionId?: string,
  logger?: Logger,
): DevServerVerifyResult {
  const l = logger || log;
  const noResult: DevServerVerifyResult = { triggered: false, unavailable: false, loopGuardHit: false, iterationCount: 0 };

  // Only applies to Bash commands
  if (toolName !== "Bash") {
    l.debug("dev-server-verify-not-fired", { reason: "not-bash", tool: toolName });
    return noResult;
  }

  const command = (toolInput.command as string) || "";
  if (!isDevServerCommand(command)) {
    l.debug("dev-server-verify-not-fired", { reason: "not-dev-server-command" });
    return noResult;
  }

  l.debug("dev-server-detected", { command: command.slice(0, 100) });

  // Check agent-browser availability
  const available = process.env.VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE;
  if (available === "0") {
    l.debug("dev-server-verify-not-fired", { reason: "agent-browser-unavailable" });
    l.debug("dev-server-verify-unavailable", { reason: "agent-browser not installed" });
    return { triggered: false, unavailable: true, loopGuardHit: false, iterationCount: 0 };
  }

  // Loop guard: max iterations (hard stop, regardless of dedup state)
  const count = getDevServerVerifyCount(sessionId);
  l.trace("dev-server-verify-counter-state", { current: count, max: DEV_SERVER_VERIFY_MAX_ITERATIONS, remaining: Math.max(0, DEV_SERVER_VERIFY_MAX_ITERATIONS - count), command: command.slice(0, 100) });
  if (count >= DEV_SERVER_VERIFY_MAX_ITERATIONS) {
    l.debug("dev-server-verify-not-fired", { reason: "loop-guard", count, max: DEV_SERVER_VERIFY_MAX_ITERATIONS });
    l.debug("dev-server-verify-loop-guard", { count, max: DEV_SERVER_VERIFY_MAX_ITERATIONS });
    return { triggered: false, unavailable: false, loopGuardHit: true, iterationCount: count };
  }

  l.debug("dev-server-verify-triggered", { iterationCount: count });
  return { triggered: true, unavailable: false, loopGuardHit: false, iterationCount: count };
}

export interface VercelEnvHelpResult {
  triggered: boolean;
  subcommand?: string;
}

function checkVercelEnvHelp(
  toolName: string,
  toolInput: Record<string, unknown>,
  injectedSkills: Set<string>,
  dedupOff: boolean,
  logger?: Logger,
): VercelEnvHelpResult {
  const l = logger || log;

  if (toolName !== "Bash") {
    l.debug("vercel-env-help-not-fired", { reason: "not-bash", tool: toolName });
    return { triggered: false };
  }

  const command = (toolInput.command as string) || "";
  const match = command.match(VERCEL_ENV_COMMAND);
  if (!match) {
    l.debug("vercel-env-help-not-fired", { reason: "no-command-match" });
    return { triggered: false };
  }

  if (!dedupOff && injectedSkills.has(VERCEL_ENV_HELP_ONCE_KEY)) {
    l.debug("vercel-env-help-not-fired", { reason: "already-shown", subcommand: match[1] });
    return { triggered: false };
  }

  l.debug("vercel-env-help-triggered", { subcommand: match[1] });
  return { triggered: true, subcommand: match[1] };
}

// ---------------------------------------------------------------------------
// Pipeline stage 1: parseInput
// ---------------------------------------------------------------------------

export interface ParsedInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId: string;
  cwd: string;
  platform: HookPlatform;
  toolTarget: string;
  /** Agent-scoped dedup: present when running inside a subagent. */
  scopeId: string | undefined;
}

/**
 * Parse raw stdin JSON into a normalized input descriptor.
 * Returns null if input is empty or unparseable.
 */
export function parseInput(
  raw: string,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
): ParsedInput | null {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    l.issue("STDIN_EMPTY", "No data received on stdin", "Ensure the hook receives JSON on stdin with tool_name, tool_input, session_id", {});
    l.complete("stdin_empty");
    return null;
  }

  let input: unknown;
  try {
    input = JSON.parse(trimmed);
  } catch (err) {
    l.issue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON with tool_name, tool_input, session_id fields", { error: String(err) });
    l.complete("stdin_parse_fail");
    return null;
  }

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    l.issue("STDIN_NOT_OBJECT", "Parsed stdin JSON was not an object", "Send a JSON object payload with tool_name and tool_input fields", { inputType: typeof input });
    l.complete("stdin_not_object");
    return null;
  }

  const parsed = input as Record<string, unknown>;
  const workspaceRoot = Array.isArray(parsed.workspace_roots) && typeof parsed.workspace_roots[0] === "string"
    ? parsed.workspace_roots[0]
    : undefined;
  const toolName = (parsed.tool_name as string) || "";
  const toolInput = (parsed.tool_input as Record<string, unknown>) || {};
  const platform = detectPlatform(parsed);
  const sessionId = typeof (parsed.session_id ?? parsed.conversation_id) === "string"
    ? (parsed.session_id ?? parsed.conversation_id) as string
    : "";
  const cwdCandidate = parsed.cwd
    ?? workspaceRoot
    ?? env.CURSOR_PROJECT_DIR
    ?? env.CLAUDE_PROJECT_ROOT
    ?? process.cwd();
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : process.cwd();
  const toolTarget = toolName === "Bash"
    ? ((toolInput.command as string) || "")
    : ((toolInput.file_path as string) || "");

  // Extract agent_id for scoped dedup (present when running inside a subagent)
  const agentId = typeof parsed.agent_id === "string" && parsed.agent_id.length > 0
    ? parsed.agent_id
    : undefined;
  const scopeId = agentId;

  l.debug("input-parsed", { toolName, sessionId: sessionId as string, cwd, platform, scopeId });
  l.debug("tool-target", { toolName, target: redactCommand(toolTarget) });

  return { toolName, toolInput, sessionId, cwd, platform, toolTarget, scopeId };
}

// ---------------------------------------------------------------------------
// Pipeline stage 2: loadSkills
// ---------------------------------------------------------------------------

export interface LoadedSkills {
  skillMap: Record<string, SkillConfig>;
  compiledSkills: CompiledSkillEntry[];
  usedManifest: boolean;
  skillStore: SkillStore;
}

/**
 * Load the skill map from the skill store (cache-first: project → global → bundled).
 * Returns null if the skill map cannot be loaded or is empty.
 *
 * The third parameter `projectRoot` defaults to `process.cwd()` and controls
 * where the store looks for the hashed project cache.
 */
export function loadSkills(pluginRoot?: string, logger?: Logger, projectRoot?: string): LoadedSkills | null {
  const root = pluginRoot || PLUGIN_ROOT;
  const l = logger || log;

  const skillStore = createSkillStore({
    projectRoot: projectRoot ?? process.cwd(),
    pluginRoot: root,
    includeRulesManifest: process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
  });

  const effectiveProjectRoot = projectRoot ?? process.cwd();
  const statePaths = resolveProjectStatePaths(effectiveProjectRoot);
  const globalCacheDir = join(resolveVercelPluginHome(), "skills");

  const loaded = skillStore.loadSkillSet(l);
  if (!loaded || Object.keys(loaded.skillMap).length === 0) {
    l.issue(
      "SKILLMAP_EMPTY",
      "No skills were available from the project cache, shared global cache, or shipped rules manifest",
      `Install skills into ${statePaths.skillsDir} or ${globalCacheDir}. Until a body is cached, only the shipped summary can be injected.`,
      {
        projectRoot: effectiveProjectRoot,
        pluginRoot: root,
        stateRoot: statePaths.stateRoot,
        skillsDir: statePaths.skillsDir,
        globalCacheDir,
        roots: skillStore.roots.map((r) => ({
          source: r.source,
          rootDir: r.rootDir,
        })),
      },
    );
    l.complete("skillmap_fail");
    return null;
  }

  l.debug("skillmap-loaded", {
    skillCount: Object.keys(loaded.skillMap).length,
    usedManifest: loaded.usedManifest,
    roots: loaded.roots.map((r) => ({
      source: r.source,
      rootDir: r.rootDir,
    })),
  });

  return {
    skillMap: loaded.skillMap,
    compiledSkills: loaded.compiledSkills,
    usedManifest: loaded.usedManifest,
    skillStore,
  };
}

// ---------------------------------------------------------------------------
// Pipeline stage 3: matchSkills
// ---------------------------------------------------------------------------

export interface MatchResult {
  matchedEntries: CompiledSkillEntry[];
  matchReasons: Record<string, { pattern: string; matchType: string }>;
  matched: Set<string>;
}

/**
 * Match a tool call against compiled skill patterns.
 * Returns null if the tool is not supported.
 */
export function matchSkills(
  toolName: string,
  toolInput: Record<string, unknown>,
  compiledSkills: CompiledSkillEntry[],
  logger?: Logger,
): MatchResult | null {
  const l = logger || log;

  if (!SUPPORTED_TOOLS.includes(toolName)) {
    l.complete("tool_unsupported");
    return null;
  }

  const matchedEntries: CompiledSkillEntry[] = [];
  const matchReasons: Record<string, { pattern: string; matchType: string }> = {};

  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = (toolInput.file_path as string) || "";
    // Gather available file content from tool input for import matching
    const contentParts: string[] = [];
    if (toolInput.content) contentParts.push(toolInput.content as string);
    if (toolInput.old_string) contentParts.push(toolInput.old_string as string);
    if (toolInput.new_string) contentParts.push(toolInput.new_string as string);
    const fileContent = contentParts.join("\n");

    for (const entry of compiledSkills) {
      l.trace("pattern-eval-start", { skill: entry.skill, target: filePath, patternCount: entry.compiledPaths.length });
      const reason = matchPathWithReason(filePath, entry.compiledPaths);
      l.trace("pattern-eval-result", { skill: entry.skill, matched: !!reason, reason: reason || (null as unknown as string) });
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      } else if (fileContent && entry.compiledImports && entry.compiledImports.length > 0) {
        // Fall back to import matching when path matching produces no hit
        const importReason = matchImportWithReason(fileContent, entry.compiledImports);
        l.trace("import-eval-result", { skill: entry.skill, matched: !!importReason, reason: importReason || (null as unknown as string) });
        if (importReason) {
          matchedEntries.push(entry);
          matchReasons[entry.skill] = importReason;
        }
      }
    }
  } else if (toolName === "Bash") {
    const command = (toolInput.command as string) || "";
    for (const entry of compiledSkills) {
      l.trace("pattern-eval-start", { skill: entry.skill, target: redactCommand(command), patternCount: entry.compiledBash.length });
      const reason = matchBashWithReason(command, entry.compiledBash);
      l.trace("pattern-eval-result", { skill: entry.skill, matched: !!reason, reason: reason || (null as unknown as string) });
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  }

  const matched = new Set(matchedEntries.map((e) => e.skill));
  l.debug("matches-found", { matched: [...matched], reasons: matchReasons as unknown as Record<string, unknown> });

  return { matchedEntries, matchReasons, matched };
}

// ---------------------------------------------------------------------------
// Pipeline stage 4: deduplicateSkills
// ---------------------------------------------------------------------------

export interface DeduplicateParams {
  matchedEntries: CompiledSkillEntry[];
  matched: Set<string>;
  toolName: string;
  toolInput: Record<string, unknown>;
  injectedSkills: Set<string>;
  dedupOff: boolean;
  maxSkills?: number;
  likelySkills?: Set<string>;
  compiledSkills?: CompiledSkillEntry[];
  setupMode?: boolean;
}

export interface SetupModeRouting {
  active: boolean;
  synthetic: boolean;
  skippedAsSeen: boolean;
}

export interface DeduplicateResult {
  newEntries: CompiledSkillEntry[];
  rankedSkills: string[];
  vercelJsonRouting: VercelJsonRouting | null;
  profilerBoosted: string[];
  setupModeRouting: SetupModeRouting | null;
}

/**
 * Filter already-seen skills, apply vercel.json key-aware routing and profiler boost, rank, and cap.
 */
export function deduplicateSkills(
  { matchedEntries, matched, toolName, toolInput, injectedSkills, dedupOff, maxSkills, likelySkills, compiledSkills, setupMode }: DeduplicateParams,
  logger?: Logger,
): DeduplicateResult {
  const l = logger || log;
  const cap = maxSkills ?? MAX_SKILLS;
  const likely = likelySkills || new Set<string>();
  const setupModeActive = setupMode === true;

  // Filter out already-injected skills
  let newEntries = dedupOff
    ? matchedEntries
    : matchedEntries.filter((e) => !injectedSkills.has(e.skill));

  // vercel.json key-aware routing
  let vercelJsonRouting: VercelJsonRouting | null = null;
  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = (toolInput.file_path as string) || "";
    if (isVercelJsonPath(filePath)) {
      const resolved = resolveVercelJsonSkills(filePath);
      if (resolved) {
        vercelJsonRouting = resolved;
        l.debug("vercel-json-routing", {
          keys: resolved.keys,
          relevantSkills: [...resolved.relevantSkills],
        });
        for (const entry of newEntries) {
          if (!VERCEL_JSON_SKILLS.has(entry.skill)) continue;
          if (resolved.relevantSkills.size === 0) continue;
          if (resolved.relevantSkills.has(entry.skill)) {
            entry.effectivePriority = entry.priority + 10;
          } else {
            entry.effectivePriority = entry.priority - 10;
          }
        }
      }
    }
  }

  // Profiler boost: skills identified by session-start profiler get +5 priority
  const profilerBoosted: string[] = [];
  if (likely.size > 0) {
    for (const entry of newEntries) {
      if (likely.has(entry.skill)) {
        const base = typeof entry.effectivePriority === "number" ? entry.effectivePriority : entry.priority;
        entry.effectivePriority = base + 5;
        profilerBoosted.push(entry.skill);
      }
    }
    if (profilerBoosted.length > 0) {
      l.debug("profiler-boosted", {
        likelySkills: [...likely],
        boostedSkills: profilerBoosted,
      });
    }
  }

  // Setup-mode routing: synthesize and boost bootstrap on first relevant tool call.
  let setupModeRouting: SetupModeRouting | null = null;
  if (setupModeActive) {
    setupModeRouting = { active: true, synthetic: false, skippedAsSeen: false };

    if (!dedupOff && injectedSkills.has(SETUP_MODE_BOOTSTRAP_SKILL)) {
      setupModeRouting.skippedAsSeen = true;
      l.debug("setup-mode-bootstrap-skip", { reason: "already_injected" });
    } else {
      let bootstrapEntry = newEntries.find((e) => e.skill === SETUP_MODE_BOOTSTRAP_SKILL);
      if (!bootstrapEntry) {
        const bootstrapTemplate = Array.isArray(compiledSkills)
          ? compiledSkills.find((entry) => entry.skill === SETUP_MODE_BOOTSTRAP_SKILL)
          : null;
        bootstrapEntry = bootstrapTemplate
          ? { ...bootstrapTemplate }
          : {
            skill: SETUP_MODE_BOOTSTRAP_SKILL,
            priority: 0,
            compiledPaths: [],
            compiledBash: [],
            compiledImports: [],
          };
        newEntries.push(bootstrapEntry);
        matched.add(SETUP_MODE_BOOTSTRAP_SKILL);
        setupModeRouting.synthetic = true;
      }

      const maxPriority = newEntries.reduce((max, entry) => {
        const value = typeof entry.effectivePriority === "number"
          ? entry.effectivePriority
          : entry.priority;
        return Math.max(max, typeof value === "number" ? value : 0);
      }, 0);
      const basePriority = typeof bootstrapEntry.effectivePriority === "number"
        ? bootstrapEntry.effectivePriority
        : bootstrapEntry.priority;

      bootstrapEntry.effectivePriority = Math.max(
        (typeof basePriority === "number" ? basePriority : 0) + SETUP_MODE_PRIORITY_BOOST,
        maxPriority + 1,
      );

      l.debug("setup-mode-bootstrap-routing", {
        synthetic: setupModeRouting.synthetic,
        effectivePriority: bootstrapEntry.effectivePriority,
      });
    }
  }

  // Sort by effectivePriority (if set) or priority DESC, then skill name ASC
  newEntries = rankEntries(newEntries);

  const rankedSkills = newEntries.map((e) => e.skill);

  // Emit skill_ranked for each candidate in priority order
  for (const entry of newEntries) {
    const eff = typeof entry.effectivePriority === "number" ? entry.effectivePriority : entry.priority;
    logDecision(l, {
      hook: "PreToolUse",
      event: "skill_ranked",
      skill: entry.skill,
      score: eff,
      reason: profilerBoosted.includes(entry.skill) ? "profiler_boosted" : "pattern_match",
    });
  }

  l.debug("dedup-filtered", {
    rankedSkills,
    previouslyInjected: [...injectedSkills],
  });

  return { newEntries, rankedSkills, vercelJsonRouting, profilerBoosted, setupModeRouting };
}

// ---------------------------------------------------------------------------
// Pipeline stage 5: injectSkills
// ---------------------------------------------------------------------------

export interface InjectOptions {
  pluginRoot?: string;
  projectRoot?: string;
  skillStore?: SkillStore;
  hasEnvDedup?: boolean;
  sessionId?: string | null;
  /** Agent-scoped dedup: isolates claims per subagent. */
  scopeId?: string;
  injectedSkills?: Set<string>;
  budgetBytes?: number;
  maxSkills?: number;
  skillMap?: Record<string, SkillConfig>;
  logger?: Logger;
  /** Skills that must be injected as summary-only (e.g. companion skills on dedup bypass). */
  forceSummarySkills?: Set<string>;
  /** Platform for formatting skill invocation instructions. */
  platform?: HookPlatform;
}

export interface InjectResult {
  parts: string[];
  loaded: string[];
  summaryOnly: string[];
  droppedByCap: string[];
  droppedByBudget: string[];
  skippedByConcurrentClaim: string[];
}

/**
 * Load SKILL.md files for the ranked skills, enforcing byte budget and MAX_SKILLS ceiling.
 * Skills are loaded in priority order until the next would exceed the budget or the ceiling.
 * When a full body would exceed the budget but a summary exists, the summary is injected instead.
 */
function skillInvocationMessage(skill: string, platform: HookPlatform): string {
  return platform === "cursor"
    ? `Load the /${skill} skill.`
    : `You must run the Skill(${skill}) tool.`;
}

function summaryFallbackText(
  payload: ResolvedSkillPayload,
  platform: HookPlatform,
): string {
  return [
    skillInvocationMessage(payload.skill, platform),
    payload.summary.trim() !== "" ? `Summary: ${payload.summary.trim()}` : null,
    payload.docs.length > 0 ? `Docs: ${payload.docs.join(", ")}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function injectSkills(rankedSkills: string[], options?: InjectOptions): InjectResult {
  const { pluginRoot, projectRoot, skillStore: optStore, hasEnvDedup, sessionId, scopeId, injectedSkills, budgetBytes, maxSkills, skillMap, logger, forceSummarySkills, platform: optPlatform } = options || {};
  const platform: HookPlatform = optPlatform ?? "claude-code";
  const root = pluginRoot || PLUGIN_ROOT;
  const l = logger || log;
  const budget = budgetBytes ?? getInjectionBudget();
  const ceiling = maxSkills ?? MAX_SKILLS;
  const store = optStore ?? createSkillStore({
    projectRoot: projectRoot ?? process.cwd(),
    pluginRoot: root,
    includeRulesManifest: process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
  });
  const parts: string[] = [];
  const loaded: string[] = [];
  const summaryOnly: string[] = [];
  const droppedByCap: string[] = [];
  const droppedByBudget: string[] = [];
  const skippedByConcurrentClaim: string[] = [];
  let usedBytes = 0;

  const canInjectSkill = (skill: string): boolean => {
    if (!hasEnvDedup || !sessionId) {
      return true;
    }

    const claimed = tryClaimSessionKey(sessionId, "seen-skills", skill, scopeId);
    if (!claimed) {
      skippedByConcurrentClaim.push(skill);
      l.debug("skill-skipped-concurrent-claim", { skill, sessionId, scopeId });
      return false;
    }

    syncSessionFileFromClaims(sessionId, "seen-skills", scopeId);
    return true;
  };

  for (const skill of rankedSkills) {
    // Hard ceiling check
    if (loaded.length >= ceiling) {
      droppedByCap.push(skill);
      logDecision(l, { hook: "PreToolUse", event: "skill_dropped", skill, reason: "cap_exceeded", score: ceiling });
      continue;
    }

    const payload = store.resolveSkillPayload(skill, l);
    if (!payload) {
      l.issue("SKILL_PAYLOAD_MISSING", `No cached body or shipped rules metadata found for skill "${skill}"`, `Install "${skill}" into ~/.vercel-plugin before retrying`, { skill });
      continue;
    }

    // Build injection text: full invocation message for body mode, summary fallback otherwise
    const wrapped = payload.mode === "summary"
      ? summaryFallbackText(payload, platform)
      : skillInvocationMessage(skill, platform);
    const byteLen = Buffer.byteLength(wrapped, "utf-8");

    // Budget check: always allow the first skill, then enforce budget
    if (loaded.length > 0 && usedBytes + byteLen > budget) {
      // Try summary-only fallback for body-mode skills over budget
      if (payload.mode === "body") {
        const summaryWrapped = summaryFallbackText(payload, platform);
        const summaryByteLen = Buffer.byteLength(summaryWrapped, "utf-8");
        if (usedBytes + summaryByteLen <= budget) {
          if (!canInjectSkill(skill)) {
            continue;
          }
          parts.push(summaryWrapped);
          loaded.push(skill);
          summaryOnly.push(skill);
          usedBytes += summaryByteLen;
          if (injectedSkills) injectedSkills.add(skill);
          l.debug("summary-fallback", { skill, fullBytes: byteLen, summaryBytes: summaryByteLen });
          continue;
        }
      }
      droppedByBudget.push(skill);
      logDecision(l, { hook: "PreToolUse", event: "budget_exhausted", skill, reason: "over_budget", budgetBytes: budget, usedBytes, skillBytes: byteLen });
      continue;
    }

    // Force summary-only for dedup-bypassed companion skills
    if (forceSummarySkills?.has(skill)) {
      const summaryWrapped = summaryFallbackText(payload, platform);
      const summaryByteLen = Buffer.byteLength(summaryWrapped, "utf-8");
      if (usedBytes + summaryByteLen <= budget || loaded.length === 0) {
        if (!canInjectSkill(skill)) {
          continue;
        }
        parts.push(summaryWrapped);
        loaded.push(skill);
        summaryOnly.push(skill);
        usedBytes += summaryByteLen;
        if (injectedSkills) injectedSkills.add(skill);
        l.debug("force-summary-companion", { skill, fullBytes: byteLen, summaryBytes: summaryByteLen });
        continue;
      }
    }

    if (!canInjectSkill(skill)) {
      continue;
    }
    parts.push(wrapped);
    loaded.push(skill);
    usedBytes += byteLen;
    if (injectedSkills) injectedSkills.add(skill);

    if (payload.mode === "summary") {
      summaryOnly.push(skill);
      l.debug("skill-summary-fallback", { skill, source: payload.source });
    }
  }

  if (droppedByCap.length > 0 || droppedByBudget.length > 0 || summaryOnly.length > 0 || skippedByConcurrentClaim.length > 0) {
    l.debug("cap-applied", {
      max: ceiling,
      budgetBytes: budget,
      usedBytes,
      totalCandidates: rankedSkills.length,
      selected: loaded.map((s) => ({ skill: s, mode: summaryOnly.includes(s) ? "summary" : "full" })),
      droppedByCap,
      droppedByBudget,
      summaryOnly,
      skippedByConcurrentClaim,
    });
  }

  l.debug("skills-injected", { injected: loaded, summaryOnly, skippedByConcurrentClaim, totalParts: parts.length, usedBytes, budgetBytes: budget });

  return { parts, loaded, summaryOnly, droppedByCap, droppedByBudget, skippedByConcurrentClaim };
}

// ---------------------------------------------------------------------------
// Pipeline stage 6: formatOutput
// ---------------------------------------------------------------------------

export interface SkillInjectionReason {
  trigger: string;
  reasonCode: string;
}

export interface FormatOutputParams {
  parts: string[];
  matched: Set<string>;
  injectedSkills: string[];
  summaryOnly?: string[];
  droppedByCap: string[];
  droppedByBudget?: string[];
  toolName: string;
  toolTarget: string;
  matchReasons?: Record<string, { pattern: string; matchType: string }>;
  reasons?: Record<string, SkillInjectionReason>;
  verificationId?: string;
  skillMap?: Record<string, { docs?: string[]; sitemap?: string }>;
  platform?: HookPlatform;
  env?: RuntimeEnvUpdates;
}

function formatPlatformOutput(
  platform: HookPlatform,
  additionalContext?: string,
  env?: RuntimeEnvUpdates,
): string {
  if (platform === "cursor") {
    const output: Record<string, unknown> = {};
    if (additionalContext) {
      output.additional_context = additionalContext;
    }
    if (env && Object.keys(env).length > 0) {
      output.env = env;
    }
    return Object.keys(output).length > 0 ? JSON.stringify(output) : "{}";
  }

  const output: Record<string, unknown> = {};

  if (additionalContext) {
    const hookSpecificOutput: SyncHookJSONOutput["hookSpecificOutput"] = {
      hookEventName: "PreToolUse" as const,
      additionalContext,
    };
    output.hookSpecificOutput = hookSpecificOutput;
  }

  if (env && Object.keys(env).length > 0) {
    output.env = env;
  }

  return Object.keys(output).length > 0 ? JSON.stringify(output) : "{}";
}

/**
 * Build the final JSON output string from injection results.
 */
/**
 * Build a human-readable banner describing why skills were auto-suggested.
 */
function buildBanner(
  injectedSkills: string[],
  toolName: string,
  toolTarget: string,
  matchReasons?: Record<string, { pattern: string; matchType: string }>,
): string {
  const lines: string[] = ["[vercel-plugin] Best practices auto-suggested based on detected patterns:"];

  for (const skill of injectedSkills) {
    const reason = matchReasons?.[skill];
    if (reason) {
      const target = toolName === "Bash" ? redactCommand(toolTarget) : toolTarget;
      lines.push(`  - "${skill}" matched ${reason.matchType} pattern \`${reason.pattern}\` on ${toolName}${target ? `: ${target}` : ""}`);
    } else {
      lines.push(`  - "${skill}"`);
    }
  }

  return lines.join("\n");
}

function encodeJsonForHtmlComment(value: unknown): string {
  return JSON.stringify(value).replace(/-->/g, "--\\u003E");
}

export function formatOutput({
  parts,
  matched,
  injectedSkills,
  summaryOnly,
  droppedByCap,
  droppedByBudget,
  toolName,
  toolTarget,
  matchReasons,
  reasons,
  verificationId,
  skillMap,
  platform = "claude-code",
  env,
}: FormatOutputParams): string {
  if (parts.length === 0) {
    return formatPlatformOutput(platform, undefined, env);
  }

  const skillInjection: Record<string, unknown> = {
    version: SKILL_INJECTION_VERSION,
    toolName,
    toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
    matchedSkills: [...matched],
    injectedSkills,
    summaryOnly: summaryOnly || [],
    droppedByCap,
    droppedByBudget: droppedByBudget || [],
  };
  if (reasons && Object.keys(reasons).length > 0) {
    skillInjection.reasons = reasons;
  }
  if (verificationId) {
    skillInjection.verificationId = verificationId;
  }

  // Embed injection metadata as an HTML comment inside additionalContext
  // (Claude Code validates hookSpecificOutput with a strict schema —
  //  extra keys like "skillInjection" cause validation failure)
  const metaComment = `<!-- skillInjection: ${encodeJsonForHtmlComment(skillInjection)} -->`;

  const banner = buildBanner(injectedSkills, toolName, toolTarget, matchReasons);
  const docsBlock = buildDocsBlock(injectedSkills, skillMap);

  const sections = [banner];
  if (docsBlock) sections.push(docsBlock);
  sections.push(parts.join("\n\n"));
  return formatPlatformOutput(platform, sections.join("\n\n") + "\n" + metaComment, env);
}

// ---------------------------------------------------------------------------
// Orchestrator: run() delegates to the pipeline stages
// ---------------------------------------------------------------------------

function run(): string {
  const timing: Record<string, number> = {};
  const tPhase = log.active ? log.now() : 0;

  // Stage 1: parseInput
  let raw: string;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
  const parsed = parseInput(raw, log);
  if (!parsed) return "{}";
  if (log.active) timing.stdin_parse = Math.round(log.now() - tPhase);

  const { toolName, toolInput, sessionId, cwd, platform, toolTarget, scopeId } = parsed;
  const runtimeEnvBefore = captureRuntimeEnvSnapshot();

  // Base telemetry — always-on (no opt-in required)
  if (sessionId) {
    const toolEntries: Array<{ key: string; value: string }> = [
      { key: "tool_call:tool_name", value: toolName },
      { key: "tool_call:target", value: toolTarget },
    ];
    if (toolName === "Bash") {
      toolEntries.push({ key: "tool_call:command", value: (toolInput.command as string) || "" });
    } else {
      toolEntries.push({ key: "tool_call:file_path", value: (toolInput.file_path as string) || "" });
    }
    trackBaseEvents(sessionId, toolEntries).catch(() => {});
  }

  // Stage 2: loadSkills (cache-first: project cache → global cache → rules manifest)
  const tSkillmap = log.active ? log.now() : 0;
  const skills = loadSkills(PLUGIN_ROOT, log, cwd);
  if (!skills) return "{}";
  if (log.active) timing.skillmap_load = Math.round(log.now() - tSkillmap);

  const { compiledSkills, usedManifest, skillStore } = skills;

  // Session dedup state
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasFileDedup = !dedupOff && !!sessionId;
  const seenEnv = typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string"
    ? process.env.VERCEL_PLUGIN_SEEN_SKILLS
    : "";
  const seenClaims = hasFileDedup ? listSessionKeys(sessionId, "seen-skills", scopeId).join(",") : "";
  const seenFile = hasFileDedup ? readSessionFile(sessionId, "seen-skills", scopeId) : "";
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
      skillMap: skills.skillMap,
    });
  const seenState = seenStateResult.seenState;
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const hasSeenSkillDedup = hasFileDedup || hasEnvDedup;
  const dedupStrategy = dedupOff ? "disabled" : hasFileDedup ? "file" : hasEnvDedup ? "env-var" : "memory-only";

  // Profiler likely-skills (set by session-start-profiler.mjs)
  const likelySkillsEnv = process.env.VERCEL_PLUGIN_LIKELY_SKILLS || "";
  const likelySkills = parseLikelySkills(likelySkillsEnv);
  const setupMode = process.env.VERCEL_PLUGIN_SETUP_MODE === "1";

  log.debug("dedup-strategy", { strategy: dedupStrategy, sessionId, seenEnv: seenState });
  if (seenStateResult.compactionResetApplied) {
    log.debug("dedup-compaction-reset", {
      sessionId,
      scopeId,
      threshold: COMPACTION_REINJECT_MIN_PRIORITY,
      clearedSkills: seenStateResult.clearedSkills,
    });
  }
  if (likelySkills.size > 0) {
    log.debug("likely-skills", { skills: [...likelySkills] });
  }
  if (setupMode) {
    log.debug("setup-mode", { active: true, bootstrapSkill: SETUP_MODE_BOOTSTRAP_SKILL });
  }

  const injectedSkills: Set<string> = dedupOff ? new Set() : parseSeenSkills(seenState);

  // Stage 3: matchSkills
  const tMatch = log.active ? log.now() : 0;
  const matchResult = matchSkills(toolName, toolInput, compiledSkills, log);
  if (!matchResult) return "{}";
  if (log.active) timing.match = Math.round(log.now() - tMatch);

  const { matchedEntries, matchReasons, matched } = matchResult;

  // Stage 3.5: TSX review trigger — check before dedup to inform synthetic injection
  const tsxReview = checkTsxReviewTrigger(toolName, toolInput, injectedSkills, dedupOff, sessionId, log);

  // Stage 3.6: Dev-server verification trigger
  const devServerVerify = checkDevServerVerify(toolName, toolInput, injectedSkills, dedupOff, sessionId, log);

  // Stage 3.7: Vercel env command quick-help trigger
  const vercelEnvHelp = checkVercelEnvHelp(toolName, toolInput, injectedSkills, dedupOff, log);

  // Stage 3.8: Boost agent-browser-verify and companion skills priority when dev-server detected
  if (devServerVerify.triggered) {
    const devServerBoostSkills = new Set([DEV_SERVER_VERIFY_SKILL, ...DEV_SERVER_COMPANION_SKILLS]);
    for (const entry of matchedEntries) {
      if (devServerBoostSkills.has(entry.skill)) {
        entry.effectivePriority = DEV_SERVER_VERIFY_PRIORITY_BOOST;
        log.debug("dev-server-verify-priority-boost", { skill: entry.skill, effectivePriority: entry.effectivePriority });
      }
    }
  }

  // Stage 4: deduplicateSkills
  const dedupResult = deduplicateSkills({
    matchedEntries,
    matched,
    toolName,
    toolInput,
    injectedSkills,
    dedupOff,
    likelySkills,
    compiledSkills,
    setupMode,
  }, log);

  const { newEntries, rankedSkills: dedupRankedSkills, profilerBoosted } = dedupResult;
  let rankedSkills = dedupRankedSkills;

  // Stage 4.5: Synthetically inject react-best-practices if TSX review triggered
  let tsxReviewInjected = false;
  if (tsxReview.triggered && !rankedSkills.includes(TSX_REVIEW_SKILL)) {
    // Find or create the react-best-practices entry
    const reviewTemplate = compiledSkills.find((e) => e.skill === TSX_REVIEW_SKILL);
    const reviewEntry: CompiledSkillEntry = reviewTemplate
      ? { ...reviewTemplate, effectivePriority: TSX_REVIEW_PRIORITY_BOOST }
      : {
          skill: TSX_REVIEW_SKILL,
          priority: 0,
          compiledPaths: [],
          compiledBash: [],
          compiledImports: [],
          effectivePriority: TSX_REVIEW_PRIORITY_BOOST,
        };
    // Insert at the beginning (highest priority for this injection)
    rankedSkills.unshift(TSX_REVIEW_SKILL);
    matched.add(TSX_REVIEW_SKILL);
    tsxReviewInjected = true;
    log.debug("tsx-review-synthetic-inject", { skill: TSX_REVIEW_SKILL, count: tsxReview.count });
  } else if (tsxReview.triggered && rankedSkills.includes(TSX_REVIEW_SKILL)) {
    // Already matched via patterns, just mark it
    tsxReviewInjected = true;
  }

  // Stage 4.6: Dev-server verification — synthetic inject or graceful degradation
  const forceSummarySkills = new Set<string>();
  let devServerVerifyInjected = false;
  let devServerUnavailableWarning = false;
  if (devServerVerify.unavailable) {
    // Graceful degradation: inject warning once if not already warned
    const warningKey = "agent-browser-unavailable-warning";
    if (!injectedSkills.has(warningKey)) {
      let warningClaimed = true;
      if (sessionId) {
        warningClaimed = tryClaimSessionKey(sessionId, "seen-skills", warningKey, scopeId);
        if (warningClaimed) {
          syncSessionFileFromClaims(sessionId, "seen-skills", scopeId);
        }
      }

      if (warningClaimed) {
        devServerUnavailableWarning = true;
        injectedSkills.add(warningKey);
        log.debug("dev-server-verify-unavailable-warning", { reason: "agent-browser not installed" });
      }
    }
    // Suppress agent-browser-verify from normal pattern matching when unavailable
    const verifyIdx = rankedSkills.indexOf(DEV_SERVER_VERIFY_SKILL);
    if (verifyIdx !== -1) {
      rankedSkills.splice(verifyIdx, 1);
      log.debug("dev-server-verify-suppressed", { reason: "agent-browser unavailable" });
    }
  } else if (devServerVerify.triggered && !rankedSkills.includes(DEV_SERVER_VERIFY_SKILL)) {
    const verifyTemplate = compiledSkills.find((e) => e.skill === DEV_SERVER_VERIFY_SKILL);
    const _verifyEntry: CompiledSkillEntry = verifyTemplate
      ? { ...verifyTemplate, effectivePriority: DEV_SERVER_VERIFY_PRIORITY_BOOST }
      : {
          skill: DEV_SERVER_VERIFY_SKILL,
          priority: 0,
          compiledPaths: [],
          compiledBash: [],
          compiledImports: [],
          effectivePriority: DEV_SERVER_VERIFY_PRIORITY_BOOST,
        };
    rankedSkills.unshift(DEV_SERVER_VERIFY_SKILL);
    matched.add(DEV_SERVER_VERIFY_SKILL);
    devServerVerifyInjected = true;
    log.debug("dev-server-verify-synthetic-inject", { skill: DEV_SERVER_VERIFY_SKILL, iteration: devServerVerify.iterationCount });
  } else if (devServerVerify.triggered && rankedSkills.includes(DEV_SERVER_VERIFY_SKILL)) {
    devServerVerifyInjected = true;
  }

  // Stage 4.7: Co-inject companion skills alongside agent-browser-verify on dev server detection.
  // Companions share the same iteration guard and loop-guard bypass as agent-browser-verify.
  if (devServerVerify.triggered && !devServerVerify.unavailable) {
    for (const companion of DEV_SERVER_COMPANION_SKILLS) {
      if (rankedSkills.includes(companion)) continue; // already present via pattern match
      const companionAlreadySeen = !dedupOff && injectedSkills.has(companion);
      if (companionAlreadySeen) {
        // Bypass dedup for companions — same as agent-browser-verify iteration-based bypass
        // But inject as summary-only on subsequent injections
        forceSummarySkills.add(companion);
        log.debug("dev-server-companion-dedup-bypass", { skill: companion, mode: "summary" });
      }
      // Insert after agent-browser-verify (or at front if verify not present)
      const verifyIdx = rankedSkills.indexOf(DEV_SERVER_VERIFY_SKILL);
      if (verifyIdx !== -1) {
        rankedSkills.splice(verifyIdx + 1, 0, companion);
      } else {
        rankedSkills.unshift(companion);
      }
      matched.add(companion);
      log.debug("dev-server-companion-inject", { skill: companion, iteration: devServerVerify.iterationCount });
    }
  }

  // Stage 4.8: When loop guard blocks agent-browser-verify (count >= max), still inject
  // companion skills like verification. Verification is useful precisely when a user restarts
  // their dev server multiple times during debugging — it should survive past the iteration cap.
  if (devServerVerify.loopGuardHit && !devServerVerify.unavailable) {
    // Suppress agent-browser-verify from normal pattern matching — the loop guard blocks it
    const verifyIdx = rankedSkills.indexOf(DEV_SERVER_VERIFY_SKILL);
    if (verifyIdx !== -1) {
      rankedSkills.splice(verifyIdx, 1);
      log.debug("dev-server-verify-suppressed-by-loop-guard", { skill: DEV_SERVER_VERIFY_SKILL, count: devServerVerify.iterationCount });
    }
    for (const companion of DEV_SERVER_COMPANION_SKILLS) {
      if (rankedSkills.includes(companion)) continue; // already present via pattern match
      const companionAlreadySeen = !dedupOff && injectedSkills.has(companion);
      if (companionAlreadySeen) {
        forceSummarySkills.add(companion);
        log.debug("dev-server-companion-loop-guard-dedup-bypass", { skill: companion, mode: "summary" });
      }
      rankedSkills.unshift(companion);
      matched.add(companion);
      log.debug("dev-server-companion-inject-past-guard", { skill: companion, iterationCount: devServerVerify.iterationCount, max: DEV_SERVER_VERIFY_MAX_ITERATIONS });
    }
  }

  // Read project facts from env var (set by profiler) or compute from
  // session files and filesystem when env var isn't propagated to hooks.
  const projectFacts = parseFactSet(process.env.VERCEL_PLUGIN_PROJECT_FACTS);
  if (projectFacts.size === 0) {
    // Env var not propagated — read from session file + filesystem
    if (sessionId) {
      const gf = readSessionFile(sessionId, "greenfield");
      if (gf === "true") projectFacts.add("greenfield");
    }
    if (cwd) {
      try {
        const entries = readdirSync(cwd);
        if (!entries.some(e => e === ".env" || e.startsWith(".env."))) {
          projectFacts.add("no-env-files");
        }
      } catch {}
    }
  }
  const runtimeFacts = new Set<string>();
  if (isClientReactFile(toolName, toolInput)) {
    runtimeFacts.add("client-react-file");
  }
  const coInjectResult = applyCoInjectRules({
    rankedSkills,
    allMatchedSkills: [...matched],
    skillMap: skills.skillMap,
    projectFacts,
    runtimeFacts,
    injectedSkills,
    matched,
    forceSummarySkills,
    maxSkills: MAX_SKILLS,
    dedupOff,
    logger: log,
  });
  rankedSkills = coInjectResult.rankedSkills;

  let vercelEnvHelpInjected = false;
  if (vercelEnvHelp.triggered) {
    let helpClaimed = true;
    if (sessionId) {
      helpClaimed = tryClaimSessionKey(sessionId, "seen-skills", VERCEL_ENV_HELP_ONCE_KEY, scopeId);
      if (helpClaimed) {
        syncSessionFileFromClaims(sessionId, "seen-skills", scopeId);
      }
    }
    if (helpClaimed) {
      vercelEnvHelpInjected = true;
      injectedSkills.add(VERCEL_ENV_HELP_ONCE_KEY);
      log.debug("vercel-env-help-injected", { subcommand: vercelEnvHelp.subcommand || "" });
    }
  }

  if (rankedSkills.length === 0 && !devServerUnavailableWarning && !vercelEnvHelpInjected) {
    const reason = matched.size === 0 ? "no_matches" : "all_deduped";
    if (log.active) {
      timing.skill_read = 0;
      timing.total = log.elapsed();
    }
    log.complete(reason, {
      matchedCount: matched.size,
      dedupedCount: matched.size - rankedSkills.length,
      tsxReviewTriggered: tsxReview.triggered,
      devServerVerifyTriggered: devServerVerify.triggered,
      matchedSkills: [...matched],
      injectedSkills: [],
      boostsApplied: profilerBoosted,
    }, log.active ? timing : null);
    const envUpdates = finalizeRuntimeEnvUpdates(platform, runtimeEnvBefore);
    return formatPlatformOutput(platform, undefined, envUpdates);
  }

  // Stage 5: injectSkills (enforces byte budget + MAX_SKILLS ceiling)
  const tSkillRead = log.active ? log.now() : 0;
  const { parts, loaded, summaryOnly, droppedByCap, droppedByBudget } = injectSkills(rankedSkills, {
    pluginRoot: PLUGIN_ROOT,
    projectRoot: cwd,
    skillStore,
    hasEnvDedup: hasSeenSkillDedup,
    sessionId,
    scopeId,
    injectedSkills,
    skillMap: skills.skillMap,
    logger: log,
    forceSummarySkills: forceSummarySkills.size > 0 ? forceSummarySkills : undefined,
    platform,
  });
  if (log.active) timing.skill_read = Math.round(log.now() - tSkillRead);

  // Append review marker if tsx review was triggered and skill was loaded
  if (tsxReviewInjected && loaded.includes(TSX_REVIEW_SKILL)) {
    parts.push(REVIEW_MARKER);
    const prevCount = getTsxEditCount(sessionId);
    resetTsxEditCount(sessionId);
    log.debug("tsx-review-marker-added", { marker: REVIEW_MARKER });
    log.trace("tsx-edit-counter-reset", { previousCount: prevCount, resetTo: 0, threshold: getReviewThreshold() });
  }

  // Append dev-server verify marker and increment iteration count
  if (devServerVerifyInjected && loaded.includes(DEV_SERVER_VERIFY_SKILL)) {
    const prevIteration = getDevServerVerifyCount(sessionId);
    const iteration = incrementDevServerVerifyCount(sessionId);
    parts.push(`${DEV_SERVER_VERIFY_MARKER.replace("-->", `iteration="${iteration}" max="${DEV_SERVER_VERIFY_MAX_ITERATIONS}" -->`)}`);
    log.debug("dev-server-verify-marker-added", { iteration, max: DEV_SERVER_VERIFY_MAX_ITERATIONS });
    log.trace("dev-server-verify-counter-increment", { previous: prevIteration, current: iteration, max: DEV_SERVER_VERIFY_MAX_ITERATIONS, remaining: DEV_SERVER_VERIFY_MAX_ITERATIONS - iteration });
  }

  // Inject unavailable warning instead of skill
  if (devServerUnavailableWarning) {
    parts.push(DEV_SERVER_UNAVAILABLE_WARNING);
    log.debug("dev-server-unavailable-warning-injected", {});
  }

  if (vercelEnvHelpInjected) {
    parts.push(VERCEL_ENV_HELP);
    log.debug("vercel-env-help-appended", { subcommand: vercelEnvHelp.subcommand || "" });
  }

  if (parts.length === 0) {
    if (log.active) timing.total = log.elapsed();
    log.complete("no_matches", {
      matchedCount: matched.size,
      dedupedCount: matchedEntries.length - newEntries.length,
      cappedCount: droppedByCap.length + droppedByBudget.length,
      tsxReviewTriggered: tsxReview.triggered,
      devServerVerifyTriggered: devServerVerify.triggered,
      matchedSkills: [...matched],
      injectedSkills: [],
      droppedByCap,
      droppedByBudget,
      boostsApplied: profilerBoosted,
    }, log.active ? timing : null);
    const envUpdates = finalizeRuntimeEnvUpdates(platform, runtimeEnvBefore);
    return formatPlatformOutput(platform, undefined, envUpdates);
  }

  if (log.active) timing.total = log.elapsed();
  const cappedCount = droppedByCap.length + droppedByBudget.length;
  log.complete("injected", {
    matchedCount: matched.size,
    injectedCount: parts.length,
    dedupedCount: matchedEntries.length - newEntries.length,
    cappedCount,
    tsxReviewTriggered: tsxReview.triggered,
    devServerVerifyTriggered: devServerVerify.triggered,
    matchedSkills: [...matched],
    injectedSkills: loaded,
    droppedByCap,
    droppedByBudget,
    boostsApplied: profilerBoosted,
  }, log.active ? timing : null);

  // Stage 5.5: Build reasons map and verificationId for metadata traceability
  const reasons: Record<string, SkillInjectionReason> = {};
  let verificationId: string | undefined;
  if (devServerVerify.triggered || devServerVerify.loopGuardHit) {
    verificationId = generateVerificationId();
    if (loaded.includes(DEV_SERVER_VERIFY_SKILL)) {
      reasons[DEV_SERVER_VERIFY_SKILL] = {
        trigger: "dev-server-start",
        reasonCode: "bash-dev-server-pattern",
      };
    }
    for (const companion of DEV_SERVER_COMPANION_SKILLS) {
      if (loaded.includes(companion) || (summaryOnly && summaryOnly.includes(companion))) {
        reasons[companion] = {
          trigger: "dev-server-companion",
          reasonCode: devServerVerify.loopGuardHit ? "loop-guard-companion" : "dev-server-co-inject",
        };
      }
    }
  }
  if (tsxReview.triggered && loaded.includes(TSX_REVIEW_SKILL)) {
    reasons[TSX_REVIEW_SKILL] = {
      trigger: "tsx-edit-threshold",
      reasonCode: "tsx-review-trigger",
    };
  }
  for (const application of coInjectResult.applied) {
    if (loaded.includes(application.targetSkill) || (summaryOnly && summaryOnly.includes(application.targetSkill))) {
      reasons[application.targetSkill] = {
        trigger: "co-inject",
        reasonCode: `${application.sourceSkill}:${application.mode}`,
      };
    }
  }
  // Add pattern-match reasons for remaining skills
  for (const skill of loaded) {
    if (!reasons[skill] && matchReasons?.[skill]) {
      reasons[skill] = {
        trigger: matchReasons[skill].matchType,
        reasonCode: "pattern-match",
      };
    }
  }

  // Stage 6: formatOutput
  const envUpdates = finalizeRuntimeEnvUpdates(platform, runtimeEnvBefore);
  const result = formatOutput({
    parts,
    matched,
    injectedSkills: loaded,
    summaryOnly,
    droppedByCap,
    droppedByBudget,
    toolName,
    toolTarget,
    matchReasons,
    reasons,
    verificationId,
    skillMap: skills.skillMap,
    platform,
    env: envUpdates,
  });

  if (loaded.length > 0) {
    appendAuditLog({
      event: "skill-injection",
      toolName,
      toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
      matchedSkills: [...matched],
      injectedSkills: loaded,
      summaryOnly,
      droppedByCap,
      droppedByBudget,
    }, cwd);

    // Base telemetry — always-on (no opt-in required)
    if (sessionId) {
      const telemetryEntries: Array<{ key: string; value: string }> = [];
      for (const skill of loaded) {
        const reason = matchReasons?.[skill];
        telemetryEntries.push(
          { key: "skill:injected", value: skill },
          { key: "skill:hook", value: "PreToolUse" },
          { key: "skill:priority", value: "0" },
          { key: "skill:match_type", value: reason?.matchType ?? "unknown" },
          { key: "skill:tool_name", value: toolName },
        );
      }
      trackBaseEvents(sessionId, telemetryEntries).catch(() => {});
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

const REDACT_MAX = 200;

interface RedactRule {
  re: RegExp;
  fn: (match: string) => string;
}

// Pattern descriptors: each has a regex and a replacer function.
// Order matters — more specific patterns (URL query params, connection strings,
// JSON values) must run before the broad env-var pattern.
const REDACT_RULES: RedactRule[] = [
  {
    // Connection strings: scheme://user:password@host
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^:/?#\s]+:[^@\s]+@[^\s]+/gi,
    fn: (match: string) => match.replace(/:\/\/[^:/?#\s]+:[^@\s]+@/, "://[REDACTED]@"),
  },
  {
    // URL query params with sensitive keys: ?token=xxx, &key=xxx, &secret=xxx, &password=xxx
    re: /([?&])(token|key|secret|password|credential|auth|api_key|apiKey)=[^&\s]*/gi,
    fn: (match: string) => {
      const eqIdx = match.indexOf("=");
      return `${match.slice(0, eqIdx)}=[REDACTED]`;
    },
  },
  {
    // JSON-style secret values: "secret": "val", "password": "val", "token": "val", etc.
    re: /"(token|key|secret|password|credential|api_key|apiKey|auth)":\s*"[^"]*"/gi,
    fn: (match: string) => {
      const colonIdx = match.indexOf(":");
      return `${match.slice(0, colonIdx)}: "[REDACTED]"`;
    },
  },
  {
    // Cookie headers: Cookie: key=value; key2=value2
    re: /\b(Cookie|Set-Cookie):\s*\S[^\r\n]*/gi,
    fn: (match: string) => `${match.split(":")[0]}: [REDACTED]`,
  },
  {
    // Bearer / token authorization headers: "Bearer xxx", "token xxx" (case-insensitive)
    re: /\b(Bearer|token)\s+[A-Za-z0-9_\-.+/=]{8,}\b/gi,
    fn: (match: string) => `${match.split(/\s+/)[0]} [REDACTED]`,
  },
  {
    // --token value, --password value, --api-key value, --secret value, --auth value
    re: /--(token|password|api-key|secret|auth|credential)\s+\S+/gi,
    fn: (match: string) => `${match.split(/\s+/)[0]} [REDACTED]`,
  },
  {
    // ENV_VAR_TOKEN=value, MY_KEY=value, SECRET=value, PASSWORD=value (env-style, may be prefixed)
    // Matches keys that contain a sensitive word anywhere (e.g. MY_SECRET_VALUE=...)
    // [^\s&] prevents consuming URL query-param delimiters
    re: /\b\w*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)\w*=[^\s&]+/gi,
    fn: (match: string) => {
      const eqIdx = match.indexOf("=");
      return `${match.slice(0, eqIdx)}=[REDACTED]`;
    },
  },
];

/**
 * Truncate a command string to REDACT_MAX chars and mask sensitive values.
 * Only intended for debug logging — never mutates the actual command.
 */
export function redactCommand(command: string): string {
  if (typeof command !== "string") return "";
  let redacted = command;
  for (const { re, fn } of REDACT_RULES) {
    re.lastIndex = 0;
    redacted = redacted.replace(re, fn);
  }
  if (redacted.length > REDACT_MAX) {
    redacted = redacted.slice(0, REDACT_MAX) + "\u2026[truncated]";
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Metadata version
// ---------------------------------------------------------------------------

const SKILL_INJECTION_VERSION = 1;

// ---------------------------------------------------------------------------
// Matching helpers — delegated to ./patterns.mjs
// (compileSkillPatterns, matchPathWithReason, matchBashWithReason, rankEntries)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Execute and write result (only when run directly, not when imported)
// ---------------------------------------------------------------------------

/** Detect whether this module is the main entry point (ESM equivalent of require.main === module). */
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
      `[${new Date().toISOString()}] CRASH in pretooluse-skill-inject.mts`,
      `  error: ${(err as Error)?.message || String(err)}`,
      `  stack: ${(err as Error)?.stack || "(no stack)"}`,
      `  PLUGIN_ROOT: ${PLUGIN_ROOT}`,
      `  argv: ${JSON.stringify(process.argv)}`,
      `  cwd: ${process.cwd()}`,
      "",
    ].join("\n");
    process.stderr.write(entry);
    // Return empty JSON so the hook doesn't block the tool call
    process.stdout.write("{}");
  }
}

export {
  run, validateSkillMap,
  TSX_REVIEW_SKILL, REVIEW_MARKER, DEFAULT_REVIEW_THRESHOLD, isTsxEditTool, getTsxEditCount, resetTsxEditCount,
  DEV_SERVER_VERIFY_SKILL, DEV_SERVER_VERIFY_MARKER, DEV_SERVER_VERIFY_MAX_ITERATIONS, DEV_SERVER_COMPANION_SKILLS,
  isClientReactFile,
  checkVercelEnvHelp,
  DEV_SERVER_UNAVAILABLE_WARNING,
};
