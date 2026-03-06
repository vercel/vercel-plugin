/**
 * Shared pattern utilities for converting glob patterns to RegExp.
 * Used by the PreToolUse hook and the validation script.
 */

/**
 * Convert a simple glob pattern to a regex.
 * Supports *, **, and ? wildcards.
 * Double-star-slash requires slash boundaries — matches zero or more path segments.
 */
export function globToRegex(pattern) {
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

/**
 * Parse comma-delimited seen-skill slugs from env var into a Set.
 */
export function parseSeenSkills(envValue) {
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return new Set();
  }
  const seen = new Set();
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
export function appendSeenSkill(envValue, skill) {
  if (typeof skill !== "string" || skill.trim() === "") return envValue || "";
  const current = typeof envValue === "string" ? envValue.trim() : "";
  return current === "" ? skill : `${current},${skill}`;
}
