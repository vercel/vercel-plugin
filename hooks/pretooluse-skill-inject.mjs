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

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

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
 *   SKILLMAP_EMPTY, DEDUP_READ_FAIL, SKILL_FILE_MISSING, DEDUP_WRITE_FAIL,
 *   BASH_REGEX_INVALID
 */
function emitIssue(code, message, hint, context) {
  dbg("issue", { code, message, hint, context });
}

// ---------------------------------------------------------------------------
// Skill-map validation
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set(["priority", "pathPatterns", "bashPatterns"]);

/**
 * Validate and normalize a skill-map object.
 * Returns { ok: true, normalizedSkillMap, warnings } or { ok: false, errors }.
 */
export function validateSkillMap(raw) {
  const errors = [];
  const warnings = [];

  if (raw == null || typeof raw !== "object") {
    return { ok: false, errors: ["skill-map must be a non-null object"] };
  }

  if (!("skills" in raw)) {
    return { ok: false, errors: ["skill-map is missing required 'skills' key"] };
  }

  const skills = raw.skills;
  if (skills == null || typeof skills !== "object" || Array.isArray(skills)) {
    return { ok: false, errors: ["'skills' must be a non-null object (not an array)"] };
  }

  const normalizedSkills = {};

  for (const [skill, config] of Object.entries(skills)) {
    if (config == null || typeof config !== "object" || Array.isArray(config)) {
      errors.push(`skill "${skill}": config must be a non-null object`);
      continue;
    }

    // Warn on unknown keys
    for (const key of Object.keys(config)) {
      if (!KNOWN_KEYS.has(key)) {
        warnings.push(`skill "${skill}": unknown key "${key}"`);
      }
    }

    // Normalize priority
    let priority = 0;
    if ("priority" in config) {
      const p = config.priority;
      if (typeof p !== "number" || Number.isNaN(p)) {
        warnings.push(`skill "${skill}": priority is not a valid number, defaulting to 0`);
      } else {
        priority = p;
      }
    }

    // Normalize pathPatterns
    let pathPatterns = [];
    if ("pathPatterns" in config) {
      if (!Array.isArray(config.pathPatterns)) {
        warnings.push(`skill "${skill}": pathPatterns is not an array, defaulting to []`);
      } else {
        pathPatterns = config.pathPatterns.filter((p, i) => {
          if (typeof p !== "string") {
            warnings.push(`skill "${skill}": pathPatterns[${i}] is not a string, removing`);
            return false;
          }
          return true;
        });
      }
    }

    // Normalize bashPatterns
    let bashPatterns = [];
    if ("bashPatterns" in config) {
      if (!Array.isArray(config.bashPatterns)) {
        warnings.push(`skill "${skill}": bashPatterns is not an array, defaulting to []`);
      } else {
        bashPatterns = config.bashPatterns.filter((p, i) => {
          if (typeof p !== "string") {
            warnings.push(`skill "${skill}": bashPatterns[${i}] is not a string, removing`);
            return false;
          }
          return true;
        });
      }
    }

    normalizedSkills[skill] = { priority, pathPatterns, bashPatterns };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, normalizedSkillMap: { skills: normalizedSkills }, warnings };
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
      return "{}";
    }
    if (DEBUG) timing.stdin_parse = Math.round(safeNow() - tPhase);
    input = JSON.parse(raw);
  } catch (err) {
    emitIssue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON with tool_name, tool_input, session_id fields", { error: String(err) });
    return "{}";
  }

  if (DEBUG && !timing.stdin_parse) timing.stdin_parse = Math.round(safeNow() - tPhase);

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  // When session_id is missing and SESSION_ID env is unset, use null → memory-only dedup
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

  // ---- Load skill map ----
  let tSkillmap = DEBUG ? safeNow() : 0;
  let skillMap;
  try {
    const mapPath = join(PLUGIN_ROOT, "hooks", "skill-map.json");
    const parsed = JSON.parse(readFileSync(mapPath, "utf-8"));
    skillMap = parsed.skills || {};
  } catch (err) {
    emitIssue("SKILLMAP_LOAD_FAIL", "Failed to load or parse skill-map.json", "Check that hooks/skill-map.json exists and contains valid JSON with a .skills key", { error: String(err) });
    return "{}";
  }
  if (DEBUG) timing.skillmap_load = Math.round(safeNow() - tSkillmap);

  if (typeof skillMap !== "object" || Object.keys(skillMap).length === 0) {
    emitIssue("SKILLMAP_EMPTY", "Skill map is empty or has no skills", "Ensure hooks/skill-map.json has a non-empty .skills object", { type: typeof skillMap });
    return "{}";
  }

  const skillCount = Object.keys(skillMap).length;
  dbg("skillmap-loaded", { skillCount });

  // ---- Precompile regex patterns once ----
  const compiledSkills = Object.entries(skillMap).map(([skill, config]) => ({
    skill,
    priority: typeof config.priority === "number" ? config.priority : 0,
    pathPatterns: config.pathPatterns || [],
    pathRegexes: (config.pathPatterns || []).map((p) => globToRegex(p)),
    bashPatterns: config.bashPatterns || [],
    bashRegexes: (config.bashPatterns || []).map((p) => {
      try { return new RegExp(p); } catch (err) {
        emitIssue("BASH_REGEX_INVALID", `Invalid bash regex pattern in skill "${skill}": ${p}`, `Fix or remove the invalid pattern from skill-map.json bashPatterns for "${skill}"`, { skill, pattern: p, error: String(err) });
        return null;
      }
    }).filter(Boolean),
  }));

  // ---- Session dedup ----
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const usePersistentDedup = !dedupOff && sessionId !== null;
  const dedupStrategy = dedupOff ? "disabled" : usePersistentDedup ? "persistent" : "memory-only";

  dbg("dedup-strategy", { strategy: dedupStrategy, sessionId });

  const dedupDir = join(tmpdir(), "vercel-plugin-hooks");
  const dedupFile = usePersistentDedup
    ? join(dedupDir, `session-${hashSessionId(sessionId)}.json`)
    : null;

  // RESET_DEDUP=1 clears the dedup file before matching
  if (process.env.RESET_DEDUP === "1" && dedupFile) {
    try {
      if (existsSync(dedupFile)) {
        writeFileSync(dedupFile, "[]");
        dbg("dedup-reset", { dedupFile });
      }
    } catch (err) {
      emitIssue("DEDUP_RESET_FAIL", "Failed to reset dedup file", "Check write permissions in tmpdir", { dedupFile, error: String(err) });
    }
  }

  let injectedSkills;
  if (dedupOff) {
    injectedSkills = new Set(); // never filters anything, never persists
  } else if (usePersistentDedup) {
    try {
      if (!existsSync(dedupDir)) mkdirSync(dedupDir, { recursive: true });
      injectedSkills = existsSync(dedupFile)
        ? new Set(JSON.parse(readFileSync(dedupFile, "utf-8")))
        : new Set();
    } catch (err) {
      emitIssue("DEDUP_READ_FAIL", "Failed to read or parse dedup state file", "Check file permissions in tmpdir; dedup will reset for this invocation", { dedupFile, error: String(err) });
      injectedSkills = new Set();
    }
  } else {
    // memory-only: fresh set each invocation, no persistence
    injectedSkills = new Set();
  }

  function persistDedup() {
    if (!usePersistentDedup || !dedupFile) return;
    try {
      const tmpFile = dedupFile + ".tmp";
      writeFileSync(tmpFile, JSON.stringify([...injectedSkills]));
      renameSync(tmpFile, dedupFile);
    } catch (err) {
      emitIssue("DEDUP_WRITE_FAIL", "Failed to persist dedup state", "Check write permissions in tmpdir; skills may re-inject next invocation", { dedupFile, error: String(err) });
    }
  }

  // ---- Determine matched skills (using precompiled regexes) ----
  let tMatch = DEBUG ? safeNow() : 0;
  const matchedEntries = [];
  const matchReasons = {};

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
    dbg("complete", { result: "empty", elapsed_ms: Math.round(safeNow() - t0), ...(DEBUG ? { timing_ms: timing } : {}) });
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
    } catch (err) {
      emitIssue("SKILL_FILE_MISSING", `SKILL.md not found for skill "${skill}"`, `Create skills/${skill}/SKILL.md or remove "${skill}" from skill-map.json`, { skillPath, error: String(err) });
    }
  }

  if (DEBUG) timing.skill_read = Math.round(safeNow() - tSkillRead);

  dbg("skills-injected", { injected: toInject, totalParts: parts.length });

  if (parts.length === 0) {
    if (DEBUG) timing.total = Math.round(safeNow() - t0);
    dbg("complete", { result: "empty", elapsed_ms: Math.round(safeNow() - t0), ...(DEBUG ? { timing_ms: timing } : {}) });
    return "{}";
  }

  // Persist dedup state
  persistDedup();

  if (DEBUG) timing.total = Math.round(safeNow() - t0);
  dbg("complete", { result: "injected", skillCount: parts.length, elapsed_ms: Math.round(safeNow() - t0), ...(DEBUG ? { timing_ms: timing } : {}) });

  // Build skillInjection metadata
  const droppedByCap = newEntries.length > MAX_SKILLS
    ? newEntries.slice(MAX_SKILLS).map((e) => e.skill)
    : [];

  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    toolName,
    toolTarget,
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
// Session ID hashing
// ---------------------------------------------------------------------------

const SESSION_ID_MAX = 64;

/**
 * Produce a safe, bounded filename segment from a session ID.
 * Short IDs (≤64 chars, already filesystem-safe) pass through as-is.
 * Longer or unsafe IDs are SHA-256 hashed and truncated to 16 hex chars.
 */
function hashSessionId(id) {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized.length <= SESSION_ID_MAX) return sanitized;
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a regex.
 * Supports *, **, and ? wildcards.
 * Double-star-slash requires slash boundaries — matches zero or more path segments.
 */
function globToRegex(pattern) {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches zero or more path segments with slash boundaries
        i += 2;
        if (pattern[i] === "/") {
          // **/ → zero or more complete path segments (each ending in /)
          re += "(?:[^/]+/)*";
          i++;
        } else {
          // trailing ** (no slash after) → match rest of path
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".()+[]{}|^$\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
    i++;
  }
  re += "$";
  return new RegExp(re);
}

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
// Execute and write result
// ---------------------------------------------------------------------------

process.stdout.write(run());
