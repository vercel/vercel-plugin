#!/usr/bin/env node
/**
 * PostToolUse hook: validates files after Write/Edit operations against
 * skill-specific validation rules defined in SKILL.md frontmatter.
 *
 * Input: JSON on stdin with tool_name, tool_input, session_id, cwd
 * Output: JSON on stdout with { hookSpecificOutput: { additionalContext: "..." } } or {}
 *
 * Only fires for Write and Edit tool calls. Reads the written file,
 * matches it against skill import/path patterns, then runs validate:
 * regex rules from matched skills. Error-severity violations produce
 * additionalContext with fix instructions. Warn-severity only at debug level.
 *
 * Dedup: tracks validated file+hash pairs in VERCEL_PLUGIN_VALIDATED_FILES
 * for in-process checks and persists the merged state in the session
 * "validated-files" file to skip re-validation across hook invocations.
 *
 * Pipeline stages:
 *   parseInput → loadValidateRules → matchFileToSkills → runValidation
 *   → runChainInjection → formatOutput
 */

import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPlatform, type HookPlatform } from "./compat.mjs";
import {
  dedupFilePath,
  pluginRoot as resolvePluginRoot,
  readSessionFile,
  safeReadFile,
  writeSessionFile,
  tryClaimSessionKey,
  syncSessionFileFromClaims,
} from "./hook-env.mjs";
import type { ChainToRule, SkillConfig, ValidationRule } from "./skill-map-frontmatter.mjs";
import {
  matchPathWithReason,
  matchImportWithReason,
  importPatternToRegex,
} from "./patterns.mjs";
import type { CompiledSkillEntry, CompiledPattern } from "./patterns.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import type { Logger } from "./logger.mjs";
import { createSkillStore, type SkillStore } from "./skill-store.mjs";

const PLUGIN_ROOT = resolvePluginRoot();
const SUPPORTED_TOOLS = ["Write", "Edit"];
const VALIDATED_FILES_ENV_KEY = "VERCEL_PLUGIN_VALIDATED_FILES";
const SEEN_VALIDATIONS_KIND = "seen-validations";
const CHAIN_BUDGET_BYTES = 18_000;
const DEFAULT_CHAIN_CAP = 2;
const REPEATED_SUGGESTION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedInput {
  toolName: string;
  filePath: string;
  filePaths: string[];
  sessionId: string | null;
  cwd: string;
  platform: HookPlatform;
}

function resolveToolFilePaths(toolInput: Record<string, unknown>): string[] {
  const collected: string[] = [];

  const pushPath = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed !== "") {
      collected.push(trimmed);
    }
  };

  pushPath(toolInput.file_path);

  if (Array.isArray(toolInput.file_paths)) {
    for (const value of toolInput.file_paths) {
      pushPath(value);
    }
  }

  if (Array.isArray(toolInput.files)) {
    for (const value of toolInput.files) {
      if (typeof value === "string") {
        pushPath(value);
        continue;
      }

      if (value && typeof value === "object" && "file_path" in value) {
        pushPath((value as { file_path?: unknown }).file_path);
      }
    }
  }

  return [...new Set(collected)];
}

function resolveSessionId(input: Record<string, unknown>): string | null {
  const sessionId = input.session_id ?? input.conversation_id;
  return typeof sessionId === "string" && sessionId.trim() !== "" ? sessionId : null;
}

function resolveHookCwd(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  const workspaceRoot = Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined;
  const candidate = input.cwd
    ?? workspaceRoot
    ?? env.CURSOR_PROJECT_DIR
    ?? env.CLAUDE_PROJECT_ROOT
    ?? process.cwd();

  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : process.cwd();
}

function formatPlatformOutput(
  platform: HookPlatform,
  additionalContext?: string,
  env?: Record<string, string>,
): string {
  if (!additionalContext) {
    return "{}";
  }

  if (platform === "cursor") {
    const output: Record<string, unknown> = {
      additional_context: additionalContext,
    };
    if (env && Object.keys(env).length > 0) {
      output.env = env;
    }
    return JSON.stringify(output);
  }

  const output: SyncHookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse" as const,
      additionalContext,
    },
  };

  return JSON.stringify(output);
}

export interface SkillValidateRules {
  skill: string;
  rules: ValidationRule[];
}

export interface ValidationViolation {
  skill: string;
  line: number;
  message: string;
  severity: "error" | "recommended" | "warn";
  matchedText: string;
  filePath?: string;
  ruleId?: string;
  occurrenceCount?: number;
  repeated?: boolean;
  upgradeToSkill?: string;
  upgradeWhy?: string;
  upgradeMode?: "hard" | "soft";
}

/**
 * Generate a stable ID for a validation rule (skill + pattern hash).
 */
function validationRuleId(skill: string, rule: ValidationRule): string {
  return `${skill}::${rule.pattern}`;
}

export interface ValidateResult {
  violations: ValidationViolation[];
  matchedSkills: string[];
  skippedDedup: boolean;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Pipeline stage 1: parseInput
// ---------------------------------------------------------------------------

/**
 * Parse raw stdin JSON into a normalized input descriptor.
 * Returns null if input is irrelevant (wrong tool, no file path, etc.).
 */
export function parseInput(
  raw: string,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
): ParsedInput | null {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    l.debug("posttooluse-validate-skip", { reason: "stdin_empty" });
    return null;
  }

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(trimmed);
  } catch {
    l.debug("posttooluse-validate-skip", { reason: "stdin_parse_fail" });
    return null;
  }

  const toolName = (input.tool_name as string) || "";
  if (!SUPPORTED_TOOLS.includes(toolName)) {
    l.debug("posttooluse-validate-skip", { reason: "unsupported_tool", toolName });
    return null;
  }

  const toolInput = (input.tool_input as Record<string, unknown>) || {};
  const filePaths = resolveToolFilePaths(toolInput);
  const filePath = filePaths[0] || "";
  if (!filePath) {
    l.debug("posttooluse-validate-skip", { reason: "no_file_path", toolName });
    return null;
  }

  const sessionId = resolveSessionId(input);
  const cwd = resolveHookCwd(input, env);
  const platform = detectPlatform(input);

  l.debug("posttooluse-validate-input", {
    toolName,
    filePath,
    filePathsCount: filePaths.length,
    sessionId: sessionId as string,
    cwd,
    platform,
  });
  return { toolName, filePath, filePaths, sessionId, cwd, platform };
}

// ---------------------------------------------------------------------------
// Pipeline stage 2: loadValidateRules
// ---------------------------------------------------------------------------

export interface LoadedValidateData {
  skillMap: Record<string, SkillConfig>;
  compiledSkills: CompiledSkillEntry[];
  rulesMap: Map<string, ValidationRule[]>;
  chainMap: Map<string, ChainToRule[]>;
}

/**
 * Load skills that have validate: rules. Returns null if no rules exist.
 * Uses the skill store for cache-first resolution (project → global → bundled).
 */
export function loadValidateRules(
  pluginRoot: string,
  logger?: Logger,
  projectRoot?: string,
  skillStore?: SkillStore,
): LoadedValidateData | null {
  const l = logger || log;
  const store = skillStore ?? createSkillStore({
    projectRoot: projectRoot ?? process.cwd(),
    pluginRoot,
    bundledFallback: process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
  });
  const loaded = store.loadSkillSet(l);
  if (!loaded) {
    l.debug("posttooluse-validate-skip", { reason: "no_skills_loaded" });
    return null;
  }
  const skillMap = loaded.skillMap;

  // Filter to skills that have validate rules or chainTo rules
  const rulesMap = new Map<string, ValidationRule[]>();
  const chainMap = new Map<string, ChainToRule[]>();
  for (const [slug, config] of Object.entries(skillMap)) {
    if (config.validate && config.validate.length > 0) {
      rulesMap.set(slug, config.validate);
    }
    if (config.chainTo && config.chainTo.length > 0) {
      chainMap.set(slug, config.chainTo);
    }
  }

  if (rulesMap.size === 0 && chainMap.size === 0) {
    l.debug("posttooluse-validate-skip", { reason: "no_validate_rules" });
    return null;
  }

  const compiledSkills = loaded.compiledSkills;
  l.debug("posttooluse-validate-loaded", {
    totalSkills: Object.keys(skillMap).length,
    skillsWithRules: rulesMap.size,
    skillsWithChainTo: chainMap.size,
  });

  return { skillMap, compiledSkills, rulesMap, chainMap };
}

// ---------------------------------------------------------------------------
// Pipeline stage 3: matchFileToSkills
// ---------------------------------------------------------------------------

/**
 * Match a file path and its content against skill patterns to find
 * which skills' validate rules should apply.
 */
export function matchFileToSkills(
  filePath: string,
  fileContent: string,
  compiledSkills: CompiledSkillEntry[],
  rulesMap: Map<string, ValidationRule[]>,
  logger?: Logger,
  chainMap?: Map<string, ChainToRule[]>,
): string[] {
  const l = logger || log;
  const matched: string[] = [];

  for (const entry of compiledSkills) {
    // Only check skills that have validate rules or chainTo rules
    if (!rulesMap.has(entry.skill) && !(chainMap?.has(entry.skill))) continue;

    // Match by path
    const pathMatch = matchPathWithReason(filePath, entry.compiledPaths);
    if (pathMatch) {
      matched.push(entry.skill);
      l.trace("posttooluse-validate-match", {
        skill: entry.skill,
        matchType: "path",
        pattern: pathMatch.pattern,
      });
      continue;
    }

    // Match by import patterns in file content
    const importMatch = matchImportWithReason(fileContent, entry.compiledImports);
    if (importMatch) {
      matched.push(entry.skill);
      l.trace("posttooluse-validate-match", {
        skill: entry.skill,
        matchType: "import",
        pattern: importMatch.pattern,
      });
    }
  }

  l.debug("posttooluse-validate-matched", { matchedSkills: matched });
  return matched;
}

// ---------------------------------------------------------------------------
// Pipeline stage 4: runValidation
// ---------------------------------------------------------------------------

/**
 * Run validation rules against file content. Returns violations found.
 */
export function runValidation(
  fileContent: string,
  matchedSkills: string[],
  rulesMap: Map<string, ValidationRule[]>,
  logger?: Logger,
  filePath?: string,
): ValidationViolation[] {
  const l = logger || log;
  const violations: ValidationViolation[] = [];
  const lines = fileContent.split("\n");

  for (const skill of matchedSkills) {
    const rules = rulesMap.get(skill);
    if (!rules) continue;

    for (const rule of rules) {
      const ruleId = validationRuleId(skill, rule);

      // Skip rule if file matches the skip condition
      if (rule.skipIfFileContains) {
        try {
          if (new RegExp(rule.skipIfFileContains, "m").test(fileContent)) {
            l.trace("posttooluse-validate-rule-skip", {
              skill,
              pattern: rule.pattern,
              reason: "skipIfFileContains matched",
            });
            continue;
          }
        } catch {
          // Invalid skip regex — proceed with rule anyway
        }
      }

      let regex: RegExp;
      try {
        regex = new RegExp(rule.pattern, "g");
      } catch {
        l.debug("posttooluse-validate-regex-fail", {
          skill,
          pattern: rule.pattern,
        });
        continue;
      }

      // Check each line for matches
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        const match = regex.exec(lines[i]);
        if (match) {
          violations.push({
            skill,
            line: i + 1,
            message: rule.message,
            severity: rule.severity,
            matchedText: match[0].slice(0, 80),
            filePath,
            ruleId,
            upgradeToSkill: rule.upgradeToSkill,
            upgradeWhy: rule.upgradeWhy,
            upgradeMode: rule.upgradeMode ?? (rule.upgradeToSkill ? "soft" : undefined),
          });
        }
      }
    }
  }

  l.debug("posttooluse-validate-violations", {
    total: violations.length,
    errors: violations.filter((v) => v.severity === "error").length,
    recommended: violations.filter((v) => v.severity === "recommended").length,
    warns: violations.filter((v) => v.severity === "warn").length,
  });

  return violations;
}

// ---------------------------------------------------------------------------
// Pipeline stage 4b: chainTo injection
// ---------------------------------------------------------------------------

export interface ChainInjection {
  sourceSkill: string;
  targetSkill: string;
  message?: string;
  content: string;
}

export interface ChainResult {
  injected: ChainInjection[];
  totalBytes: number;
}

/**
 * Check chainTo rules from matched skills against file content. For each
 * match, if the target skill hasn't been injected in this session, read
 * its SKILL.md body and collect it for injection.
 *
 * Chain depth is limited to 1 hop (no recursive chaining).
 * A per-invocation byte budget of CHAIN_BUDGET_BYTES applies.
 */
export function runChainInjection(
  fileContent: string,
  matchedSkills: string[],
  chainMap: Map<string, ChainToRule[]>,
  sessionId: string | null,
  pluginRoot: string,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
  skillStore?: SkillStore,
): ChainResult {
  const l = logger || log;
  const result: ChainResult = { injected: [], totalBytes: 0 };

  // Chain cap: max skills injected per PostToolUse invocation
  const chainCap = Math.max(1, parseInt(env.VERCEL_PLUGIN_CHAIN_CAP || "", 10) || DEFAULT_CHAIN_CAP);

  // Collect all matching chainTo rules across matched skills
  const candidates: Array<{ sourceSkill: string; rule: ChainToRule }> = [];
  for (const skill of matchedSkills) {
    const rules = chainMap.get(skill);
    if (!rules) continue;
    for (const rule of rules) {
      // skipIfFileContains: skip this chain rule if file already has the target pattern
      if (rule.skipIfFileContains) {
        try {
          if (new RegExp(rule.skipIfFileContains, "m").test(fileContent)) {
            l.debug("posttooluse-chain-skip-contains", {
              skill,
              targetSkill: rule.targetSkill,
              reason: "skipIfFileContains matched",
            });
            continue;
          }
        } catch {
          // Invalid skip regex — proceed with rule anyway
        }
      }

      try {
        const regex = new RegExp(rule.pattern, "m");
        if (regex.test(fileContent)) {
          candidates.push({ sourceSkill: skill, rule });
        }
      } catch {
        l.debug("posttooluse-chain-regex-fail", {
          skill,
          pattern: rule.pattern,
        });
      }
    }
  }

  if (candidates.length === 0) return result;

  // Deduplicate target skills (first match wins per target)
  const seenTargets = new Set<string>();
  const uniqueCandidates = candidates.filter(({ rule }) => {
    if (seenTargets.has(rule.targetSkill)) return false;
    seenTargets.add(rule.targetSkill);
    return true;
  });

  // Check dedup against the persisted session-backed seen-skills state
  const fileSeen = sessionId ? readSessionFile(sessionId, "seen-skills") : "";
  const seenSet = new Set(fileSeen.split(",").filter(Boolean));

  for (const { sourceSkill, rule } of uniqueCandidates) {
    // Enforce chain cap
    if (result.injected.length >= chainCap) {
      l.debug("posttooluse-chain-cap-reached", {
        cap: chainCap,
        remaining: uniqueCandidates.length - result.injected.length,
      });
      break;
    }

    // Skip if target already injected this session (loop prevention)
    if (seenSet.has(rule.targetSkill)) {
      l.debug("posttooluse-chain-skip-dedup", {
        sourceSkill,
        targetSkill: rule.targetSkill,
      });
      continue;
    }

    // Read target SKILL.md via skill store (cache-first resolution)
    const store = skillStore ?? createSkillStore({
      projectRoot: process.cwd(),
      pluginRoot,
      bundledFallback: env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
    });
    const resolved = store.resolveSkillBody(rule.targetSkill, l);
    if (!resolved) {
      l.debug("posttooluse-chain-skip-missing", {
        sourceSkill,
        targetSkill: rule.targetSkill,
      });
      continue;
    }

    const trimmedBody = resolved.body.trim();
    if (!trimmedBody) continue;

    // Check budget
    const bytes = Buffer.byteLength(trimmedBody, "utf-8");
    if (result.totalBytes + bytes > CHAIN_BUDGET_BYTES) {
      l.debug("posttooluse-chain-budget-exceeded", {
        sourceSkill,
        targetSkill: rule.targetSkill,
        bytes,
        totalBytes: result.totalBytes,
        budget: CHAIN_BUDGET_BYTES,
      });
      break;
    }

    // Claim via dedup
    if (sessionId) {
      const claimed = tryClaimSessionKey(sessionId, "seen-skills", rule.targetSkill);
      if (!claimed) {
        l.debug("posttooluse-chain-skip-concurrent-claim", {
          sourceSkill,
          targetSkill: rule.targetSkill,
        });
        seenSet.add(rule.targetSkill);
        continue;
      }
      syncSessionFileFromClaims(sessionId, "seen-skills");
    }

    seenSet.add(rule.targetSkill);

    result.injected.push({
      sourceSkill,
      targetSkill: rule.targetSkill,
      message: rule.message,
      content: trimmedBody,
    });
    result.totalBytes += bytes;

    l.debug("posttooluse-chain-injected", {
      sourceSkill,
      targetSkill: rule.targetSkill,
      bytes,
      totalBytes: result.totalBytes,
    });
  }

  if (result.injected.length > 0) {
    l.summary("posttooluse-chain-result", {
      injectedCount: result.injected.length,
      totalBytes: result.totalBytes,
      targets: result.injected.map((i) => i.targetSkill),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dedup: file+hash tracking via env var and session file
// ---------------------------------------------------------------------------

/**
 * Compute a fast content hash for dedup tracking.
 */
export function contentHash(content: string): string {
  return createHash("md5").update(content).digest("hex").slice(0, 12);
}

/**
 * Parse a serialized validated-files state into a Set of "path:hash" pairs.
 */
export function parseValidatedFiles(envValue: string | undefined): Set<string> {
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return new Set();
  }
  const set = new Set<string>();
  for (const part of envValue.split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") set.add(trimmed);
  }
  return set;
}

/**
 * Append a validated file entry to the serialized state value.
 */
export function appendValidatedFile(envValue: string | undefined, entry: string): string {
  const current = typeof envValue === "string" ? envValue.trim() : "";
  return current === "" ? entry : `${current},${entry}`;
}

/**
 * Check if a file+hash has already been validated this session.
 */
export function isAlreadyValidated(filePath: string, hash: string, sessionId?: string | null): boolean {
  const entry = `${filePath}:${hash}`;
  const validated = parseValidatedFiles(process.env.VERCEL_PLUGIN_VALIDATED_FILES);
  if (validated.has(entry)) {
    return true;
  }

  if (!sessionId) {
    return false;
  }

  const persisted = parseValidatedFiles(readSessionFile(sessionId, "validated-files"));
  return persisted.has(entry);
}

/**
 * Mark a file+hash as validated for the current process and session file.
 */
export function markValidated(
  filePath: string,
  hash: string,
  sessionId?: string | null,
): string {
  const entry = `${filePath}:${hash}`;
  const persistedState = sessionId ? readSessionFile(sessionId, "validated-files") : "";
  const current = process.env[VALIDATED_FILES_ENV_KEY] || persistedState;
  const next = appendValidatedFile(current, entry);
  process.env[VALIDATED_FILES_ENV_KEY] = next;
  if (sessionId) {
    writeSessionFile(sessionId, "validated-files", next);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Pipeline stage 5: formatOutput
// ---------------------------------------------------------------------------

/**
 * Format validation violations into the hook output JSON.
 * Error-severity violations produce mandatory fix instructions.
 * Recommended-severity violations produce imperative best-practice instructions.
 * Warn-severity violations produce soft-fix suggestions at all log levels.
 */
export function formatOutput(
  violations: ValidationViolation[],
  matchedSkills: string[],
  filePath: string,
  logger?: Logger,
  platform: HookPlatform = "claude-code",
  env?: Record<string, string>,
  chainResult?: ChainResult,
): string {
  const l = logger || log;
  const hasChains = chainResult && chainResult.injected.length > 0;

  if (violations.length === 0 && !hasChains) {
    l.debug("posttooluse-validate-no-output", { reason: "no_actionable_violations" });
    return "{}";
  }

  const errors = violations.filter((v) => v.severity === "error");
  const recommended = violations.filter((v) => v.severity === "recommended");
  const warns = violations.filter((v) => v.severity === "warn");
  const hasErrors = errors.length > 0;
  const hasRecommended = recommended.length > 0;
  const hasWarns = warns.length > 0;

  // Group by skill for clear output
  const bySkill = new Map<string, ValidationViolation[]>();
  for (const v of violations) {
    if (!bySkill.has(v.skill)) bySkill.set(v.skill, []);
    bySkill.get(v.skill)!.push(v);
  }

  const emittedUpgradeSkills = new Set<string>();

  const formatViolationLine = (
    violation: ValidationViolation,
    label: "ERROR" | "RECOMMENDED" | "SUGGESTION",
  ): string => {
    const lines = [`- Line ${violation.line} [${label}]: ${violation.message}`];
    if (violation.upgradeToSkill && !emittedUpgradeSkills.has(violation.upgradeToSkill)) {
      emittedUpgradeSkills.add(violation.upgradeToSkill);
      const reason = violation.upgradeWhy ? ` Reason: ${violation.upgradeWhy}` : "";
      const prefix = violation.upgradeMode === "hard" ? "REQUIRED: " : "";
      lines.push("");
      lines.push(`${prefix}Use the Skill tool now to load ${violation.upgradeToSkill}.${reason}`);
      lines.push(
        `<!-- skillUpgrade: ${JSON.stringify({
          from: violation.skill,
          to: violation.upgradeToSkill,
          line: violation.line,
        })} -->`,
      );
    }
    return lines.join("\n");
  };

  const parts: string[] = [];
  for (const [skill, skillViolations] of bySkill) {
    const errorLines = skillViolations
      .filter((v) => v.severity === "error")
      .map((v) => formatViolationLine(v, "ERROR"));
    const recommendedLines = skillViolations
      .filter((v) => v.severity === "recommended")
      .map((v) => formatViolationLine(v, "RECOMMENDED"));
    const warnLines = skillViolations
      .filter((v) => v.severity === "warn")
      .map((v) => formatViolationLine(v, "SUGGESTION"));
    parts.push([...errorLines, ...recommendedLines, ...warnLines].join("\n"));
  }

  const skillList = [...bySkill.keys()].join(", ");

  const counts = [
    hasErrors ? `${errors.length} error${errors.length > 1 ? "s" : ""}` : "",
    hasRecommended ? `${recommended.length} recommendation${recommended.length > 1 ? "s" : ""}` : "",
    hasWarns ? `${warns.length} suggestion${warns.length > 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(", ");

  // Errors demand fixes; recommended gets imperative language; warn-only gets a softer call to action
  const callToAction = hasErrors
    ? `Please fix these issues before proceeding.`
    : hasRecommended
      ? `Apply these recommendations before continuing — they reflect current best practices.`
      : `Consider applying these suggestions to follow best practices.`;

  // Build validation context block (may be empty if only chains matched)
  const contextParts: string[] = [];

  if (violations.length > 0) {
    contextParts.push(
      `<!-- posttooluse-validate: ${skillList} -->`,
      `VALIDATION (${counts}) for \`${filePath}\`:`,
      ...parts,
      callToAction,
      `<!-- /posttooluse-validate -->`,
    );
  }

  // Append chain-injected skill content
  if (hasChains) {
    for (const chain of chainResult!.injected) {
      const reason = chain.message ? ` ${chain.message}` : "";
      contextParts.push(
        `<!-- posttooluse-chain: ${chain.sourceSkill} → ${chain.targetSkill} -->`,
        `**Skill context auto-loaded** (${chain.targetSkill}):${reason}`,
        "",
        chain.content,
        `<!-- /posttooluse-chain: ${chain.targetSkill} -->`,
      );
    }
  }

  const context = contextParts.join("\n");

  const chainedSkills = hasChains
    ? chainResult!.injected.map((c) => c.targetSkill)
    : [];

  const metadata = {
    version: 1,
    hook: "posttooluse-validate",
    filePath,
    matchedSkills,
    errorCount: errors.length,
    recommendedCount: recommended.length,
    warnCount: warns.length,
    chainedSkills,
  };
  const metaComment = `<!-- postValidation: ${JSON.stringify(metadata)} -->`;

  l.summary("posttooluse-validate-output", {
    filePath,
    matchedSkills,
    errorCount: errors.length,
    recommendedCount: recommended.length,
    warnCount: warns.length,
    chainedSkills,
  });

  return formatPlatformOutput(platform, context + "\n" + metaComment, env);
}

// ---------------------------------------------------------------------------
// Orchestrator: run()
// ---------------------------------------------------------------------------

export function run(): string {
  const timing: Record<string, number> = {};
  const tStart = log.active ? log.now() : 0;

  // Stage 1: parseInput
  let raw: string;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
  const parsed = parseInput(raw, log);
  if (!parsed) return "{}";
  if (log.active) timing.parse = Math.round(log.now() - tStart);

  const { toolName, filePath, sessionId, cwd, platform } = parsed;

  // Read file content from disk
  const resolvedPath = cwd ? resolve(cwd, filePath) : filePath;
  const fileContent = safeReadFile(resolvedPath);
  if (!fileContent) {
    log.debug("posttooluse-validate-skip", { reason: "file_unreadable", filePath: resolvedPath });
    return "{}";
  }

  // Dedup check: skip if same file+hash already validated
  const hash = contentHash(fileContent);
  if (isAlreadyValidated(filePath, hash, sessionId)) {
    log.debug("posttooluse-validate-skip", { reason: "already_validated", filePath, hash });
    return "{}";
  }

  // Stage 2: loadValidateRules (via skill store for cache-first resolution)
  const tLoad = log.active ? log.now() : 0;
  const store = createSkillStore({
    projectRoot: cwd,
    pluginRoot: PLUGIN_ROOT,
    bundledFallback: process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
  });
  const data = loadValidateRules(PLUGIN_ROOT, log, cwd, store);
  if (!data) return "{}";
  if (log.active) timing.load = Math.round(log.now() - tLoad);

  const { compiledSkills, rulesMap, chainMap } = data;

  // Stage 3: matchFileToSkills
  const tMatch = log.active ? log.now() : 0;
  const matchedSkills = matchFileToSkills(filePath, fileContent, compiledSkills, rulesMap, log, chainMap);
  if (log.active) timing.match = Math.round(log.now() - tMatch);

  if (matchedSkills.length === 0) {
    log.debug("posttooluse-validate-skip", { reason: "no_skill_match", filePath });
    markValidated(filePath, hash, sessionId);
    return "{}";
  }

  // Stage 4: runValidation
  const tValidate = log.active ? log.now() : 0;
  const violations = runValidation(fileContent, matchedSkills, rulesMap, log);
  if (log.active) timing.validate = Math.round(log.now() - tValidate);

  // Stage 4b: chainTo injection
  const tChain = log.active ? log.now() : 0;
  const chainResult = runChainInjection(
    fileContent, matchedSkills, chainMap, sessionId, PLUGIN_ROOT, log,
    process.env, store,
  );
  if (log.active) timing.chain = Math.round(log.now() - tChain);

  // Mark as validated regardless of result (content hasn't changed)
  const validatedFiles = markValidated(filePath, hash, sessionId);

  // Stage 5: formatOutput
  const hasOutput = violations.length > 0 || chainResult.injected.length > 0;
  const cursorEnv = platform === "cursor" && hasOutput
    ? { [VALIDATED_FILES_ENV_KEY]: validatedFiles }
    : undefined;
  const result = formatOutput(violations, matchedSkills, filePath, log, platform, cursorEnv, chainResult);

  log.complete("posttooluse-validate-done", {
    matchedCount: matchedSkills.length,
    injectedCount: violations.filter((v) => v.severity === "error").length,
  }, timing);

  return result;
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
      `[${new Date().toISOString()}] CRASH in posttooluse-validate.mts`,
      `  error: ${(err as Error)?.message || String(err)}`,
      `  stack: ${(err as Error)?.stack || "(no stack)"}`,
      `  PLUGIN_ROOT: ${PLUGIN_ROOT}`,
      "",
    ].join("\n");
    process.stderr.write(entry);
    process.stdout.write("{}");
  }
}
