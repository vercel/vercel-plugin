/**
 * Shared pattern utilities for converting glob patterns to RegExp,
 * plus the canonical match/rank engine used by both the PreToolUse hook
 * and the CLI explain command.
 */

import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillEntry {
  priority: number;
  summary?: string;
  pathPatterns: string[];
  bashPatterns: string[];
  importPatterns: string[];
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
export function globToRegex(pattern: string): RegExp {
  if (typeof pattern !== "string") {
    throw new TypeError(`globToRegex: expected string, got ${typeof pattern}`);
  }
  if (pattern === "") {
    throw new Error("globToRegex: pattern must not be empty");
  }
  let re = "^";
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
