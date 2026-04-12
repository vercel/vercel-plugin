#!/usr/bin/env bun
/**
 * Structural validation for the Vercel ecosystem plugin.
 * Checks cross-references, frontmatter, manifest completeness, and hooks validity.
 *
 * Usage: bun run scripts/validate.ts [options]
 *   --format pretty|json   Output format (default: pretty)
 *   --coverage skip         Skip the coverage baseline check
 *   --help                  Print usage and exit
 *
 * Exits 0 on success, non-zero on failure.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkCoverage, type CoverageResult } from "./coverage-baseline";
import { extractFrontmatter, parseSkillFrontmatter, buildSkillMap, validateSkillMap } from "../hooks/skill-map-frontmatter.mjs";
import { globToRegex, importPatternToRegex, compileSkillPatterns, matchPathWithReason, matchBashWithReason } from "../hooks/patterns.mjs";
import { buildManifest, writeManifestFile } from "./build-manifest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Issue {
  code: string;
  severity: "error" | "warning";
  message: string;
  check: string;
  file?: string;
  line?: number;
  hint?: string;
}

interface CheckResult {
  name: string;
  label: string;
  status: "pass" | "fail" | "warn";
  durationMs: number;
  errorCount: number;
  warningCount: number;
}

interface ValidationReport {
  version: 1;
  timestamp: string;
  summary: { errors: number; warnings: number; checks: number };
  checkResults: CheckResult[];
  metrics: CheckMetric[];
  issues: Issue[];
  orphanSkills: string[];
}

interface CheckMetric {
  name: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: bun run scripts/validate.ts [options]

Options:
  --format pretty|json   Output format (default: pretty)
  --coverage skip        Skip the coverage baseline check
  --help                 Print this help and exit`);
}

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    format: { type: "string", default: "pretty" },
    coverage: { type: "string", default: "run" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (flags.help) {
  printUsage();
  process.exit(0);
}

const FORMAT = flags.format === "json" ? "json" : "pretty";
const SKIP_COVERAGE = flags.coverage === "skip";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const issues: Issue[] = [];
let checks = 0;
let currentCheck = "unknown";

function fail(code: string, message: string, extra?: { file?: string; line?: number; hint?: string }) {
  issues.push({ code, severity: "error", message, check: currentCheck, ...extra });
  if (FORMAT === "pretty") console.error(`  ✗ ${message}`);
}

function warn(code: string, message: string, extra?: { file?: string; line?: number; hint?: string }) {
  issues.push({ code, severity: "warning", message, check: currentCheck, ...extra });
  if (FORMAT === "pretty") console.log(`  ⚠ ${message}`);
}

function pass(msg: string) {
  if (FORMAT === "pretty") console.log(`  ✓ ${msg}`);
}

function section(label: string) {
  checks++;
  if (FORMAT === "pretty") console.log(`\n${label}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse YAML frontmatter from markdown content using the inline parser in skill-map-frontmatter.mjs.
 * Returns the parsed object (with nested metadata) or null if no frontmatter found.
 * Throws on malformed YAML so callers can report actionable errors.
 */
function parseFrontmatter(content: string): Record<string, any> | null {
  const { yaml: yamlStr } = extractFrontmatter(content);
  if (!yamlStr) return null;
  // parseSkillFrontmatter uses js-yaml; let YAML parse errors propagate
  const parsed = parseSkillFrontmatter(yamlStr);
  return { name: parsed.name, description: parsed.description, metadata: parsed.metadata };
}

function lineOf(content: string, needle: string): number | undefined {
  const idx = content.indexOf(needle);
  if (idx === -1) return undefined;
  return content.slice(0, idx).split("\n").length;
}

// ---------------------------------------------------------------------------
// 1. Validate ⤳ skill: references in ecosystem graph
// ---------------------------------------------------------------------------

async function validateGraphSkillRefs() {
  section("[1] Ecosystem graph → skill cross-references");

  const graphPath = join(ROOT, "vercel.md");
  if (!(await exists(graphPath))) {
    fail("GRAPH_MISSING", "vercel.md not found", {
      file: "vercel.md",
      hint: "Create vercel.md with ⤳ skill: references",
    });
    return;
  }

  const graph = await readFile(graphPath, "utf-8");
  const refs = [...graph.matchAll(/⤳\s*skill:\s*([a-z][a-z0-9-]*)/g)].map((m) => ({
    name: m[1],
    line: lineOf(graph, m[0]),
  }));

  if (refs.length === 0) {
    fail("GRAPH_NO_REFS", "No ⤳ skill: references found in ecosystem graph", {
      file: "vercel.md",
      hint: "Add ⤳ skill:<name> references to link graph nodes to bundled skills",
    });
    return;
  }

  const seen = new Set<string>();
  for (const { name, line } of refs) {
    if (seen.has(name)) continue;
    seen.add(name);
    const skillPath = join(ROOT, "skills", name, "SKILL.md");
    if (await exists(skillPath)) {
      pass(`⤳ skill:${name} → skills/${name}/SKILL.md`);
    } else {
      fail("SKILL_REF_BROKEN", `⤳ skill:${name} referenced in graph but skills/${name}/SKILL.md not found`, {
        file: "vercel.md",
        line,
        hint: `Create skills/${name}/SKILL.md or remove the reference`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 1b. Detect orphan skills (skill dirs with no graph reference)
// ---------------------------------------------------------------------------

const orphanSkills: string[] = [];

async function validateOrphanSkills() {
  section("[1b] Orphan skill detection (skills/ dirs without graph references)");

  const graphPath = join(ROOT, "vercel.md");
  if (!(await exists(graphPath))) return; // already reported in [1]

  const graph = await readFile(graphPath, "utf-8");
  const referencedSkills = new Set(
    [...graph.matchAll(/⤳\s*skill:\s*([a-z][a-z0-9-]*)/g)].map((m) => m[1]),
  );

  const skillsDir = join(ROOT, "skills");
  if (!(await exists(skillsDir))) return;

  const dirs = await readdir(skillsDir);
  for (const dir of dirs.sort()) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!(await exists(skillPath))) continue;

    if (referencedSkills.has(dir)) {
      pass(`skills/${dir} referenced in ecosystem graph`);
    } else {
      orphanSkills.push(dir);
      fail("ORPHAN_SKILL", `skills/${dir} has no ⤳ skill:${dir} reference in ecosystem graph`, {
        file: `skills/${dir}/SKILL.md`,
        hint: `Add "⤳ skill: ${dir}" to the appropriate section in vercel.md`,
      });
    }
  }

  if (orphanSkills.length === 0) {
    pass("All skill directories are referenced in the ecosystem graph");
  }
}

// ---------------------------------------------------------------------------
// 2. Validate SKILL.md frontmatter
// ---------------------------------------------------------------------------

async function validateSkillFrontmatter(): Promise<void> {
  section("[2] SKILL.md YAML frontmatter");

  const skillsDir = join(ROOT, "skills");
  const dirs = await readdir(skillsDir);

  for (const dir of dirs.sort()) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!(await exists(skillPath))) continue;

    const content = await readFile(skillPath, "utf-8");

    let fm: Record<string, any> | null;
    try {
      fm = parseFrontmatter(content);
    } catch (err: any) {
      fail("FM_INVALID_YAML", `skills/${dir}/SKILL.md — invalid YAML frontmatter: ${err.message}`, {
        file: `skills/${dir}/SKILL.md`,
        line: 1,
        hint: "Fix the YAML syntax in the frontmatter block",
      });
      continue;
    }

    if (!fm) {
      fail("FM_MISSING", `skills/${dir}/SKILL.md — missing YAML frontmatter`, {
        file: `skills/${dir}/SKILL.md`,
        hint: "Add --- delimited YAML frontmatter with name and description fields",
      });
      continue;
    }
    if (!fm.name) {
      fail("FM_NO_NAME", `skills/${dir}/SKILL.md — frontmatter missing 'name' field`, {
        file: `skills/${dir}/SKILL.md`,
        line: 1,
        hint: "Add 'name: <skill-name>' to the YAML frontmatter block",
      });
    }
    if (!fm.description) {
      fail("FM_NO_DESC", `skills/${dir}/SKILL.md — frontmatter missing 'description' field`, {
        file: `skills/${dir}/SKILL.md`,
        line: 1,
        hint: "Add 'description: <brief summary>' to the YAML frontmatter block",
      });
    }

    // Validate metadata.docs: must be a non-empty array of HTTPS URLs
    const docs = fm.metadata?.docs;
    if (!docs || !Array.isArray(docs) || docs.length === 0) {
      fail("FM_NO_DOCS", `skills/${dir}/SKILL.md — metadata.docs is missing or empty`, {
        file: `skills/${dir}/SKILL.md`,
        line: 1,
        hint: "Add metadata.docs with at least one HTTPS URL to official documentation",
      });
    } else {
      for (let i = 0; i < docs.length; i++) {
        const url = docs[i];
        if (typeof url !== "string" || !url.startsWith("https://")) {
          fail("FM_DOCS_INVALID_URL", `skills/${dir}/SKILL.md — metadata.docs[${i}] is not a valid HTTPS URL: ${url}`, {
            file: `skills/${dir}/SKILL.md`,
            line: 1,
            hint: "Each docs entry must be an HTTPS URL (e.g., 'https://nextjs.org/docs')",
          });
        }
      }
    }

    // Type-check metadata fields via shared validator (buildSkillMap + validateSkillMap)
    // is done below after the per-file loop.

    if (fm.name && fm.description) {
      pass(`skills/${dir}/SKILL.md — name: "${fm.name}", description present`);
    }
  }

  // Run the shared buildSkillMap + validateSkillMap pipeline to catch
  // metadata type issues (pathPatterns/bashPatterns not arrays, bad priority, etc.)
  // Uses structured warningDetails to avoid brittle regex-parsing of warning strings.
  const built = buildSkillMap(skillsDir);

  // Surface buildSkillMap coercion warnings as validation issues via structured details
  for (const d of built.warningDetails) {
    const skillName = d.skill || "unknown";

    if (d.field === "pathPatterns" && (d.code === "INVALID_TYPE" || d.code === "COERCE_STRING_TO_ARRAY")) {
      const suffix = d.code === "COERCE_STRING_TO_ARRAY" ? ", got string" : "";
      fail("FM_PATHPATTERNS_TYPE", `skills/${skillName}/SKILL.md — metadata.pathPatterns must be an array${suffix}`, {
        file: `skills/${skillName}/SKILL.md`,
        line: 1,
        hint: d.hint || "Change metadata.pathPatterns to a YAML list (e.g., pathPatterns:\\n  - 'src/**')",
      });
    } else if (d.field === "bashPatterns" && (d.code === "INVALID_TYPE" || d.code === "COERCE_STRING_TO_ARRAY")) {
      const suffix = d.code === "COERCE_STRING_TO_ARRAY" ? ", got string" : "";
      fail("FM_BASHPATTERNS_TYPE", `skills/${skillName}/SKILL.md — metadata.bashPatterns must be an array${suffix}`, {
        file: `skills/${skillName}/SKILL.md`,
        line: 1,
        hint: d.hint || "Change metadata.bashPatterns to a YAML list (e.g., bashPatterns:\\n  - '\\\\bvercel\\\\b')",
      });
    } else if (d.field === "importPatterns" && (d.code === "INVALID_TYPE" || d.code === "COERCE_STRING_TO_ARRAY")) {
      const suffix = d.code === "COERCE_STRING_TO_ARRAY" ? ", got string" : "";
      fail("FM_IMPORTPATTERNS_TYPE", `skills/${skillName}/SKILL.md — metadata.importPatterns must be an array${suffix}`, {
        file: `skills/${skillName}/SKILL.md`,
        line: 1,
        hint: d.hint || "Change metadata.importPatterns to a YAML list (e.g., importPatterns:\\n  - '@ai-sdk/gateway')",
      });
    } else if (d.code === "DEPRECATED_FIELD") {
      warn("FM_DEPRECATED_FIELD", `skills/${skillName}/SKILL.md — ${d.message}`, {
        file: `skills/${skillName}/SKILL.md`,
        line: 1,
        hint: d.hint || `Rename metadata.${d.field} to its canonical name`,
      });
    }
  }

  // Run shared validator on the built map for structural issues
  const validation = validateSkillMap(built);
  if (!validation.ok) {
    for (const d of (validation.errorDetails ?? [])) {
      const skillName = d.skill || "unknown";
      fail("FM_VALIDATION", `skills/${skillName}/SKILL.md — ${d.message}`, {
        file: `skills/${skillName}/SKILL.md`,
        line: 1,
        hint: d.hint || "Fix the YAML frontmatter metadata fields",
      });
    }
  } else {
    for (const d of (validation.warningDetails ?? [])) {
      const skillName = d.skill || "unknown";

      if (d.code === "INVALID_PRIORITY") {
        fail("FM_PRIORITY_TYPE", `skills/${skillName}/SKILL.md — metadata.priority must be a number`, {
          file: `skills/${skillName}/SKILL.md`,
          line: 1,
          hint: d.hint || "Set metadata.priority to a numeric value (e.g., priority: 5)",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Validate plugin.json enumerates all capabilities
// ---------------------------------------------------------------------------

async function validatePluginJson() {
  section("[3] plugin.json validity");

  const manifestPath = join(ROOT, ".plugin", "plugin.json");
  if (!(await exists(manifestPath))) {
    fail("MANIFEST_MISSING", ".plugin/plugin.json not found", {
      file: ".plugin/plugin.json",
      hint: "Create .plugin/plugin.json with name, version, and description",
    });
    return;
  }

  let manifest: any;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch (e) {
    fail("MANIFEST_INVALID", `.plugin/plugin.json is not valid JSON: ${e}`, {
      file: ".plugin/plugin.json",
      hint: "Fix JSON syntax errors in .plugin/plugin.json",
    });
    return;
  }

  // Required metadata fields (open-plugin spec — components are discovered from directories)
  for (const field of ["name", "version", "description"]) {
    if (manifest[field]) {
      pass(`plugin.json has "${field}": "${String(manifest[field]).slice(0, 60)}${String(manifest[field]).length > 60 ? "…" : ""}"`);
    } else {
      fail("MANIFEST_FIELD_MISSING", `plugin.json missing required field "${field}"`, {
        file: ".plugin/plugin.json",
        hint: `Add "${field}" to .plugin/plugin.json`,
      });
    }
  }

  // vercel.md (ecosystem graph + conventions)
  const vercelMd = join(ROOT, "vercel.md");
  if (await exists(vercelMd)) {
    pass("vercel.md exists (ecosystem graph + conventions)");
  }
}

// ---------------------------------------------------------------------------
// 4. Validate hooks.json
// ---------------------------------------------------------------------------

async function validateHooksJson() {
  section("[4] hooks.json validity");

  const hooksPath = join(ROOT, "hooks", "hooks.json");
  if (!(await exists(hooksPath))) {
    fail("HOOKS_MISSING", "hooks/hooks.json not found", {
      file: "hooks/hooks.json",
      hint: "Create hooks/hooks.json with your hook definitions",
    });
    return;
  }

  try {
    const content = await readFile(hooksPath, "utf-8");
    JSON.parse(content);
    pass("hooks/hooks.json is valid JSON");
  } catch (e) {
    fail("HOOKS_INVALID", `hooks/hooks.json is not valid JSON: ${e}`, {
      file: "hooks/hooks.json",
      hint: "Fix JSON syntax errors in hooks/hooks.json",
    });
  }
}

// ---------------------------------------------------------------------------
// 5. Coverage baseline — llms.txt vs ecosystem graph
// ---------------------------------------------------------------------------

async function validateCoverageBaseline() {
  if (SKIP_COVERAGE) {
    section("[5] llms.txt coverage baseline (skipped)");
    if (FORMAT === "pretty") console.log("  — skipped via --coverage skip");
    return;
  }

  section("[5] llms.txt coverage baseline");

  try {
    const result: CoverageResult = await checkCoverage(ROOT);
    const { total, covered, missing } = result;

    if (missing.length === 0) {
      pass(`All ${total} llms.txt products covered in ecosystem graph`);
    } else {
      warn("COVERAGE_GAP", `Coverage: ${covered.length}/${total} products covered, ${missing.length} missing`, {
        hint: "Run: bun run scripts/coverage-baseline.ts for details",
      });
    }
  } catch (e) {
    warn("COVERAGE_SKIPPED", `Coverage check skipped: ${e}`, {
      hint: "Check network connectivity or use --coverage skip to bypass",
    });
  }
}

// ---------------------------------------------------------------------------
// 6. Validate command conventions (required sections)
// ---------------------------------------------------------------------------

const CRITICAL_COMMAND_SECTIONS = ["Preflight", "Verification"];
const RECOMMENDED_COMMAND_SECTIONS = ["Plan", "Commands", "Summary", "Next Steps"];
const ALL_COMMAND_SECTIONS = [...CRITICAL_COMMAND_SECTIONS, ...RECOMMENDED_COMMAND_SECTIONS];

const DESTRUCTIVE_PATTERNS = [
  /vercel\s+--prod\b/,
  /vercel\s+deploy\s+--prod\b/,
  /vercel\s+env\s+rm\b/,
  /vercel\s+env\s+remove\b/,
];

const SAFETY_PATTERNS = [/confirm/i, /⚠/, /explicit/i];

async function validateCommandConventions() {
  section("[6] Command conventions (sections, CLI examples, safety)");

  const commandsDir = join(ROOT, "commands");
  if (!(await exists(commandsDir))) {
    fail("COMMANDS_DIR_MISSING", "commands/ directory not found", {
      file: "commands/",
      hint: "Create a commands/ directory with slash command .md files",
    });
    return;
  }

  const cmdFiles = (await readdir(commandsDir))
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .sort();

  if (cmdFiles.length === 0) {
    warn("NO_COMMANDS", "No command files found in commands/", {
      file: "commands/",
      hint: "Add .md command files to commands/",
    });
    return;
  }

  for (const file of cmdFiles) {
    const filePath = join(commandsDir, file);
    const content = await readFile(filePath, "utf-8");

    // Check frontmatter
    const fm = parseFrontmatter(content);
    if (!fm || !fm.description) {
      fail("CMD_NO_DESCRIPTION", `commands/${file} — missing frontmatter description`, {
        file: `commands/${file}`,
        line: 1,
        hint: "Add YAML frontmatter with a 'description' field",
      });
    }

    // Check required sections (look for ## headings containing the section name)
    const missingSections: string[] = [];
    for (const sectionName of ALL_COMMAND_SECTIONS) {
      const pattern = new RegExp(`^#{2,3}\\s+.*${sectionName.replace(/\s+/g, "\\s+")}`, "im");
      if (!pattern.test(content)) {
        missingSections.push(sectionName);
      }
    }

    if (missingSections.length > 0) {
      const critical = missingSections.filter((s) => CRITICAL_COMMAND_SECTIONS.includes(s));
      const recommended = missingSections.filter((s) => RECOMMENDED_COMMAND_SECTIONS.includes(s));

      if (critical.length > 0) {
        fail("CMD_MISSING_CRITICAL_SECTIONS", `commands/${file} — missing critical sections: ${critical.join(", ")}`, {
          file: `commands/${file}`,
          hint: `Add the following required sections: ${critical.join(", ")}. See commands/_conventions.md for details.`,
        });
      }
      if (recommended.length > 0) {
        warn("CMD_MISSING_SECTIONS", `commands/${file} — missing recommended sections: ${recommended.join(", ")}`, {
          file: `commands/${file}`,
          hint: `Add the following sections: ${recommended.join(", ")}. See commands/_conventions.md for details.`,
        });
      }
    } else {
      pass(`commands/${file} — all required sections present`);
    }

    // Check for at least one backtick-fenced vercel CLI example
    const codeBlocks = [...content.matchAll(/```[a-z]*\n([\s\S]*?)```/g)];
    const hasVercelCliExample = codeBlocks.some((m) => /\bvercel\b/.test(m[1]));

    if (!hasVercelCliExample) {
      fail("CMD_NO_CLI_EXAMPLE", `commands/${file} — no backtick-fenced vercel CLI example found`, {
        file: `commands/${file}`,
        hint: "Add at least one fenced code block containing a vercel CLI command (e.g., ```bash\\nvercel deploy\\n```)",
      });
    } else {
      pass(`commands/${file} — contains vercel CLI example(s)`);
    }

    // Check that destructive commands include confirmation/safety language
    const hasDestructiveOps = DESTRUCTIVE_PATTERNS.some((p) => p.test(content));
    if (hasDestructiveOps) {
      const hasSafetyLanguage = SAFETY_PATTERNS.some((p) => p.test(content));
      if (!hasSafetyLanguage) {
        fail("CMD_UNSAFE_DESTRUCTIVE", `commands/${file} — contains destructive operations without confirmation/safety language`, {
          file: `commands/${file}`,
          hint: "Add confirmation prompts and safety warnings (⚠️, explicit confirmation) for destructive operations like --prod deploys and env rm",
        });
      } else {
        pass(`commands/${file} — destructive operations include safety language`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Validate CLI banned patterns in code fences
// ---------------------------------------------------------------------------

const CLI_BANNED_PATTERNS: { pattern: RegExp; hint: string }[] = [
  {
    pattern: /vercel\s+logs\s+.*--build/,
    hint: "Build logs are not available via 'vercel logs'. Use 'vercel inspect <deployment> --logs' instead.",
  },
  {
    pattern: /vercel\s+logs\s+drain/,
    hint: "Log drains are configured via the Vercel Dashboard or REST API, not 'vercel logs drain'.",
  },
  {
    pattern: /vercel\s+integration\s+(dev|deploy|publish|status)/,
    hint: "This 'vercel integration' subcommand does not exist. Valid subcommands include: add, open, list, remove, discover, guide, balance. Check 'vercel integration --help'.",
  },
];

async function validateCliBannedPatterns() {
  section("[7] CLI banned-pattern scan (skills + commands)");

  const dirs = [join(ROOT, "skills"), join(ROOT, "commands")];
  const mdFiles: { relPath: string; absPath: string }[] = [];

  for (const dir of dirs) {
    if (!(await exists(dir))) continue;
    const entries = await readdir(dir, { recursive: true });
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry.startsWith("_")) continue;
      const absPath = join(dir, entry);
      const relPath = absPath.slice(ROOT.length + 1);
      mdFiles.push({ relPath, absPath });
    }
  }

  let violations = 0;

  for (const { relPath, absPath } of mdFiles) {
    const content = await readFile(absPath, "utf-8");
    // Extract code fence contents
    const fences = [...content.matchAll(/```[a-z]*\n([\s\S]*?)```/g)];

    for (const fence of fences) {
      const fenceText = fence[1];
      const fenceStartIdx = content.indexOf(fence[0]);
      const fenceStartLine = content.slice(0, fenceStartIdx).split("\n").length;

      for (const { pattern, hint } of CLI_BANNED_PATTERNS) {
        const lines = fenceText.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            violations++;
            const line = fenceStartLine + 1 + i; // +1 for the opening ``` line
            fail("CLI_BANNED_PATTERN", `${relPath}:${line} — banned CLI pattern: ${lines[i].trim()}`, {
              file: relPath,
              line,
              hint,
            });
          }
        }
      }
    }
  }

  if (violations === 0) {
    pass("No banned CLI patterns found in code fences");
  }
}

// ---------------------------------------------------------------------------
// 8. Validate hook-driven injection coverage and skill frontmatter
// ---------------------------------------------------------------------------

async function validatePreToolUseHook() {
  section("[8] Hook-driven injection and skill frontmatter coverage");

  // 8a. Check whether the optional PreToolUse injection hook is registered.
  const hooksPath = join(ROOT, "hooks", "hooks.json");
  if (!(await exists(hooksPath))) {
    fail("HOOKS_MISSING", "hooks/hooks.json not found (cannot validate hook-driven injection wiring)", {
      file: "hooks/hooks.json",
      hint: "Create hooks/hooks.json with your hook definitions",
    });
    return;
  }

  let hooks: any;
  try {
    hooks = JSON.parse(await readFile(hooksPath, "utf-8"));
  } catch {
    // Already reported in check [4]
    return;
  }

  const preToolUse = hooks?.hooks?.PreToolUse;
  const hasPreToolUse = Array.isArray(preToolUse) && preToolUse.length > 0;

  if (!hasPreToolUse) {
    pass("No PreToolUse hook registered by default; hook wiring check skipped");
  } else {
    // Check matcher covers Read|Edit|Write|Bash
    const matcher = preToolUse[0]?.matcher || "";
    for (const tool of ["Read", "Edit", "Write", "Bash"]) {
      if (!matcher.includes(tool)) {
        fail("PRETOOLUSE_MATCHER_INCOMPLETE", `PreToolUse matcher missing "${tool}" — current: "${matcher}"`, {
          file: "hooks/hooks.json",
          hint: `Add "${tool}" to the PreToolUse matcher pattern`,
        });
      }
    }
    if (["Read", "Edit", "Write", "Bash"].every((t) => matcher.includes(t))) {
      pass("PreToolUse matcher covers Read|Edit|Write|Bash");
    }

    // 8b. Check referenced hook script exists
    const hookCmd = preToolUse[0]?.hooks?.[0]?.command || "";
    const scriptMatch = hookCmd.match(/pretooluse-skill-inject\.mjs/);
    if (!scriptMatch) {
      fail("PRETOOLUSE_SCRIPT_REF", "PreToolUse hook command does not reference pretooluse-skill-inject.mjs", {
        file: "hooks/hooks.json",
        hint: "Set the hook command to reference pretooluse-skill-inject.mjs",
      });
    } else {
      const scriptPath = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
      if (await exists(scriptPath)) {
        pass("pretooluse-skill-inject.mjs exists");
      } else {
        fail("PRETOOLUSE_SCRIPT_MISSING", "hooks/pretooluse-skill-inject.mjs not found", {
          file: "hooks/pretooluse-skill-inject.mjs",
          hint: "Create the PreToolUse hook script at hooks/pretooluse-skill-inject.mjs",
        });
      }
    }
  }

  // 8b. Validate skill frontmatter triggers
  // Every skills/*/SKILL.md should have metadata.pathPatterns or metadata.bashPatterns
  const skillsDir = join(ROOT, "skills");
  if (!(await exists(skillsDir))) {
    fail("SKILLS_DIR_MISSING", "skills/ directory not found", {
      file: "skills/",
      hint: "Create a skills/ directory with skill subdirectories containing SKILL.md",
    });
    return;
  }

  const dirs = await readdir(skillsDir);
  const noTriggers: string[] = [];
  let skillCount = 0;

  for (const dir of dirs.sort()) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!(await exists(skillPath))) continue;
    skillCount++;

    const content = await readFile(skillPath, "utf-8");
    let fm: Record<string, any> | null;
    try {
      fm = parseFrontmatter(content);
    } catch {
      continue; // YAML errors already reported in section [2]
    }
    if (!fm) continue; // frontmatter presence already checked in section [2]

    const meta = fm.metadata ?? {};
    // Check canonical names only — deprecated filePattern/bashPattern are
    // normalized by buildSkillMap's compat shim and warned about in section [2].
    const hasPathPatterns = Array.isArray(meta.pathPatterns) && meta.pathPatterns.length > 0;
    const hasBashPatterns = Array.isArray(meta.bashPatterns) && meta.bashPatterns.length > 0;
    const hasImportPatterns = Array.isArray(meta.importPatterns) && meta.importPatterns.length > 0;

    if (!hasPathPatterns && !hasBashPatterns && !hasImportPatterns) {
      noTriggers.push(dir);
      fail("SKILL_NO_TRIGGERS", `skills/${dir}/SKILL.md has no pathPatterns, bashPatterns, or importPatterns in frontmatter metadata`, {
        file: `skills/${dir}/SKILL.md`,
        hint: `Add metadata.pathPatterns, metadata.bashPatterns, or metadata.importPatterns to the YAML frontmatter`,
      });
    }
  }

  if (noTriggers.length === 0 && skillCount > 0) {
    pass("All skills have trigger patterns in frontmatter");
  }
}

// ---------------------------------------------------------------------------
// 9. Validate pattern compilation (pathPatterns → globToRegex, bashPatterns → RegExp)
// ---------------------------------------------------------------------------

/**
 * Detect obvious catastrophic backtracking risk in a regex pattern string.
 * Flags nested quantifiers like (a+)+, (a*)+, (a+)*, (.+.+)+, etc.
 * Returns a description of the risk if found, or null if safe.
 */
export function detectReDoS(pattern: string): string | null {
  // Nested quantifier: a group containing a quantifier, followed by a quantifier
  // e.g. (a+)+  (.*)+  (\w+)*  ([^/]+)+
  if (/\([^)]*[+*]\)[+*{]/.test(pattern)) {
    return "nested quantifiers — group with inner quantifier followed by outer quantifier";
  }
  // Overlapping alternation with quantifier: (a|a)+  or (.*|.+)+
  if (/\(([^)]*\|[^)]*)\)[+*{]/.test(pattern)) {
    const m = pattern.match(/\(([^)]*\|[^)]*)\)[+*{]/);
    if (m) {
      const alts = m[1].split("|").map((a) => a.trim());
      // Flag if any two alternatives could match the same character class
      // Simple heuristic: check for dot-quantifier alternatives
      const hasDotStar = alts.some((a) => /^\.\*$|^\.\+$/.test(a));
      if (hasDotStar && alts.length > 1) {
        return "overlapping alternation with quantifier — alternatives may match same input";
      }
    }
  }
  // Quantified backreference (rare but dangerous)
  if (/\\[1-9]\d*[+*{]/.test(pattern)) {
    return "quantified backreference";
  }
  return null;
}

async function validatePatternCompilation() {
  section("[9] Pattern compilation (pathPatterns + bashPatterns)");

  const skillsDir = join(ROOT, "skills");
  if (!(await exists(skillsDir))) return; // already reported elsewhere

  const dirs = await readdir(skillsDir);
  let compiled = 0;
  let failures = 0;
  let redosWarnings = 0;

  for (const dir of dirs.sort()) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!(await exists(skillPath))) continue;

    const content = await readFile(skillPath, "utf-8");
    let fm: Record<string, any> | null;
    try {
      fm = parseFrontmatter(content);
    } catch {
      continue; // YAML errors already reported in section [2]
    }
    if (!fm) continue;

    const meta = fm.metadata ?? {};

    // Compile pathPatterns via globToRegex (canonical name only —
    // deprecated filePattern is normalized by buildSkillMap's compat shim)
    const pathPatternsRaw: unknown[] = Array.isArray(meta.pathPatterns) ? meta.pathPatterns : [];
    for (let idx = 0; idx < pathPatternsRaw.length; idx++) {
      const pat = pathPatternsRaw[idx];
      if (typeof pat !== "string") {
        failures++;
        fail("PATTERN_PATH_COMPILE", `skills/${dir}/SKILL.md — pathPatterns[${idx}] is not a string (${typeof pat})`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Each pathPatterns entry must be a string glob pattern",
        });
        continue;
      }
      if (pat === "") {
        failures++;
        fail("PATTERN_PATH_COMPILE", `skills/${dir}/SKILL.md — pathPatterns[${idx}] is empty`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Remove empty entries from metadata.pathPatterns",
        });
        continue;
      }
      try {
        const compiledRegex = globToRegex(pat);
        compiled++;

        // Check the compiled regex for catastrophic backtracking risk
        const redosRisk = detectReDoS(compiledRegex.source);
        if (redosRisk) {
          redosWarnings++;
          fail("PATTERN_PATH_REDOS", `skills/${dir}/SKILL.md — pathPatterns "${pat}" compiles to regex with catastrophic backtracking risk: ${redosRisk}`, {
            file: `skills/${dir}/SKILL.md`,
            hint: "Rewrite the glob pattern to avoid nested quantifiers in the compiled regex.",
          });
        }
      } catch (err: any) {
        failures++;
        fail("PATTERN_PATH_COMPILE", `skills/${dir}/SKILL.md — pathPatterns "${pat}" failed to compile: ${err.message}`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Fix the glob pattern syntax in metadata.pathPatterns",
        });
      }
    }

    // Compile bashPatterns as RegExp (canonical name only —
    // deprecated bashPattern is normalized by buildSkillMap's compat shim)
    const bashPatternsRaw: unknown[] = Array.isArray(meta.bashPatterns) ? meta.bashPatterns : [];
    for (let idx = 0; idx < bashPatternsRaw.length; idx++) {
      const pat = bashPatternsRaw[idx];
      if (typeof pat !== "string") {
        failures++;
        fail("PATTERN_BASH_COMPILE", `skills/${dir}/SKILL.md — bashPatterns[${idx}] is not a string (${typeof pat})`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Each bashPatterns entry must be a string regex pattern",
        });
        continue;
      }
      if (pat === "") {
        failures++;
        fail("PATTERN_BASH_COMPILE", `skills/${dir}/SKILL.md — bashPatterns[${idx}] is empty`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Remove empty entries from metadata.bashPatterns",
        });
        continue;
      }
      try {
        new RegExp(pat);
        compiled++;
      } catch (err: any) {
        failures++;
        fail("PATTERN_BASH_COMPILE", `skills/${dir}/SKILL.md — bashPatterns "${pat}" failed to compile: ${err.message}`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Fix the regex syntax in metadata.bashPatterns",
        });
        continue;
      }

      // Check for catastrophic backtracking risk
      const redosRisk = detectReDoS(pat);
      if (redosRisk) {
        redosWarnings++;
        fail("PATTERN_BASH_REDOS", `skills/${dir}/SKILL.md — bashPatterns "${pat}" has catastrophic backtracking risk: ${redosRisk}`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Rewrite the regex to avoid nested quantifiers. Use atomic groups or possessive quantifiers, or simplify the pattern.",
        });
      }
    }

    // Compile importPatterns via importPatternToRegex
    const importPatternsRaw: unknown[] = Array.isArray(meta.importPatterns) ? meta.importPatterns : [];
    for (let idx = 0; idx < importPatternsRaw.length; idx++) {
      const pat = importPatternsRaw[idx];
      if (typeof pat !== "string") {
        failures++;
        fail("PATTERN_IMPORT_COMPILE", `skills/${dir}/SKILL.md — importPatterns[${idx}] is not a string (${typeof pat})`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Each importPatterns entry must be a string package name",
        });
        continue;
      }
      if (pat === "") {
        failures++;
        fail("PATTERN_IMPORT_COMPILE", `skills/${dir}/SKILL.md — importPatterns[${idx}] is empty`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Remove empty entries from metadata.importPatterns",
        });
        continue;
      }
      try {
        importPatternToRegex(pat);
        compiled++;
      } catch (err: any) {
        failures++;
        fail("PATTERN_IMPORT_COMPILE", `skills/${dir}/SKILL.md — importPatterns "${pat}" failed to compile: ${err.message}`, {
          file: `skills/${dir}/SKILL.md`,
          hint: "Fix the import pattern in metadata.importPatterns",
        });
      }
    }
  }

  if (failures === 0 && redosWarnings === 0 && compiled > 0) {
    pass(`All ${compiled} patterns compiled successfully (no ReDoS risks detected)`);
  } else if (failures === 0 && redosWarnings > 0 && compiled > 0) {
    pass(`All ${compiled} patterns compiled, but ${redosWarnings} ReDoS warning(s)`);
  }
}

// ---------------------------------------------------------------------------
// 10. Validate skill catalog is not stale vs skills/ directory
// ---------------------------------------------------------------------------

async function validateCatalogStaleness() {
  section("[10] Skill catalog staleness");

  const catalogPath = join(ROOT, "generated", "skill-catalog.md");
  if (!(await exists(catalogPath))) {
    fail("CATALOG_MISSING", "generated/skill-catalog.md not found", {
      file: "generated/skill-catalog.md",
      hint: "Run: bun run scripts/generate-catalog.ts",
    });
    return;
  }

  const catalog = await readFile(catalogPath, "utf-8");

  // Extract skill slugs from the catalog Skill Index table only
  // The table starts after "## Skill Index" and ends before the next "##" heading
  const indexMatch = catalog.match(/## Skill Index\n[\s\S]*?\n\|[-|\s]+\|\n([\s\S]*?)(?:\n##|\n$)/);
  const indexSection = indexMatch ? indexMatch[1] : "";
  const catalogSlugs = new Set(
    [...indexSection.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]),
  );

  // Get current skills from the skills/ directory
  const skillsDir = join(ROOT, "skills");
  const built = buildSkillMap(skillsDir);
  const currentSlugs = new Set(Object.keys(built.skills));

  // Check for missing skills (in skills/ but not in catalog)
  const missing = [...currentSlugs].filter((s) => !catalogSlugs.has(s));
  // Check for stale skills (in catalog but not in skills/)
  const stale = [...catalogSlugs].filter((s) => !currentSlugs.has(s));

  if (missing.length > 0) {
    fail("CATALOG_STALE", `Skill catalog is missing ${missing.length} skill(s): ${missing.join(", ")}`, {
      file: "generated/skill-catalog.md",
      hint: "Run: bun run scripts/generate-catalog.ts to regenerate",
    });
  }

  if (stale.length > 0) {
    fail("CATALOG_STALE", `Skill catalog has ${stale.length} stale skill(s) no longer in skills/: ${stale.join(", ")}`, {
      file: "generated/skill-catalog.md",
      hint: "Run: bun run scripts/generate-catalog.ts to regenerate",
    });
  }

  if (missing.length === 0 && stale.length === 0) {
    pass(`Skill catalog lists all ${currentSlugs.size} skills (up to date)`);
  }
}

// ---------------------------------------------------------------------------
// 11. Validate profiler skill slugs map to real skills
// ---------------------------------------------------------------------------

async function validateProfilerSkillSlugs() {
  section("[11] Session-start profiler → skill slug cross-references");

  const profilerPath = join(ROOT, "hooks", "session-start-profiler.mjs");
  if (!(await exists(profilerPath))) {
    warn("PROFILER_MISSING", "hooks/session-start-profiler.mjs not found", {
      file: "hooks/session-start-profiler.mjs",
      hint: "Create the session-start profiler hook",
    });
    return;
  }

  const profilerSrc = await readFile(profilerPath, "utf-8");

  // Bootstrap hint slugs that are NOT actual skill slugs (used for setup signals only)
  const BOOTSTRAP_HINT_ONLY = new Set(["greenfield", "env-example", "readme", "drizzle-config", "postgres", "prisma-schema", "auth-secret"]);

  // Extract all skill slug strings referenced in FILE_MARKERS and PACKAGE_MARKERS
  // Match patterns like: skills: ["nextjs", "turbopack"] and ["ai-sdk"]
  const slugRefs = new Set<string>();
  for (const m of profilerSrc.matchAll(/skills?:\s*\["([^\]]+)"\]/g)) {
    // Handle the array content like: "nextjs", "turbopack"
    for (const s of m[1].matchAll(/"([a-z][a-z0-9-]*)"/g)) {
      slugRefs.add(s[1]);
    }
  }
  // Also match individual string entries in arrays
  for (const m of profilerSrc.matchAll(/\["([a-z][a-z0-9-]*)(?:",\s*"([a-z][a-z0-9-]*))*"\]/g)) {
    // Parse the full match more carefully
    const inner = m[0].slice(1, -1); // strip [ ]
    for (const s of inner.matchAll(/"([a-z][a-z0-9-]*)"/g)) {
      slugRefs.add(s[1]);
    }
  }
  // Also match: skills.add("cron-jobs") patterns
  for (const m of profilerSrc.matchAll(/skills\.add\("([a-z][a-z0-9-]*)"\)/g)) {
    slugRefs.add(m[1]);
  }

  if (slugRefs.size === 0) {
    warn("PROFILER_NO_SLUGS", "No skill slugs found in profiler source", {
      file: "hooks/session-start-profiler.mjs",
      hint: "Profiler should reference skill slugs in FILE_MARKERS or PACKAGE_MARKERS",
    });
    return;
  }

  const skillsDir = join(ROOT, "skills");
  const built = buildSkillMap(skillsDir);
  const validSlugs = new Set(Object.keys(built.skills));
  const invalid: string[] = [];

  // Remove bootstrap-only hints before validation
  for (const hint of BOOTSTRAP_HINT_ONLY) slugRefs.delete(hint);

  for (const slug of [...slugRefs].sort()) {
    if (validSlugs.has(slug)) {
      pass(`profiler slug "${slug}" → skills/${slug}/SKILL.md`);
    } else {
      invalid.push(slug);
      fail("PROFILER_SLUG_INVALID", `Profiler references skill "${slug}" but skills/${slug}/SKILL.md does not exist`, {
        file: "hooks/session-start-profiler.mjs",
        hint: `Create skills/${slug}/SKILL.md or remove "${slug}" from the profiler`,
      });
    }
  }

  if (invalid.length === 0) {
    pass(`All ${slugRefs.size} profiler skill slugs are valid`);
  }
}

// ---------------------------------------------------------------------------
// 12. Pattern fixture dry-run — assert expected skill matches
// ---------------------------------------------------------------------------

interface PatternFixture {
  description: string;
  type: "path" | "bash";
  input: string;
  expectedSkills: string[];
}

async function validatePatternFixtures() {
  section("[12] Pattern fixture dry-run");

  const fixturesPath = join(ROOT, "tests", "fixtures", "pattern-fixtures.json");
  if (!(await exists(fixturesPath))) {
    warn("FIXTURE_MISSING", "tests/fixtures/pattern-fixtures.json not found", {
      file: "tests/fixtures/pattern-fixtures.json",
      hint: "Create the pattern fixtures file with test cases for skill matching",
    });
    return;
  }

  let fixturesData: { fixtures: PatternFixture[] };
  try {
    fixturesData = JSON.parse(await readFile(fixturesPath, "utf-8"));
  } catch (err: any) {
    fail("FIXTURE_PARSE", `Failed to parse pattern-fixtures.json: ${err.message}`, {
      file: "tests/fixtures/pattern-fixtures.json",
    });
    return;
  }

  if (!Array.isArray(fixturesData.fixtures) || fixturesData.fixtures.length === 0) {
    fail("FIXTURE_EMPTY", "pattern-fixtures.json has no fixtures", {
      file: "tests/fixtures/pattern-fixtures.json",
      hint: "Add fixture entries with type, input, and expectedSkills",
    });
    return;
  }

  // Build skill map and compile patterns
  const skillsDir = join(ROOT, "skills");
  const built = buildSkillMap(skillsDir);
  const compiled = compileSkillPatterns(built.skills);

  let passed = 0;
  let failed = 0;

  for (const fixture of fixturesData.fixtures) {
    const matched: string[] = [];
    for (const entry of compiled) {
      if (fixture.type === "path") {
        const r = matchPathWithReason(fixture.input, entry.compiledPaths);
        if (r) matched.push(entry.skill);
      } else if (fixture.type === "bash") {
        const r = matchBashWithReason(fixture.input, entry.compiledBash);
        if (r) matched.push(entry.skill);
      }
    }

    const expected = new Set(fixture.expectedSkills);
    const actual = new Set(matched);
    const missing = [...expected].filter((s) => !actual.has(s));
    const extra = [...actual].filter((s) => !expected.has(s));

    if (missing.length > 0 || extra.length > 0) {
      failed++;
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
      if (extra.length > 0) parts.push(`extra: ${extra.join(", ")}`);
      fail("FIXTURE_MISMATCH", `Fixture "${fixture.description}" (${fixture.type}: ${fixture.input}) — ${parts.join("; ")}`, {
        file: "tests/fixtures/pattern-fixtures.json",
        hint: "Update the fixture's expectedSkills or fix the skill's patterns",
      });
    } else {
      passed++;
    }
  }

  if (failed === 0) {
    pass(`All ${passed} pattern fixtures match expected skills`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CHECK_LABELS: Record<string, string> = {
  graphSkillRefs: "Ecosystem graph → skill cross-references",
  orphanSkills: "Orphan skill detection",
  skillFrontmatter: "SKILL.md YAML frontmatter",
  pluginJson: "plugin.json validity",
  hooksJson: "hooks.json validity",
  coverageBaseline: "llms.txt coverage baseline",
  commandConventions: "Command conventions",
  cliBannedPatterns: "CLI banned-pattern scan",
  preToolUseHook: "PreToolUse hook and skill coverage",
  patternCompilation: "Pattern compilation",
  catalogStaleness: "Skill catalog staleness",
  profilerSkillSlugs: "Profiler skill slug cross-references",
  patternFixtures: "Pattern fixture dry-run",
};

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  currentCheck = name;
  const issuesBefore = issues.length;
  const start = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - start);
  metrics.push({ name, durationMs });

  const checkIssues = issues.slice(issuesBefore);
  const errorCount = checkIssues.filter((i) => i.severity === "error").length;
  const warningCount = checkIssues.filter((i) => i.severity === "warning").length;
  const status: CheckResult["status"] = errorCount > 0 ? "fail" : warningCount > 0 ? "warn" : "pass";
  checkResults.push({ name, label: CHECK_LABELS[name] ?? name, status, durationMs, errorCount, warningCount });

  return result;
}

const metrics: CheckMetric[] = [];
const checkResults: CheckResult[] = [];

async function main() {
  if (FORMAT === "pretty") {
    console.log("Vercel Plugin — Structural Validation\n" + "=".repeat(40));
  }

  await timed("graphSkillRefs", () => validateGraphSkillRefs());
  await timed("orphanSkills", () => validateOrphanSkills());
  await timed("skillFrontmatter", () => validateSkillFrontmatter());
  await timed("pluginJson", () => validatePluginJson());
  await timed("hooksJson", () => validateHooksJson());
  await timed("coverageBaseline", () => validateCoverageBaseline());
  await timed("commandConventions", () => validateCommandConventions());
  await timed("cliBannedPatterns", () => validateCliBannedPatterns());
  await timed("preToolUseHook", () => validatePreToolUseHook());
  await timed("patternCompilation", () => validatePatternCompilation());
  await timed("catalogStaleness", () => validateCatalogStaleness());
  await timed("profilerSkillSlugs", () => validateProfilerSkillSlugs());
  await timed("patternFixtures", () => validatePatternFixtures());

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;

  // Generate skill-manifest.json when validation passes (no errors)
  if (errorCount === 0) {
    const { manifest, errors: manifestErrors } = buildManifest(join(ROOT, "skills"));
    if (manifestErrors.length === 0) {
      const count = writeManifestFile(manifest);
      if (FORMAT === "pretty") {
        console.log(`\n✓ Generated skill-manifest.json (${count} skills)`);
      }
    }
  }

  if (FORMAT === "json") {
    const report: ValidationReport = {
      version: 1,
      timestamp: new Date().toISOString(),
      summary: { errors: errorCount, warnings: warnCount, checks },
      checkResults,
      metrics,
      issues,
      orphanSkills,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\n" + "=".repeat(40));
    if (errorCount > 0) {
      console.error(`\nFAILED — ${errorCount} error(s)${warnCount > 0 ? `, ${warnCount} warning(s)` : ""}\n`);
    } else if (warnCount > 0) {
      console.log(`\nPASSED with ${warnCount} warning(s)\n`);
    } else {
      console.log("\nPASSED — all checks OK\n");
    }
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

main();
