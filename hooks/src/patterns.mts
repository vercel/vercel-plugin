/**
 * Shared pattern utilities for converting glob patterns to RegExp,
 * plus the canonical match/rank engine used by both the PreToolUse hook
 * and the CLI explain command.
 */

import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationRule {
  pattern: string;
  message: string;
  severity: "error" | "recommended" | "warn";
}

export interface RetrievalMetadata {
  aliases?: string[];
  intents?: string[];
  entities?: string[];
  examples?: string[];
}

export interface SkillEntry {
  priority: number;
  summary?: string;
  docs?: string[];
  pathPatterns: string[];
  bashPatterns: string[];
  importPatterns: string[];
  validate?: ValidationRule[];
  retrieval?: RetrievalMetadata;
}

/**
 * Full manifest skill entry: base SkillEntry plus pre-compiled regex sources.
 * Written by build-manifest.ts, read by the PreToolUse hook.
 */
export interface ManifestSkill extends SkillEntry {
  pathRegexSources: string[];
  bashRegexSources: string[];
  importRegexSources: Array<{ source: string; flags: string }>;
}

export interface CompiledPattern {
  pattern: string;
  regex: RegExp;
}

export interface CompiledSkillEntry {
  skill: string;
  priority: number;
  compiledPaths: CompiledPattern[];
  compiledBash: CompiledPattern[];
  compiledImports: CompiledPattern[];
  effectivePriority?: number;
}

export interface MatchReason {
  pattern: string;
  matchType: string;
}

export interface CompileCallbacks {
  onPathGlobError?: (skill: string, pattern: string, err: unknown) => void;
  onBashRegexError?: (skill: string, pattern: string, err: unknown) => void;
  onImportPatternError?: (skill: string, pattern: string, err: unknown) => void;
}

// ---------------------------------------------------------------------------
// Glob → RegExp
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a regex.
 * Supports *, **, and ? wildcards.
 * Double-star-slash requires slash boundaries — matches zero or more path segments.
 */
const REGEX_META_CHARS = ".()+[]{}|^$\\";

interface BraceExpansion {
  alternatives: string[];
  endIndex: number;
}

function parseBraceExpansion(pattern: string, startIndex: number): BraceExpansion | null {
  let depth = 0;
  let current = "";
  let sawTopLevelComma = false;
  const alternatives: string[] = [];

  for (let i = startIndex; i < pattern.length; i++) {
    const c = pattern[i];

    if (i === startIndex) {
      depth = 1;
      continue;
    }

    if (c === "{") {
      depth++;
      current += c;
      continue;
    }

    if (c === "}") {
      depth--;
      if (depth === 0) {
        if (!sawTopLevelComma) {
          return null;
        }
        alternatives.push(current);
        return { alternatives, endIndex: i };
      }
      current += c;
      continue;
    }

    if (c === "," && depth === 1) {
      sawTopLevelComma = true;
      alternatives.push(current);
      current = "";
      continue;
    }

    current += c;
  }

  return null;
}

function globPatternToRegexSource(pattern: string): string {
  let re = "";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          re += "(?:[^/]+/)*";
          i++;
        } else {
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }

    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }

    if (c === "{") {
      const expansion = parseBraceExpansion(pattern, i);
      if (expansion) {
        re += `(?:${expansion.alternatives.map(globPatternToRegexSource).join("|")})`;
        i = expansion.endIndex + 1;
        continue;
      }
    }

    if (REGEX_META_CHARS.includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
    i++;
  }

  return re;
}

export function globToRegex(pattern: string): RegExp {
  if (typeof pattern !== "string") {
    throw new TypeError(`globToRegex: expected string, got ${typeof pattern}`);
  }
  if (pattern === "") {
    throw new Error("globToRegex: pattern must not be empty");
  }
  return new RegExp(`^${globPatternToRegexSource(pattern)}$`);
}

// ---------------------------------------------------------------------------
// Seen-skills env var helpers
// ---------------------------------------------------------------------------

/**
 * Parse comma-delimited seen-skill slugs from env var into a Set.
 */
export function parseSeenSkills(envValue: string): Set<string> {
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return new Set();
  }
  const seen = new Set<string>();
  for (const part of envValue.split(",")) {
    const skill = part.trim();
    if (skill !== "") {
      seen.add(skill);
    }
  }
  return seen;
}

export function serializeSeenSkills(seen: Set<string>): string {
  return [...seen].sort().join(",");
}

export function mergeSeenSkillStates(...values: string[]): string {
  const merged = new Set<string>();
  for (const value of values) {
    for (const skill of parseSeenSkills(value)) {
      merged.add(skill);
    }
  }
  return serializeSeenSkills(merged);
}

/**
 * Scope-aware merge of seen-skill states.
 *
 * When `scopeId` is `"main"` (lead agent), all sources are merged — env var,
 * session file, and claim dir contents.
 *
 * When `scopeId` is anything else (subagent), the `envValue` is **excluded**
 * because it carries the parent agent's seen-skills and would incorrectly
 * suppress skills that the subagent has never seen.
 */
export function mergeScopedSeenSkillStates(
  scopeId: string,
  envValue: string,
  fileValue: string,
  claimValue: string,
): string {
  if (scopeId === "main") {
    return mergeSeenSkillStates(envValue, fileValue, claimValue);
  }
  // Subagent: only merge scope-local file + claim state; ignore inherited env
  return mergeSeenSkillStates(fileValue, claimValue);
}

/**
 * Return updated comma-delimited string with a new skill appended.
 */
export function appendSeenSkill(envValue: string | undefined, skill: string): string {
  if (typeof skill !== "string" || skill.trim() === "") return envValue || "";
  const current = typeof envValue === "string" ? envValue.trim() : "";
  return current === "" ? skill : `${current},${skill}`;
}

// ---------------------------------------------------------------------------
// Match engine — shared by pretooluse hook and CLI explain
// ---------------------------------------------------------------------------

/**
 * Compile a skill map into entries with precompiled regexes.
 */
export function compileSkillPatterns(
  skillMap: Record<string, SkillEntry>,
  callbacks?: CompileCallbacks,
): CompiledSkillEntry[] {
  const cb = callbacks || {};
  return Object.entries(skillMap).map(([skill, config]) => {
    const compiledPaths: CompiledPattern[] = [];
    for (const p of config.pathPatterns || []) {
      try { compiledPaths.push({ pattern: p, regex: globToRegex(p) }); } catch (err) {
        if (cb.onPathGlobError) cb.onPathGlobError(skill, p, err);
      }
    }
    const compiledBash: CompiledPattern[] = [];
    for (const p of config.bashPatterns || []) {
      try { compiledBash.push({ pattern: p, regex: new RegExp(p) }); } catch (err) {
        if (cb.onBashRegexError) cb.onBashRegexError(skill, p, err);
      }
    }
    const compiledImports: CompiledPattern[] = [];
    for (const p of config.importPatterns || []) {
      try { compiledImports.push({ pattern: p, regex: importPatternToRegex(p) }); } catch (err) {
        if (cb.onImportPatternError) cb.onImportPatternError(skill, p, err);
      }
    }
    return {
      skill,
      priority: typeof config.priority === "number" ? config.priority : 0,
      compiledPaths,
      compiledBash,
      compiledImports,
    };
  });
}

/**
 * Convert an import pattern (package name, possibly with wildcard) to a regex
 * that matches ESM import/require statements in file content.
 */
export function importPatternToRegex(pattern: string): RegExp {
  if (typeof pattern !== "string") {
    throw new TypeError(`importPatternToRegex: expected string, got ${typeof pattern}`);
  }
  if (pattern === "") {
    throw new Error("importPatternToRegex: pattern must not be empty");
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^'\"]*");
  return new RegExp(`(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`, "m");
}

/**
 * Match file content against precompiled import patterns.
 */
export function matchImportWithReason(
  content: string,
  compiled: CompiledPattern[],
): MatchReason | null {
  if (!content || compiled.length === 0) return null;
  for (const { pattern, regex } of compiled) {
    if (regex.test(content)) {
      return { pattern, matchType: "import" };
    }
  }
  return null;
}

/**
 * Match a file path against precompiled path patterns.
 */
export function matchPathWithReason(
  filePath: string,
  compiled: CompiledPattern[],
): MatchReason | null {
  if (!filePath || compiled.length === 0) return null;

  const normalized = filePath.replace(/\\/g, "/");

  for (const { pattern, regex } of compiled) {
    if (regex.test(normalized)) return { pattern, matchType: "full" };

    const base = basename(normalized);
    if (regex.test(base)) return { pattern, matchType: "basename" };

    const segments = normalized.split("/");
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(-i).join("/");
      if (regex.test(suffix)) return { pattern, matchType: "suffix" };
    }
  }
  return null;
}

/**
 * Match a bash command against precompiled bash patterns.
 */
export function matchBashWithReason(
  command: string,
  compiled: CompiledPattern[],
): MatchReason | null {
  if (!command || compiled.length === 0) return null;
  for (const { pattern, regex } of compiled) {
    if (regex.test(command)) return { pattern, matchType: "full" };
  }
  return null;
}

/**
 * Parse comma-delimited likely-skill slugs from env var into a Set.
 */
export function parseLikelySkills(envValue: string): Set<string> {
  return parseSeenSkills(envValue);
}

/**
 * Sort compiled skill entries by effectivePriority (if set) or priority DESC,
 * then skill name ASC.
 */
export function rankEntries(entries: CompiledSkillEntry[]): CompiledSkillEntry[] {
  return entries.slice().sort((a, b) => {
    const aPri = typeof a.effectivePriority === "number" ? a.effectivePriority : a.priority;
    const bPri = typeof b.effectivePriority === "number" ? b.effectivePriority : b.priority;
    return (bPri - aPri) || a.skill.localeCompare(b.skill);
  });
}

// ---------------------------------------------------------------------------
// Docs banner builder
// ---------------------------------------------------------------------------

const DOCS_WARNING =
  "**MANDATORY: Your training data for these libraries is OUTDATED and UNRELIABLE.** " +
  "APIs, method signatures, and config options change frequently and WITHOUT WARNING. " +
  "You MUST open and read the official docs linked below BEFORE writing ANY code. " +
  "DO NOT guess, assume, or rely on memorized APIs — they are likely WRONG.";

/**
 * Build a docs reference block for injected skills.
 * Returns empty string if no skill has docs URLs.
 */
export function buildDocsBlock(
  injectedSkills: string[],
  skillMap: Record<string, { docs?: string[] }> | undefined,
): string {
  if (!skillMap) return "";

  const entries: string[] = [];
  for (const skill of injectedSkills) {
    const docs = skillMap[skill]?.docs;
    if (docs && docs.length > 0) {
      entries.push(`  - **${skill}**: ${docs.join(" , ")}`);
    }
  }

  if (entries.length === 0) return "";

  return [
    "---",
    DOCS_WARNING,
    "",
    "Official documentation:",
    ...entries,
    "---",
  ].join("\n");
}
