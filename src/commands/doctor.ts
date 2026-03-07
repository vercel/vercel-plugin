/**
 * `vercel-plugin doctor` — self-diagnosis command that checks:
 *   1. Manifest vs dynamic-scan parity
 *   2. Hook timeout risk (skill count threshold)
 *   3. Dedup env var correctness
 *   4. Skill map validation errors/warnings
 *
 * Exit code 0 = all checks pass, non-zero = issues found.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadValidatedSkillMap } from "../shared/skill-map-loader.ts";

/** Threshold at which pattern count may threaten the 5-second hook timeout. */
const PATTERN_COUNT_WARN_THRESHOLD = 200;

/** Threshold at which skill count alone is a concern. */
const SKILL_COUNT_WARN_THRESHOLD = 50;

export interface DoctorIssue {
  severity: "error" | "warning";
  check: string;
  message: string;
  hint?: string;
}

export interface DoctorResult {
  issues: DoctorIssue[];
  summary: {
    manifestSkillCount: number | null;
    liveSkillCount: number;
    totalPatterns: number;
    dedupStrategy: string;
  };
}

export function doctor(projectRoot: string): DoctorResult {
  const issues: DoctorIssue[] = [];
  const skillsDir = join(projectRoot, "skills");
  const manifestPath = join(projectRoot, "generated", "skill-manifest.json");

  // --- Live scan ---
  const { validation, skills: loadedSkills, buildDiagnostics } = loadValidatedSkillMap(skillsDir);

  if (!validation.ok) {
    for (const e of validation.errors) {
      issues.push({
        severity: "error",
        check: "skill-validation",
        message: e,
      });
    }
  }

  if (validation.warnings?.length) {
    for (const w of validation.warnings) {
      issues.push({
        severity: "warning",
        check: "skill-validation",
        message: w,
      });
    }
  }

  if (buildDiagnostics.length > 0) {
    for (const d of buildDiagnostics) {
      issues.push({
        severity: "warning",
        check: "skill-build",
        message: d,
      });
    }
  }

  const liveSkills: Record<
    string,
    { priority: number; pathPatterns: string[]; bashPatterns: string[] }
  > = loadedSkills;

  const liveSkillCount = Object.keys(liveSkills).length;

  // --- Manifest parity ---
  let manifestSkillCount: number | null = null;

  if (!existsSync(manifestPath)) {
    issues.push({
      severity: "warning",
      check: "manifest-exists",
      message: "No generated/skill-manifest.json found",
      hint: "Run `bun run build:manifest` to generate it",
    });
  } else {
    let manifest: { skills: Record<string, any> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (err: any) {
      issues.push({
        severity: "error",
        check: "manifest-parse",
        message: `Failed to parse manifest: ${err.message}`,
      });
      manifest = { skills: {} };
    }

    const manifestSkills = manifest.skills ?? {};
    manifestSkillCount = Object.keys(manifestSkills).length;

    // Check for skills present in live but missing from manifest (and vice versa)
    const liveNames = new Set(Object.keys(liveSkills));
    const manifestNames = new Set(Object.keys(manifestSkills));

    const missingFromManifest = [...liveNames].filter(
      (s) => !manifestNames.has(s)
    );
    const extraInManifest = [...manifestNames].filter(
      (s) => !liveNames.has(s)
    );

    if (missingFromManifest.length > 0) {
      issues.push({
        severity: "error",
        check: "manifest-parity",
        message: `Skills in live scan but missing from manifest: ${missingFromManifest.join(", ")}`,
        hint: "Run `bun run build:manifest` to regenerate",
      });
    }

    if (extraInManifest.length > 0) {
      issues.push({
        severity: "error",
        check: "manifest-parity",
        message: `Skills in manifest but missing from live scan: ${extraInManifest.join(", ")}`,
        hint: "A skill directory may have been deleted without rebuilding the manifest",
      });
    }

    // Check for content drift (priority or pattern differences)
    if (missingFromManifest.length === 0 && extraInManifest.length === 0) {
      for (const name of liveNames) {
        const live = liveSkills[name];
        const mf = manifestSkills[name];

        if (live.priority !== mf.priority) {
          issues.push({
            severity: "error",
            check: "manifest-parity",
            message: `Skill "${name}" priority differs: live=${live.priority}, manifest=${mf.priority}`,
            hint: "Run `bun run build:manifest` to regenerate",
          });
        }

        const livePaths = (live.pathPatterns ?? []).sort().join(",");
        const mfPaths = (mf.pathPatterns ?? []).sort().join(",");
        if (livePaths !== mfPaths) {
          issues.push({
            severity: "error",
            check: "manifest-parity",
            message: `Skill "${name}" pathPatterns differ between live scan and manifest`,
            hint: "Run `bun run build:manifest` to regenerate",
          });
        }

        const liveBash = (live.bashPatterns ?? []).sort().join(",");
        const mfBash = (mf.bashPatterns ?? []).sort().join(",");
        if (liveBash !== mfBash) {
          issues.push({
            severity: "error",
            check: "manifest-parity",
            message: `Skill "${name}" bashPatterns differ between live scan and manifest`,
            hint: "Run `bun run build:manifest` to regenerate",
          });
        }
      }
    }
  }

  // --- Hook timeout risk ---
  let totalPatterns = 0;
  for (const skill of Object.values(liveSkills)) {
    totalPatterns +=
      (skill.pathPatterns?.length ?? 0) + (skill.bashPatterns?.length ?? 0);
  }

  if (liveSkillCount > SKILL_COUNT_WARN_THRESHOLD) {
    issues.push({
      severity: "warning",
      check: "hook-timeout",
      message: `${liveSkillCount} skills registered — may approach the 5-second hook timeout budget`,
      hint: "Consider consolidating low-priority skills or raising pattern specificity",
    });
  }

  if (totalPatterns > PATTERN_COUNT_WARN_THRESHOLD) {
    issues.push({
      severity: "warning",
      check: "hook-timeout",
      message: `${totalPatterns} total patterns — regex compilation overhead may threaten hook timeout`,
      hint: "Use the manifest (build:manifest) to avoid live-scan overhead at runtime",
    });
  }

  // --- Dedup env var ---
  const dedupOff =
    process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const seenSkillsEnv = process.env.VERCEL_PLUGIN_SEEN_SKILLS;
  let dedupStrategy: string;

  if (dedupOff) {
    dedupStrategy = "disabled";
    issues.push({
      severity: "warning",
      check: "dedup",
      message:
        "Deduplication is disabled (VERCEL_PLUGIN_HOOK_DEDUP=off)",
      hint: "Skills may be injected multiple times per session",
    });
  } else if (seenSkillsEnv !== undefined) {
    dedupStrategy = "env-var";
    // Validate format: should be empty or comma-delimited slugs
    if (seenSkillsEnv !== "" && !/^[\w-]+(,[\w-]+)*$/.test(seenSkillsEnv)) {
      issues.push({
        severity: "error",
        check: "dedup",
        message: `VERCEL_PLUGIN_SEEN_SKILLS has unexpected format: "${seenSkillsEnv}"`,
        hint: "Expected empty string or comma-delimited skill slugs (e.g., 'nextjs,ai-sdk')",
      });
    }
  } else {
    dedupStrategy = "memory-only";
    issues.push({
      severity: "warning",
      check: "dedup",
      message:
        "VERCEL_PLUGIN_SEEN_SKILLS is not set — dedup limited to single invocation",
      hint: "Ensure session-start-seen-skills.mjs runs on SessionStart to set the env var",
    });
  }

  return {
    issues,
    summary: {
      manifestSkillCount,
      liveSkillCount,
      totalPatterns,
      dedupStrategy,
    },
  };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];
  const { summary, issues } = result;

  lines.push("vercel-plugin doctor");
  lines.push("====================");
  lines.push("");

  lines.push(`Skills (live scan): ${summary.liveSkillCount}`);
  if (summary.manifestSkillCount !== null) {
    lines.push(`Skills (manifest):  ${summary.manifestSkillCount}`);
  }
  lines.push(`Total patterns:     ${summary.totalPatterns}`);
  lines.push(`Dedup strategy:     ${summary.dedupStrategy}`);
  lines.push("");

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (issues.length === 0) {
    lines.push("All checks passed.");
  } else {
    if (errors.length > 0) {
      lines.push(`Errors (${errors.length}):`);
      for (const e of errors) {
        lines.push(`  [${e.check}] ${e.message}`);
        if (e.hint) lines.push(`    -> ${e.hint}`);
      }
      lines.push("");
    }

    if (warnings.length > 0) {
      lines.push(`Warnings (${warnings.length}):`);
      for (const w of warnings) {
        lines.push(`  [${w.check}] ${w.message}`);
        if (w.hint) lines.push(`    -> ${w.hint}`);
      }
      lines.push("");
    }
  }

  const errorCount = errors.length;
  const warnCount = warnings.length;
  lines.push(
    `Result: ${errorCount} error(s), ${warnCount} warning(s)`
  );

  return lines.join("\n");
}
