#!/usr/bin/env bun
/**
 * Dry-run CLI for prompt-signal analysis.
 *
 * Usage:
 *   bun run scripts/prompt-signals-explain.ts --prompt 'add markdown formatting to streamed text'
 *   echo 'stream markdown in terminal' | bun run scripts/prompt-signals-explain.ts
 *   bun run scripts/prompt-signals-explain.ts --prompt '...' --json --seen-skills nextjs,ai-sdk
 */

import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { analyzePrompt } from "../hooks/src/prompt-analysis.mjs";
import type { PromptAnalysisReport, PerSkillResult } from "../hooks/src/prompt-analysis.mjs";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

let prompt = "";
let jsonOutput = false;
let seenSkills = "";
let budgetBytes = 8000;
let maxSkills = 2;
let wantHelp = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    wantHelp = true;
  } else if (arg === "--json") {
    jsonOutput = true;
  } else if (arg === "--prompt" || arg === "-p") {
    i++;
    prompt = args[i] ?? "";
  } else if (arg === "--seen-skills") {
    i++;
    seenSkills = args[i] ?? "";
  } else if (arg === "--budget-bytes") {
    i++;
    budgetBytes = parseInt(args[i], 10);
  } else if (arg === "--max-skills") {
    i++;
    maxSkills = parseInt(args[i], 10);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

if (wantHelp) {
  console.log(`Usage: bun run scripts/prompt-signals-explain.ts [options]

Options:
  --prompt, -p <text>      Prompt to analyze (or pipe via stdin)
  --json                   Output PromptAnalysisReport as JSON
  --seen-skills <s1,s2>    Comma-separated skills to exclude (dedup)
  --budget-bytes <n>       Budget in bytes (default: 8000)
  --max-skills <n>         Max skills to select (default: 2)
  --help, -h               Show this help

Examples:
  bun run scripts/prompt-signals-explain.ts --prompt 'add markdown formatting to streamed text'
  bun run scripts/prompt-signals-explain.ts --prompt '...' --json
  echo 'stream markdown in terminal' | bun run scripts/prompt-signals-explain.ts`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Stdin fallback
// ---------------------------------------------------------------------------

if (!prompt) {
  const isTTY = process.stdin.isTTY;
  if (!isTTY) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  }
}

if (!prompt) {
  console.error("Error: no prompt provided. Use --prompt <text> or pipe via stdin.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate numeric args
// ---------------------------------------------------------------------------

if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
  console.error("Error: --budget-bytes must be a positive number.");
  process.exit(1);
}
if (!Number.isFinite(maxSkills) || maxSkills <= 0) {
  console.error("Error: --max-skills must be a positive integer.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load skill map
// ---------------------------------------------------------------------------

const projectRoot = resolve(import.meta.dir, "..");
const manifestPath = join(projectRoot, "generated", "skill-rules.json");
let skills: Record<string, any>;
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  skills = manifest.skills ?? {};
} catch {
  console.error(`Error: cannot read generated/skill-rules.json at ${manifestPath}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

const report: PromptAnalysisReport = analyzePrompt(
  prompt,
  skills,
  seenSkills,
  budgetBytes,
  maxSkills,
);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// Human-readable table
console.log(`Prompt: "${report.normalizedPrompt}"`);
console.log(`Budget: ${report.budgetBytes} bytes | Max skills: ${maxSkills}`);
console.log(`Dedup: strategy=${report.dedupState.strategy}, seen=[${report.dedupState.seenSkills.join(",")}]`);
console.log();

const entries = Object.entries(report.perSkillResults);
if (entries.length === 0) {
  console.log("No skills with promptSignals found.");
  process.exit(0);
}

// Table header
const skillColWidth = Math.max(10, ...entries.map(([s]) => s.length)) + 2;
const header = [
  "Skill".padEnd(skillColWidth),
  "Score".padStart(7),
  " Match",
  " Suppr",
  "  Reason",
].join("");
console.log(header);
console.log("-".repeat(header.length + 20));

for (const [skill, r] of entries) {
  const scoreStr = r.score === -Infinity ? "  -Inf" : String(r.score).padStart(7);
  const matchStr = r.matched ? "   yes" : "    no";
  const supprStr = r.suppressed ? "   yes" : "    no";
  console.log(
    `${skill.padEnd(skillColWidth)}${scoreStr}${matchStr}${supprStr}  ${r.reason}`,
  );
}

console.log();

if (report.selectedSkills.length > 0) {
  console.log(`Selected: ${report.selectedSkills.join(", ")}`);
}
if (report.droppedByCap.length > 0) {
  console.log(`Dropped (cap): ${report.droppedByCap.join(", ")}`);
}
if (report.droppedByBudget.length > 0) {
  console.log(`Dropped (budget): ${report.droppedByBudget.join(", ")}`);
}
if (report.dedupState.filteredByDedup.length > 0) {
  console.log(`Filtered (dedup): ${report.dedupState.filteredByDedup.join(", ")}`);
}

console.log(`\nTiming: ${report.timingMs}ms`);
process.exit(0);
