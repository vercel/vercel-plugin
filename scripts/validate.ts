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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Issue {
  code: string;
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  hint?: string;
}

interface CheckMetric {
  name: string;
  durationMs: number;
}

interface ValidationReport {
  version: 1;
  timestamp: string;
  summary: { errors: number; warnings: number; checks: number };
  metrics: CheckMetric[];
  issues: Issue[];
  orphanSkills: string[];
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

function fail(code: string, message: string, extra?: { file?: string; line?: number; hint?: string }) {
  issues.push({ code, severity: "error", message, ...extra });
  if (FORMAT === "pretty") console.error(`  ✗ ${message}`);
}

function warn(code: string, message: string, extra?: { file?: string; line?: number; hint?: string }) {
  issues.push({ code, severity: "warning", message, ...extra });
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

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const pairs: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      pairs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return pairs;
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

  const graphPath = join(ROOT, "assets", "vercel-ecosystem-graph.md");
  if (!(await exists(graphPath))) {
    fail("GRAPH_MISSING", "assets/vercel-ecosystem-graph.md not found", {
      file: "assets/vercel-ecosystem-graph.md",
      hint: "Create assets/vercel-ecosystem-graph.md with ⤳ skill: references",
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
      file: "assets/vercel-ecosystem-graph.md",
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
        file: "assets/vercel-ecosystem-graph.md",
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

  const graphPath = join(ROOT, "assets", "vercel-ecosystem-graph.md");
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
        hint: `Add "⤳ skill: ${dir}" to the appropriate section in assets/vercel-ecosystem-graph.md`,
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

async function validateSkillFrontmatter(): Promise<string[]> {
  section("[2] SKILL.md YAML frontmatter");

  const skillsDir = join(ROOT, "skills");
  const dirs = await readdir(skillsDir);
  const skillNames: string[] = [];

  for (const dir of dirs.sort()) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!(await exists(skillPath))) continue;

    skillNames.push(dir);
    const content = await readFile(skillPath, "utf-8");
    const fm = parseFrontmatter(content);

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
    if (fm.name && fm.description) {
      pass(`skills/${dir}/SKILL.md — name: "${fm.name}", description present`);
    }
  }

  return skillNames;
}

// ---------------------------------------------------------------------------
// 3. Validate plugin.json enumerates all capabilities
// ---------------------------------------------------------------------------

async function validatePluginJson(skillNames: string[]) {
  section("[3] plugin.json completeness");

  const manifestPath = join(ROOT, ".plugin", "plugin.json");
  if (!(await exists(manifestPath))) {
    fail("MANIFEST_MISSING", ".plugin/plugin.json not found", {
      file: ".plugin/plugin.json",
      hint: "Create .plugin/plugin.json with skills, agents, commands, and rules arrays",
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

  // Skills
  const declaredSkills: string[] = manifest.skills ?? [];
  for (const name of skillNames) {
    if (declaredSkills.includes(name)) {
      pass(`plugin.json lists skill "${name}"`);
    } else {
      fail("MANIFEST_SKILL_MISSING", `plugin.json missing skill "${name}"`, {
        file: ".plugin/plugin.json",
        hint: `Add "${name}" to the skills array`,
      });
    }
  }
  for (const name of declaredSkills) {
    if (!skillNames.includes(name)) {
      fail("MANIFEST_SKILL_ORPHAN", `plugin.json lists skill "${name}" but skills/${name}/SKILL.md not found`, {
        file: ".plugin/plugin.json",
        hint: `Remove "${name}" from the skills array or create skills/${name}/SKILL.md`,
      });
    }
  }

  // Agents
  const agentsDir = join(ROOT, "agents");
  if (await exists(agentsDir)) {
    const agentFiles = (await readdir(agentsDir)).filter((f) => f.endsWith(".md")).sort();
    const declaredAgents: string[] = manifest.agents ?? [];
    for (const f of agentFiles) {
      if (declaredAgents.includes(f)) {
        pass(`plugin.json lists agent "${f}"`);
      } else {
        fail("MANIFEST_AGENT_MISSING", `plugin.json missing agent "${f}"`, {
          file: ".plugin/plugin.json",
          hint: `Add "${f}" to the agents array in .plugin/plugin.json`,
        });
      }
    }
  }

  // Commands
  const commandsDir = join(ROOT, "commands");
  if (await exists(commandsDir)) {
    const cmdFiles = (await readdir(commandsDir)).filter((f) => f.endsWith(".md")).sort();
    const declaredCmds: string[] = manifest.commands ?? [];
    for (const f of cmdFiles) {
      if (declaredCmds.includes(f)) {
        pass(`plugin.json lists command "${f}"`);
      } else {
        fail("MANIFEST_CMD_MISSING", `plugin.json missing command "${f}"`, {
          file: ".plugin/plugin.json",
          hint: `Add "${f}" to the commands array in .plugin/plugin.json`,
        });
      }
    }
  }

  // Rules
  const rulesDir = join(ROOT, "rules");
  if (await exists(rulesDir)) {
    const ruleFiles = (await readdir(rulesDir)).filter((f) => f.endsWith(".mdc")).sort();
    const declaredRules: string[] = manifest.rules ?? [];
    for (const f of ruleFiles) {
      if (declaredRules.includes(f)) {
        pass(`plugin.json lists rule "${f}"`);
      } else {
        fail("MANIFEST_RULE_MISSING", `plugin.json missing rule "${f}"`, {
          file: ".plugin/plugin.json",
          hint: `Add "${f}" to the rules array in .plugin/plugin.json`,
        });
      }
    }
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
// Main
// ---------------------------------------------------------------------------

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  metrics.push({ name, durationMs: Math.round(performance.now() - start) });
  return result;
}

const metrics: CheckMetric[] = [];

async function main() {
  if (FORMAT === "pretty") {
    console.log("Vercel Plugin — Structural Validation\n" + "=".repeat(40));
  }

  await timed("graphSkillRefs", () => validateGraphSkillRefs());
  await timed("orphanSkills", () => validateOrphanSkills());
  const skillNames = await timed("skillFrontmatter", () => validateSkillFrontmatter());
  await timed("pluginJson", () => validatePluginJson(skillNames));
  await timed("hooksJson", () => validateHooksJson());
  await timed("coverageBaseline", () => validateCoverageBaseline());

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;

  if (FORMAT === "json") {
    const report: ValidationReport = {
      version: 1,
      timestamp: new Date().toISOString(),
      summary: { errors: errorCount, warnings: warnCount, checks },
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
