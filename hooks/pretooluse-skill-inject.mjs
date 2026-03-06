#!/usr/bin/env node
/**
 * PreToolUse hook: injects relevant SKILL.md content as additionalContext
 * when Claude reads/edits/writes files or runs bash commands that match
 * skill-map patterns.
 *
 * Input: JSON on stdin with tool_name, tool_input, session_id
 * Output: JSON on stdout with { hookSpecificOutput: { additionalContext: "..." } } or {}
 *
 * Caps at 3 skills per invocation. Deduplicates per session.
 *
 * Debug: Set VERCEL_PLUGIN_DEBUG=1 (or VERCEL_PLUGIN_HOOK_DEBUG=1) to emit JSON-lines debug events to stderr.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { buildSkillMap, validateSkillMap } from "./skill-map-frontmatter.mjs";
import { globToRegex, parseSeenSkills, appendSeenSkill } from "./patterns.mjs";

const MAX_SKILLS = 3;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Debug logging (stderr-only, JSON-lines)
// ---------------------------------------------------------------------------

const DEBUG = process.env.VERCEL_PLUGIN_DEBUG === "1" || process.env.VERCEL_PLUGIN_HOOK_DEBUG === "1";
const invocationId = DEBUG ? randomBytes(4).toString("hex") : "";
const safeNow = typeof performance !== "undefined" && typeof performance.now === "function"
  ? () => performance.now()
  : () => Date.now();
const t0 = DEBUG ? safeNow() : 0;

function dbg(event, data) {
  if (!DEBUG) return;
  const line = JSON.stringify({
    invocationId,
    event,
    timestamp: new Date().toISOString(),
    ...data,
  });
  process.stderr.write(line + "\n");
}

/**
 * Emit a structured issue event in debug mode.
 * Issue codes: STDIN_EMPTY, STDIN_PARSE_FAIL, SKILLMAP_LOAD_FAIL,
 *   SKILLMAP_VALIDATE_FAIL, SKILLMAP_EMPTY, SKILLMD_PARSE_FAIL,
 *   DEDUP_READ_FAIL, DEDUP_RESET_FAIL, DEDUP_WRITE_FAIL,
 *   SKILL_FILE_MISSING, BASH_REGEX_INVALID, PATH_GLOB_INVALID
 */
function emitIssue(code, message, hint, context) {
  dbg("issue", { code, message, hint, context });
}

/**
 * Reason codes for the complete event:
 *   stdin_empty, stdin_parse_fail, tool_unsupported, no_matches,
 *   all_deduped, injected, skillmap_fail
 *
 * Emits exactly one 'complete' event per invocation with aggregate counts.
 */
function emitComplete(reason, counts = {}, timing = null) {
  const { matchedCount = 0, injectedCount = 0, dedupedCount = 0, cappedCount = 0 } = counts;
  dbg("complete", {
    reason,
    matchedCount,
    injectedCount,
    dedupedCount,
    cappedCount,
    elapsed_ms: Math.round(safeNow() - t0),
    ...(timing ? { timing_ms: timing } : {}),
  });
}

/** @returns {string} comma-delimited seen skills from env, or "" */
function getSeenSkillsEnv() {
  return typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string"
    ? process.env.VERCEL_PLUGIN_SEEN_SKILLS
    : "";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  const timing = {};
  const tPhase = DEBUG ? safeNow() : 0;

  // ---- Read stdin ----
  let input;
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) {
      emitIssue("STDIN_EMPTY", "No data received on stdin", "Ensure the hook receives JSON on stdin with tool_name, tool_input, session_id", {});
      emitComplete("stdin_empty");
      return "{}";
    }
    if (DEBUG) timing.stdin_parse = Math.round(safeNow() - tPhase);
    input = JSON.parse(raw);
  } catch (err) {
    emitIssue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON with tool_name, tool_input, session_id fields", { error: String(err) });
    emitComplete("stdin_parse_fail");
    return "{}";
  }

  if (DEBUG && !timing.stdin_parse) timing.stdin_parse = Math.round(safeNow() - tPhase);

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  // sessionId is retained for debug metadata only.
  const sessionId = input.session_id || process.env.SESSION_ID || null;

  // Determine tool target for metadata
  const toolTarget = toolName === "Bash"
    ? (toolInput.command || "")
    : (toolInput.file_path || "");

  dbg("input-parsed", { toolName, sessionId });

  // Emit redacted tool target in debug mode
  if (DEBUG) {
    dbg("tool-target", { toolName, target: redactCommand(toolTarget) });
  }

  // ---- Load skill map (from SKILL.md frontmatter) ----
  let tSkillmap = DEBUG ? safeNow() : 0;
  let skillMap;
  try {
    const skillsDir = join(PLUGIN_ROOT, "skills");
    const built = buildSkillMap(skillsDir);

    // Surface diagnostics from malformed SKILL.md files
    if (built.diagnostics && built.diagnostics.length > 0) {
      for (const d of built.diagnostics) {
        emitIssue("SKILLMD_PARSE_FAIL", `Failed to parse SKILL.md: ${d.message}`, `Fix YAML frontmatter in ${d.file}`, { file: d.file, error: d.error });
      }
    }

    // Emit debug warnings for type coercion in buildSkillMap
    if (built.warnings && built.warnings.length > 0) {
      for (const w of built.warnings) {
        dbg("skillmap-coercion-warning", { warning: w });
      }
    }

    // Validate and normalize the skill map to prevent .map() crashes on bad types
    const validation = validateSkillMap(built);
    if (!validation.ok) {
      emitIssue("SKILLMAP_VALIDATE_FAIL", "Skill map validation failed after build", "Check SKILL.md frontmatter types: filePattern and bashPattern must be arrays", { errors: validation.errors });
      emitComplete("skillmap_fail");
      return "{}";
    }
    if (validation.warnings && validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        dbg("skillmap-validation-warning", { warning: w });
      }
    }
    skillMap = validation.normalizedSkillMap.skills;
  } catch (err) {
    emitIssue("SKILLMAP_LOAD_FAIL", "Failed to build skill map from SKILL.md frontmatter", "Check that skills/*/SKILL.md files exist and contain valid YAML frontmatter with metadata.filePattern", { error: String(err) });
    emitComplete("skillmap_fail");
    return "{}";
  }
  if (DEBUG) timing.skillmap_load = Math.round(safeNow() - tSkillmap);

  if (typeof skillMap !== "object" || Object.keys(skillMap).length === 0) {
    emitIssue("SKILLMAP_EMPTY", "Skill map is empty or has no skills", "Ensure skills/*/SKILL.md files have YAML frontmatter with metadata.filePattern or metadata.bashPattern", { type: typeof skillMap });
    emitComplete("skillmap_fail");
    return "{}";
  }

  const skillCount = Object.keys(skillMap).length;
  dbg("skillmap-loaded", { skillCount });

  // ---- Precompile regex patterns once ----
  const compiledSkills = Object.entries(skillMap).map(([skill, config]) => ({
    skill,
    priority: typeof config.priority === "number" ? config.priority : 0,
    pathPatterns: config.pathPatterns || [],
    pathRegexes: (config.pathPatterns || []).map((p) => {
      try { return globToRegex(p); } catch (err) {
        emitIssue("PATH_GLOB_INVALID", `Invalid glob pattern in skill "${skill}": ${p}`, `Fix or remove the invalid filePattern in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
        return null;
      }
    }).filter(Boolean),
    bashPatterns: config.bashPatterns || [],
    bashRegexes: (config.bashPatterns || []).map((p) => {
      try { return new RegExp(p); } catch (err) {
        emitIssue("BASH_REGEX_INVALID", `Invalid bash regex pattern in skill "${skill}": ${p}`, `Fix or remove the invalid bashPattern in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
        return null;
      }
    }).filter(Boolean),
  }));

  // ---- Session dedup (env-var based) ----
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const seenEnv = getSeenSkillsEnv();
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const dedupStrategy = dedupOff ? "disabled" : hasEnvDedup ? "env-var" : "memory-only";

  dbg("dedup-strategy", { strategy: dedupStrategy, sessionId, seenEnv });

  let injectedSkills = hasEnvDedup ? parseSeenSkills(seenEnv) : new Set();

  // ---- Determine matched skills (using precompiled regexes) ----
  let tMatch = DEBUG ? safeNow() : 0;
  const matchedEntries = [];
  const matchReasons = {};

  const supportedTools = ["Read", "Edit", "Write", "Bash"];
  if (!supportedTools.includes(toolName)) {
    emitComplete("tool_unsupported");
    return "{}";
  }

  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    for (const entry of compiledSkills) {
      const reason = matchPathRegexesWithReason(filePath, entry.pathRegexes, entry.pathPatterns);
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  } else if (toolName === "Bash") {
    const command = toolInput.command || "";
    for (const entry of compiledSkills) {
      const reason = matchBashRegexesWithReason(command, entry.bashRegexes, entry.bashPatterns);
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  }
  if (DEBUG) timing.match = Math.round(safeNow() - tMatch);

  const matched = new Set(matchedEntries.map((e) => e.skill));
  dbg("matches-found", { matched: [...matched], reasons: matchReasons });

  // Filter out already-injected skills (when dedup is disabled, injectedSkills is always empty)
  let newEntries = dedupOff
    ? matchedEntries
    : matchedEntries.filter((e) => !injectedSkills.has(e.skill));

  // Sort by priority DESC, then skill name ASC for deterministic ordering
  newEntries.sort((a, b) => (b.priority - a.priority) || a.skill.localeCompare(b.skill));

  const newSkills = newEntries.map((e) => e.skill);

  dbg("dedup-filtered", {
    newSkills,
    previouslyInjected: [...injectedSkills],
  });

  if (newSkills.length === 0) {
    if (DEBUG) {
      timing.skill_read = 0;
      timing.total = Math.round(safeNow() - t0);
    }
    const reason = matched.size === 0 ? "no_matches" : "all_deduped";
    emitComplete(reason, {
      matchedCount: matched.size,
      dedupedCount: matched.size - newSkills.length,
    }, DEBUG ? timing : null);
    return "{}";
  }

  // Cap at MAX_SKILLS
  const toInject = newSkills.slice(0, MAX_SKILLS);

  // Emit cap observability when skills were dropped
  if (newEntries.length > MAX_SKILLS) {
    const selected = newEntries.slice(0, MAX_SKILLS).map((e) => ({ skill: e.skill, priority: e.priority }));
    const dropped = newEntries.slice(MAX_SKILLS).map((e) => ({ skill: e.skill, priority: e.priority }));
    dbg("cap-applied", { max: MAX_SKILLS, totalMatched: newEntries.length, selected, dropped });
  }

  // ---- Load SKILL.md files and build output ----
  let tSkillRead = DEBUG ? safeNow() : 0;
  const parts = [];
  for (const skill of toInject) {
    const skillPath = join(PLUGIN_ROOT, "skills", skill, "SKILL.md");
    try {
      const content = readFileSync(skillPath, "utf-8");
      parts.push(
        `<!-- skill:${skill} -->\n${content}\n<!-- /skill:${skill} -->`,
      );
      injectedSkills.add(skill);
      if (hasEnvDedup) {
        process.env.VERCEL_PLUGIN_SEEN_SKILLS = appendSeenSkill(
          process.env.VERCEL_PLUGIN_SEEN_SKILLS, skill
        );
      }
    } catch (err) {
      emitIssue("SKILL_FILE_MISSING", `SKILL.md not found for skill "${skill}"`, `Create skills/${skill}/SKILL.md with valid frontmatter`, { skillPath, error: String(err) });
    }
  }

  if (DEBUG) timing.skill_read = Math.round(safeNow() - tSkillRead);

  dbg("skills-injected", { injected: toInject, totalParts: parts.length });

  if (parts.length === 0) {
    if (DEBUG) timing.total = Math.round(safeNow() - t0);
    emitComplete("no_matches", {
      matchedCount: matched.size,
      dedupedCount: matchedEntries.length - newEntries.length,
      cappedCount: newEntries.length > MAX_SKILLS ? newEntries.length - MAX_SKILLS : 0,
    }, DEBUG ? timing : null);
    return "{}";
  }

  if (DEBUG) timing.total = Math.round(safeNow() - t0);
  const cappedCount = newEntries.length > MAX_SKILLS ? newEntries.length - MAX_SKILLS : 0;
  emitComplete("injected", {
    matchedCount: matched.size,
    injectedCount: parts.length,
    dedupedCount: matchedEntries.length - newEntries.length,
    cappedCount,
  }, DEBUG ? timing : null);

  // Build skillInjection metadata
  const droppedByCap = newEntries.length > MAX_SKILLS
    ? newEntries.slice(MAX_SKILLS).map((e) => e.skill)
    : [];

  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    toolName,
    toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
    matchedSkills: [...matched],
    injectedSkills: toInject,
    droppedByCap,
  };

  return JSON.stringify({
    hookSpecificOutput: {
      additionalContext: parts.join("\n\n"),
      skillInjection,
    },
  });
}

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

const REDACT_MAX = 200;
const REDACT_PATTERNS = [
  // ENV_VAR_TOKEN=value, MY_KEY=value, SECRET=value (env-style, may be prefixed)
  /\b\w*(TOKEN|KEY|SECRET)=\S+/gi,
  // --token value, --password value, --api-key value
  /--(token|password|api-key)\s+\S+/gi,
];

/**
 * Truncate a command string to REDACT_MAX chars and mask sensitive values.
 * Only intended for debug logging — never mutates the actual command.
 */
export function redactCommand(command) {
  if (typeof command !== "string") return "";
  let redacted = command;
  for (const re of REDACT_PATTERNS) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    redacted = redacted.replace(re, (match, key) => {
      if (match.startsWith("--")) {
        // --flag value → --flag [REDACTED]
        const flag = match.split(/\s+/)[0];
        return `${flag} [REDACTED]`;
      }
      // KEY=value → KEY=[REDACTED]
      return `${key}=[REDACTED]`;
    });
  }
  if (redacted.length > REDACT_MAX) {
    redacted = redacted.slice(0, REDACT_MAX) + "…[truncated]";
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Metadata version
// ---------------------------------------------------------------------------

const SKILL_INJECTION_VERSION = 1;

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

// globToRegex is imported from ./patterns.mjs

function matchPathRegexesWithReason(filePath, regexes, patterns) {
  if (!filePath || regexes.length === 0) return null;

  // Normalize to forward slashes
  const normalized = filePath.replace(/\\/g, "/");

  for (let idx = 0; idx < regexes.length; idx++) {
    const regex = regexes[idx];
    const pattern = patterns[idx];

    // Try matching against the full path
    if (regex.test(normalized)) return { pattern, matchType: "full" };

    // Try matching against the basename
    const base = basename(normalized);
    if (regex.test(base)) return { pattern, matchType: "basename" };

    // Try matching progressively from the end
    const segments = normalized.split("/");
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(-i).join("/");
      if (regex.test(suffix)) return { pattern, matchType: "suffix" };
    }
  }
  return null;
}

function matchBashRegexesWithReason(command, regexes, patterns) {
  if (!command || regexes.length === 0) return null;
  for (let idx = 0; idx < regexes.length; idx++) {
    if (regexes[idx].test(command)) return { pattern: patterns[idx], matchType: "full" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execute and write result (only when run directly, not when imported)
// ---------------------------------------------------------------------------

/** Detect whether this module is the main entry point (ESM equivalent of require.main === module). */
function isMainModule() {
  try {
    const scriptPath = realpathSync(resolve(process.argv[1] || ""));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.stdout.write(run());
}

export { run, validateSkillMap };
