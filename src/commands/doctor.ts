/**
 * `vercel-plugin doctor` — self-diagnosis command that checks:
 *   1. Skill map validation errors/warnings
 *   2. Hook timeout risk (skill count threshold)
 *   3. Dedup env var correctness
 *   4. Agent and command template freshness
 *
 * Exit code 0 = all checks pass, non-zero = issues found.
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
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
    liveSkillCount: number;
    totalPatterns: number;
    dedupStrategy: string;
  };
}

export function doctor(projectRoot: string): DoctorResult {
  const issues: DoctorIssue[] = [];
  const skillsDir = join(projectRoot, "skills");
  const hooksJsonPath = join(projectRoot, "hooks", "hooks.json");

  let hooksConfig: { hooks?: Record<string, any[]> } = {};
  if (existsSync(hooksJsonPath)) {
    try {
      hooksConfig = JSON.parse(readFileSync(hooksJsonPath, "utf-8"));
    } catch (err: any) {
      issues.push({
        severity: "error",
        check: "hooks",
        message: `Failed to parse hooks.json: ${err.message}`,
      });
    }
  }

  const registeredHooks = hooksConfig.hooks ?? {};
  const hasAutomaticSkillInjectionHooks =
    (registeredHooks.PreToolUse ?? []).some((entry: any) =>
      Array.isArray(entry?.hooks)
      && entry.hooks.some(
        (hook: any) =>
          typeof hook?.command === "string"
          && hook.command.includes("pretooluse-skill-inject.mjs"),
      ),
    )
    || (registeredHooks.UserPromptSubmit ?? []).some((entry: any) =>
      Array.isArray(entry?.hooks)
      && entry.hooks.some(
        (hook: any) =>
          typeof hook?.command === "string"
          && hook.command.includes("user-prompt-submit-skill-inject.mjs"),
      ),
    );

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

  // --- Hook timeout risk ---
  let totalPatterns = 0;
  for (const skill of Object.values(liveSkills)) {
    totalPatterns +=
      (skill.pathPatterns?.length ?? 0) + (skill.bashPatterns?.length ?? 0);
  }

  if (hasAutomaticSkillInjectionHooks && liveSkillCount > SKILL_COUNT_WARN_THRESHOLD) {
    issues.push({
      severity: "warning",
      check: "hook-timeout",
      message: `${liveSkillCount} skills registered — may approach the 5-second hook timeout budget`,
      hint: "Consider consolidating low-priority skills or raising pattern specificity",
    });
  }

  if (hasAutomaticSkillInjectionHooks && totalPatterns > PATTERN_COUNT_WARN_THRESHOLD) {
    issues.push({
      severity: "warning",
      check: "hook-timeout",
      message: `${totalPatterns} total patterns — regex compilation overhead may threaten hook timeout`,
      hint: "Consider consolidating redundant patterns or raising pattern specificity",
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

  // --- Stale generated files (template newer than output) ---
  const tmplDirs = [join(projectRoot, "agents"), join(projectRoot, "commands")];
  for (const dir of tmplDirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md.tmpl")) continue;
      const tmplPath = join(dir, f);
      const outPath = join(dir, f.replace(/\.md\.tmpl$/, ".md"));

      if (!existsSync(outPath)) {
        issues.push({
          severity: "error",
          check: "template-staleness",
          message: `Template ${f} has no generated output: ${f.replace(/\.tmpl$/, "")}`,
          hint: "Run `bun run build:from-skills` to generate it",
        });
        continue;
      }

      const tmplMtime = statSync(tmplPath).mtimeMs;
      const outMtime = statSync(outPath).mtimeMs;
      if (tmplMtime > outMtime) {
        issues.push({
          severity: "error",
          check: "template-staleness",
          message: `${f} is newer than its output ${f.replace(/\.tmpl$/, "")}`,
          hint: "Run `bun run build:from-skills` to regenerate",
        });
      }
    }
  }

  // Check if any SKILL.md is newer than the oldest generated .md
  const skillsRoot = join(projectRoot, "skills");
  if (existsSync(skillsRoot)) {
    let newestSkillMtime = 0;
    try {
      for (const skillDir of readdirSync(skillsRoot)) {
        const skillFile = join(skillsRoot, skillDir, "SKILL.md");
        if (existsSync(skillFile)) {
          const mtime = statSync(skillFile).mtimeMs;
          if (mtime > newestSkillMtime) newestSkillMtime = mtime;
        }
      }
    } catch {
      // skip if skills dir is unreadable
    }

    if (newestSkillMtime > 0) {
      for (const dir of tmplDirs) {
        if (!existsSync(dir)) continue;
        let files: string[];
        try {
          files = readdirSync(dir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith(".md.tmpl")) continue;
          const outPath = join(dir, f.replace(/\.md\.tmpl$/, ".md"));
          if (!existsSync(outPath)) continue;
          const outMtime = statSync(outPath).mtimeMs;
          if (newestSkillMtime > outMtime) {
            issues.push({
              severity: "warning",
              check: "template-staleness",
              message: `A SKILL.md was modified after ${f.replace(/\.tmpl$/, "")} was last generated`,
              hint: "Run `bun run build:from-skills` to regenerate (skill content may have changed)",
            });
            break; // One warning per dir is enough
          }
        }
      }
    }
  }

  if (!existsSync(hooksJsonPath)) {
    issues.push({
      severity: "error",
      check: "hooks",
      message: "hooks/hooks.json not found",
      hint: "Ensure hooks/hooks.json exists",
    });
  }

  return {
    issues,
    summary: {
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
