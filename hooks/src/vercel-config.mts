/**
 * vercel.json key-aware routing — maps top-level vercel.json keys
 * to the most relevant skill(s) so the PreToolUse hook can break
 * capability-collision ties intelligently.
 *
 * When the tool target is a vercel.json file and it exists on disk,
 * this module reads its keys and returns a Set of skill names that
 * are relevant to the file's current content.
 */

import { safeReadFile } from "./hook-env.mjs";

// ---------------------------------------------------------------------------
// Key → skill mapping
// ---------------------------------------------------------------------------

/**
 * Maps vercel.json top-level keys to the skill that provides the best
 * guidance for that key.  A key may map to multiple skills if genuinely
 * shared (rare — prefer the most specific skill).
 */
const KEY_SKILL_MAP: Record<string, string[]> = {
  // Routing
  redirects: ["routing-middleware"],
  rewrites: ["routing-middleware"],
  headers: ["routing-middleware"],
  cleanUrls: ["routing-middleware"],
  trailingSlash: ["routing-middleware"],

  // Cron
  crons: ["cron-jobs"],

  // Functions / compute
  functions: ["vercel-functions"],
  regions: ["vercel-functions"],

  // Build / CI-CD
  builds: ["deployments-cicd"],
  buildCommand: ["deployments-cicd"],
  installCommand: ["deployments-cicd"],
  outputDirectory: ["deployments-cicd"],
  framework: ["deployments-cicd"],
  devCommand: ["deployments-cicd"],
  ignoreCommand: ["deployments-cicd"],
};

/**
 * Skills that claim vercel.json in their pathPatterns.
 * Used to identify candidates whose priority should be adjusted.
 */
export const VERCEL_JSON_SKILLS = new Set([
  "cron-jobs",
  "deployments-cicd",
  "routing-middleware",
  "vercel-functions",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VercelJsonRouting {
  relevantSkills: Set<string>;
  keys: string[];
}

/**
 * Given an absolute file path to a vercel.json, read it and return
 * the Set of skill names that are relevant based on its keys.
 *
 * Returns `null` if the file cannot be read or parsed (caller should
 * fall back to default priority-based matching).
 */
export function resolveVercelJsonSkills(filePath: string): VercelJsonRouting | null {
  const content = safeReadFile(filePath);
  if (content === null) return null; // file doesn't exist or can't be read

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null; // malformed JSON
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const keys = Object.keys(parsed as Record<string, unknown>);
  const relevantSkills = new Set<string>();

  for (const key of keys) {
    const skills = KEY_SKILL_MAP[key];
    if (skills) {
      for (const s of skills) {
        relevantSkills.add(s);
      }
    }
  }

  return { relevantSkills, keys };
}

/**
 * Returns true if the given file path looks like a vercel.json target.
 * Matches both root and monorepo apps/star/vercel.json patterns.
 */
export function isVercelJsonPath(filePath: string): boolean {
  if (typeof filePath !== "string") return false;
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop();
  return base === "vercel.json";
}
