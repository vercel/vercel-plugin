/**
 * Shared helper that builds and validates the skill map from a directory of SKILL.md files.
 * Eliminates duplicated buildSkillMap→validateSkillMap sequences across CLI scripts.
 */

import {
  buildSkillMap,
  validateSkillMap,
} from "../../hooks/src/skill-map-frontmatter.mts";

export interface ValidatedSkillMapResult {
  /** Raw output from buildSkillMap (includes diagnostics, raw skills) */
  raw: ReturnType<typeof buildSkillMap>;
  /** Validation result (includes .ok, .errors, .warnings, .normalizedSkillMap) */
  validation: ReturnType<typeof validateSkillMap>;
  /** Normalized skills if validation passed, raw skills as fallback */
  skills: Record<string, any>;
  /** Human-readable diagnostics from the build phase */
  buildDiagnostics: string[];
}

/**
 * Build and validate the skill map from a skills directory.
 *
 * Returns both raw and validated results so callers can choose how to handle
 * validation failures (throw, collect issues, etc.).
 */
export function loadValidatedSkillMap(skillsDir: string): ValidatedSkillMapResult {
  const raw = buildSkillMap(skillsDir);
  const validation = validateSkillMap(raw);

  const buildDiagnostics: string[] = [];
  if (raw.diagnostics?.length) {
    for (const d of raw.diagnostics) {
      buildDiagnostics.push(`${d.file}: ${d.message}`);
    }
  }

  const skills = validation.ok
    ? validation.normalizedSkillMap.skills
    : (raw.skills ?? {});

  return { raw, validation, skills, buildDiagnostics };
}
