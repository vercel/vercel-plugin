#!/usr/bin/env bun
/**
 * Benchmark report generator: reads runner, verifier, and analyzer outputs
 * to produce results/report.md with per-project scorecards, aggregate stats,
 * coverage gaps, improvement recommendations, and a next-iteration prompt.
 *
 * Usage: bun run scripts/benchmark-report.ts [options]
 *   --base <path>  Override base directory (default: ~/dev/vercel-plugin-testing)
 *   --help         Print usage and exit
 */

import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import type { BenchmarkRunManifest } from "./benchmark-runner";

// ---------------------------------------------------------------------------
// Types (mirrors analyze/verify output schemas)
// ---------------------------------------------------------------------------

interface Scorecard {
  slug: string;
  sessionId: string | null;
  expectedSkills: string[];
  actualSkills: string[];
  matchedSkills: string[];
  missingSkills: string[];
  unexpectedSkills: string[];
  matchScore: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  toolCalls: Record<string, number>;
  totalToolCalls: number;
  errors: string[];
  traceInjections: TraceInjection[];
}

interface TraceInjection {
  toolName: string;
  matchedSkills: string[];
  injectedSkills: string[];
  droppedByCap: string[];
  droppedByBudget: string[];
}

// ---------------------------------------------------------------------------
// JSON report schema
// ---------------------------------------------------------------------------

export interface ReportGap {
  slug: string;
  expected: string[];
  actual: string[];
  missing: string[];
}

export interface SuggestedPattern {
  skill: string;
  glob: string;
  tool: string;
}

export interface ReportJson {
  runId: string | null;
  timestamp: string;
  verdict: "pass" | "partial" | "fail";
  gaps: ReportGap[];
  recommendations: string[];
  suggestedPatterns: SuggestedPattern[];
}

interface VerifyResult {
  slug: string;
  devServer: boolean;
  buildErrors: string[];
  port: number;
  packageManager: string;
  startCommand: string;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  timestamp: string;
}

interface RunnerSummaryEntry {
  slug: string;
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  pluginInstalled: boolean;
  expectedSkills: string[];
}

interface AnalysisSummary {
  timestamp: string;
  runId: string | null;
  projectCount: number;
  avgMatchScore: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  allMissingSkills: string[];
  allUnexpectedSkills: string[];
  scorecards: Array<{
    slug: string;
    matchScore: number;
    expected: string[];
    actual: string[];
    missing: string[];
    unexpected: string[];
  }>;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_BASE = join(homedir(), "dev", "vercel-plugin-testing");

const { values: flags } = parseArgs({
  options: {
    base: { type: "string", default: DEFAULT_BASE },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: bun run scripts/benchmark-report.ts [options]
  --base <path>  Override base directory (default: ~/dev/vercel-plugin-testing)
  --help         Print usage and exit`);
  process.exit(0);
}

const BASE_DIR = resolve(flags.base!);
const RESULTS_DIR = join(BASE_DIR, "results");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReadJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Well-known tool/glob associations per skill slug.
 * Used to generate suggested frontmatter pattern entries when a skill
 * was expected but never injected.
 */
export const SKILL_PATTERN_HINTS: Record<string, { glob: string; tool: string }[]> = {
  auth: [
    { glob: "middleware.{ts,js}", tool: "Read" },
    { glob: "app/sign-in/**", tool: "Read" },
    { glob: "app/(auth)/**", tool: "Read" },
  ],
  "vercel-storage": [
    { glob: "app/api/**", tool: "Read" },
    { glob: ".env*", tool: "Read" },
  ],
  nextjs: [
    { glob: "next.config.*", tool: "Read" },
    { glob: "app/**", tool: "Read" },
    { glob: "package.json", tool: "Read" },
  ],
  "ai-sdk": [
    { glob: "app/api/**", tool: "Read" },
    { glob: "lib/ai.*", tool: "Read" },
  ],
  "ai-gateway": [
    { glob: "app/api/**", tool: "Read" },
    { glob: "lib/ai/**", tool: "Read" },
  ],
  "chat-sdk": [
    { glob: "app/api/**", tool: "Read" },
    { glob: "bots/**", tool: "Read" },
  ],
  payments: [
    { glob: "app/api/webhook*/**", tool: "Read" },
    { glob: "app/api/checkout/**", tool: "Read" },
  ],
  email: [
    { glob: "emails/**", tool: "Read" },
    { glob: "app/api/send*/**", tool: "Read" },
  ],
  "cron-jobs": [
    { glob: "vercel.json", tool: "Read" },
    { glob: "app/api/cron/**", tool: "Read" },
  ],
  "routing-middleware": [
    { glob: "middleware.{ts,js}", tool: "Read" },
  ],
  cms: [
    { glob: "sanity.config.*", tool: "Read" },
    { glob: "content/**", tool: "Read" },
  ],
  observability: [
    { glob: "instrumentation.{ts,js}", tool: "Read" },
  ],
  "deployments-cicd": [
    { glob: ".github/workflows/**", tool: "Read" },
    { glob: "vercel.json", tool: "Read" },
  ],
  "vercel-api": [
    { glob: "app/api/**", tool: "Read" },
    { glob: "lib/vercel/**", tool: "Read" },
  ],
  "vercel-functions": [
    { glob: "app/api/**", tool: "Read" },
    { glob: "api/**", tool: "Read" },
  ],
  workflow: [
    { glob: "workflows/**", tool: "Read" },
    { glob: "app/api/**", tool: "Read" },
  ],
  "vercel-flags": [
    { glob: "flags/**", tool: "Read" },
    { glob: "app/**", tool: "Read" },
  ],
  "edge-runtime": [
    { glob: "middleware.{ts,js}", tool: "Read" },
    { glob: "app/api/**", tool: "Read" },
  ],
  "vercel-queues": [
    { glob: "app/api/queue/**", tool: "Read" },
    { glob: "queue/**", tool: "Read" },
  ],
  "vercel-sandbox": [
    { glob: "sandbox/**", tool: "Read" },
    { glob: "app/api/**", tool: "Read" },
  ],
  "runtime-cache": [
    { glob: "app/api/**", tool: "Read" },
    { glob: "lib/cache/**", tool: "Read" },
  ],
  "vercel-firewall": [
    { glob: "middleware.{ts,js}", tool: "Read" },
    { glob: "vercel.json", tool: "Read" },
  ],
  "env-vars": [
    { glob: ".env*", tool: "Read" },
    { glob: "vercel.json", tool: "Read" },
  ],
};

export function buildSuggestedPatterns(missingBySkill: Map<string, string[]>): SuggestedPattern[] {
  const patterns: SuggestedPattern[] = [];
  for (const [skill] of missingBySkill) {
    const hints = SKILL_PATTERN_HINTS[skill];
    if (hints) {
      for (const h of hints) {
        patterns.push({ skill, glob: h.glob, tool: h.tool });
      }
    } else {
      // Generic fallback — suggest a broad pattern so users can refine
      patterns.push({ skill, glob: "**/*", tool: "Read" });
    }
  }
  return patterns;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function verdict(scorecard: Scorecard, verify: VerifyResult | null, runEntry: RunnerSummaryEntry | null): string {
  if (runEntry && !runEntry.pluginInstalled) return "NO-PLUGIN";
  if (runEntry && runEntry.timedOut) return "TIMEOUT";
  if (runEntry && !runEntry.success) return "BUILD-FAIL";
  if (scorecard.matchScore === 1 && verify?.devServer) return "PASS";
  if (scorecard.matchScore >= 0.5 && verify?.devServer) return "PARTIAL";
  if (scorecard.matchScore >= 0.5 && !verify?.devServer) return "SKILL-OK";
  if (scorecard.matchScore < 0.5 && verify?.devServer) return "DEV-OK";
  return "FAIL";
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== Benchmark Report Generator ===`);
  console.log(`Results directory: ${RESULTS_DIR}\n`);

  if (!(await dirExists(RESULTS_DIR))) {
    console.error(`Results directory not found: ${RESULTS_DIR}`);
    console.error(`Run the benchmark pipeline first.`);
    process.exit(1);
  }

  // Load run manifest and aggregate summaries
  const manifest = await safeReadJson<BenchmarkRunManifest>(join(RESULTS_DIR, "run-manifest.json"));
  const analysisSummary = await safeReadJson<AnalysisSummary>(join(RESULTS_DIR, "analysis-summary.json"));
  const runId = manifest?.runId ?? analysisSummary?.runId ?? null;
  const runnerSummary = await safeReadJson<RunnerSummaryEntry[]>(join(RESULTS_DIR, "runner-summary.json"));
  const verifySummary = await safeReadJson<VerifyResult[]>(join(RESULTS_DIR, "verify-summary.json"));

  // Discover per-project result directories
  const resultEntries = await readdir(RESULTS_DIR);
  const slugDirs = (
    await Promise.all(
      resultEntries.map(async (e) => {
        const p = join(RESULTS_DIR, e);
        return (await dirExists(p)) ? e : null;
      }),
    )
  ).filter((e): e is string => e !== null);

  if (slugDirs.length === 0) {
    console.error("No project result directories found.");
    process.exit(1);
  }

  // Load per-project data
  const scorecards: Scorecard[] = [];
  const verifyMap = new Map<string, VerifyResult>();
  const runnerMap = new Map<string, RunnerSummaryEntry>();

  if (verifySummary) {
    for (const v of verifySummary) verifyMap.set(v.slug, v);
  }
  if (runnerSummary) {
    for (const r of runnerSummary) runnerMap.set(r.slug, r);
  }

  for (const slug of slugDirs.sort()) {
    const sc = await safeReadJson<Scorecard>(join(RESULTS_DIR, slug, "scorecard.json"));
    if (sc) scorecards.push(sc);

    // Also load verify.json per-project if not in summary
    if (!verifyMap.has(slug)) {
      const v = await safeReadJson<VerifyResult>(join(RESULTS_DIR, slug, "verify.json"));
      if (v) verifyMap.set(slug, v);
    }
  }

  if (scorecards.length === 0) {
    console.error("No scorecards found. Run benchmark-analyze.ts first.");
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Build report markdown
  // -------------------------------------------------------------------------

  const lines: string[] = [];
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  lines.push(`# Benchmark Report`);
  lines.push(``);
  if (runId) {
    lines.push(`Run ID: \`${runId}\``);
  }
  lines.push(`Generated: ${now}`);
  lines.push(`Projects: ${scorecards.length}`);
  lines.push(``);

  // --- Per-project scorecard table ---
  lines.push(`## Per-Project Scorecard`);
  lines.push(``);
  lines.push(`| Slug | Expected Skills | Actual Skills | Skill Match | Dev Server | Tokens (in/out) | Tool Calls | Verdict |`);
  lines.push(`|------|----------------|---------------|-------------|------------|-----------------|------------|---------|`);

  for (const sc of scorecards) {
    const v = verifyMap.get(sc.slug) ?? null;
    const r = runnerMap.get(sc.slug) ?? null;
    const devServerCell = v ? (v.devServer ? "PASS" : "FAIL") : "N/A";
    const tokensCell = `${fmtTokens(sc.tokens.input)}/${fmtTokens(sc.tokens.output)}`;
    const verd = verdict(sc, v, r);

    lines.push(
      `| ${sc.slug} | ${sc.expectedSkills.join(", ")} | ${sc.actualSkills.join(", ")} | ${pct(sc.matchScore)} | ${devServerCell} | ${tokensCell} | ${sc.totalToolCalls} | ${verd} |`,
    );
  }
  lines.push(``);

  // --- Aggregate stats ---
  const totalTokensIn = scorecards.reduce((s, c) => s + c.tokens.input, 0);
  const totalTokensOut = scorecards.reduce((s, c) => s + c.tokens.output, 0);
  const totalToolCalls = scorecards.reduce((s, c) => s + c.totalToolCalls, 0);
  const avgMatchScore = scorecards.reduce((s, c) => s + c.matchScore, 0) / scorecards.length;
  const passCount = scorecards.filter((sc) => {
    const v = verifyMap.get(sc.slug);
    return sc.matchScore === 1 && v?.devServer;
  }).length;
  const devServerPassCount = [...verifyMap.values()].filter((v) => v.devServer).length;
  const skillFullMatchCount = scorecards.filter((sc) => sc.matchScore === 1).length;

  lines.push(`## Aggregate Stats`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Overall pass rate (skill match + dev server) | ${passCount}/${scorecards.length} (${pct(passCount / scorecards.length)}) |`);
  lines.push(`| Skill injection full match | ${skillFullMatchCount}/${scorecards.length} (${pct(skillFullMatchCount / scorecards.length)}) |`);
  lines.push(`| Dev server pass rate | ${devServerPassCount}/${scorecards.length} (${pct(devServerPassCount / scorecards.length)}) |`);
  lines.push(`| Average skill match score | ${pct(avgMatchScore)} |`);
  lines.push(`| Total tokens (in / out) | ${fmtTokens(totalTokensIn)} / ${fmtTokens(totalTokensOut)} |`);
  lines.push(`| Average tokens per project | ${fmtTokens(totalTokensIn / scorecards.length)} / ${fmtTokens(totalTokensOut / scorecards.length)} |`);
  lines.push(`| Total tool calls | ${totalToolCalls} |`);
  lines.push(`| Average tool calls per project | ${(totalToolCalls / scorecards.length).toFixed(0)} |`);
  lines.push(``);

  // --- Pattern coverage gaps ---
  const missingBySkill = new Map<string, string[]>();
  for (const sc of scorecards) {
    for (const skill of sc.missingSkills) {
      if (!missingBySkill.has(skill)) missingBySkill.set(skill, []);
      missingBySkill.get(skill)!.push(sc.slug);
    }
  }

  const unexpectedBySkill = new Map<string, string[]>();
  for (const sc of scorecards) {
    for (const skill of sc.unexpectedSkills) {
      if (!unexpectedBySkill.has(skill)) unexpectedBySkill.set(skill, []);
      unexpectedBySkill.get(skill)!.push(sc.slug);
    }
  }

  lines.push(`## Pattern Coverage Gaps`);
  lines.push(``);

  if (missingBySkill.size === 0 && unexpectedBySkill.size === 0) {
    lines.push(`No coverage gaps detected — all expected skills were injected.`);
  } else {
    if (missingBySkill.size > 0) {
      lines.push(`### Skills expected but NOT injected`);
      lines.push(``);
      lines.push(`| Skill | Missed in projects | Frequency |`);
      lines.push(`|-------|-------------------|-----------|`);
      for (const [skill, slugs] of [...missingBySkill.entries()].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`| ${skill} | ${slugs.join(", ")} | ${slugs.length}/${scorecards.length} |`);
      }
      lines.push(``);
    }

    if (unexpectedBySkill.size > 0) {
      lines.push(`### Skills injected but NOT expected`);
      lines.push(``);
      lines.push(`| Skill | Injected in projects | Frequency |`);
      lines.push(`|-------|---------------------|-----------|`);
      for (const [skill, slugs] of [...unexpectedBySkill.entries()].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`| ${skill} | ${slugs.join(", ")} | ${slugs.length}/${scorecards.length} |`);
      }
      lines.push(``);
    }
  }

  // --- Build errors summary ---
  const projectsWithBuildErrors = [...verifyMap.values()].filter((v) => v.buildErrors.length > 0);
  if (projectsWithBuildErrors.length > 0) {
    lines.push(`## Build Errors`);
    lines.push(``);
    for (const v of projectsWithBuildErrors) {
      lines.push(`### ${v.slug}`);
      lines.push(``);
      lines.push("```");
      for (const err of v.buildErrors.slice(0, 5)) {
        lines.push(err);
      }
      if (v.buildErrors.length > 5) {
        lines.push(`... and ${v.buildErrors.length - 5} more`);
      }
      lines.push("```");
      lines.push(``);
    }
  }

  // --- Improvement recommendations ---
  lines.push(`## Improvement Recommendations`);
  lines.push(``);

  const recommendations: string[] = [];

  // Missing skill patterns
  for (const [skill, slugs] of [...missingBySkill.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const freq = slugs.length;
    if (freq >= 2) {
      recommendations.push(
        `[ ] **${skill}** skill failed to inject in ${freq} projects (${slugs.join(", ")}). Review trigger patterns in the skill's frontmatter — prompts may use different terminology than the current glob/regex matchers expect.`,
      );
    } else {
      recommendations.push(
        `[ ] **${skill}** skill missed in ${slugs[0]}. Check if the prompt's wording triggers the expected tool calls that activate this skill.`,
      );
    }
  }

  // Unexpected skill injections (may indicate over-broad patterns)
  for (const [skill, slugs] of [...unexpectedBySkill.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (slugs.length >= 3) {
      recommendations.push(
        `[ ] **${skill}** skill injected unexpectedly in ${slugs.length} projects. Consider tightening its trigger patterns to reduce false positives.`,
      );
    }
  }

  // Dev server failures
  const devServerFailures = [...verifyMap.values()].filter((v) => !v.devServer);
  if (devServerFailures.length > 0) {
    recommendations.push(
      `[ ] ${devServerFailures.length} project(s) failed dev server verification (${devServerFailures.map((v) => v.slug).join(", ")}). Review SKILL.md guidance for project scaffolding — generated code may have missing dependencies or incorrect configurations.`,
    );
  }

  // Token efficiency
  const highTokenProjects = scorecards.filter((sc) => sc.tokens.input > 500_000);
  if (highTokenProjects.length > 0) {
    recommendations.push(
      `[ ] ${highTokenProjects.length} project(s) exceeded 500K input tokens (${highTokenProjects.map((s) => s.slug).join(", ")}). Investigate whether skill content is too large or if dedup is not working correctly.`,
    );
  }

  // Error-prone projects
  const errorProjects = scorecards.filter((sc) => sc.errors.length > 3);
  if (errorProjects.length > 0) {
    recommendations.push(
      `[ ] ${errorProjects.length} project(s) had >3 tool errors (${errorProjects.map((s) => s.slug).join(", ")}). Review error patterns to see if skill guidance is causing tool misuse.`,
    );
  }

  // Dropped skills
  const droppedByCap = new Set<string>();
  const droppedByBudget = new Set<string>();
  for (const sc of scorecards) {
    for (const inj of sc.traceInjections) {
      for (const s of inj.droppedByCap) droppedByCap.add(s);
      for (const s of inj.droppedByBudget) droppedByBudget.add(s);
    }
  }
  if (droppedByCap.size > 0) {
    recommendations.push(
      `[ ] Skills dropped by injection cap: ${[...droppedByCap].join(", ")}. Consider raising the cap or prioritizing these skills.`,
    );
  }
  if (droppedByBudget.size > 0) {
    recommendations.push(
      `[ ] Skills dropped by token budget: ${[...droppedByBudget].join(", ")}. Consider compressing skill content or raising the budget.`,
    );
  }

  if (recommendations.length === 0) {
    lines.push(`No issues detected — all skills matched and dev servers passed.`);
  } else {
    for (const rec of recommendations) {
      lines.push(`- ${rec}`);
    }
  }
  lines.push(``);

  // --- Next iteration prompt ---
  lines.push(`## Next Iteration`);
  lines.push(``);
  lines.push(`Copy the prompt below into a Claude Code session to begin the next improvement cycle:`);
  lines.push(``);
  lines.push("```");

  const nextPromptParts: string[] = [];
  nextPromptParts.push(`Based on benchmark iteration results (${now}):`);
  nextPromptParts.push(``);
  nextPromptParts.push(`Overall: ${passCount}/${scorecards.length} full pass, ${pct(avgMatchScore)} avg skill match, ${devServerPassCount}/${scorecards.length} dev server pass.`);
  nextPromptParts.push(``);

  if (missingBySkill.size > 0) {
    nextPromptParts.push(`Missing skill injections:`);
    for (const [skill, slugs] of [...missingBySkill.entries()].sort((a, b) => b[1].length - a[1].length)) {
      nextPromptParts.push(`- ${skill}: missed in ${slugs.join(", ")}`);
    }
    nextPromptParts.push(``);
  }

  if (devServerFailures.length > 0) {
    nextPromptParts.push(`Dev server failures: ${devServerFailures.map((v) => v.slug).join(", ")}`);
    nextPromptParts.push(``);
  }

  if (droppedByCap.size > 0 || droppedByBudget.size > 0) {
    nextPromptParts.push(`Dropped skills — cap: [${[...droppedByCap].join(", ")}], budget: [${[...droppedByBudget].join(", ")}]`);
    nextPromptParts.push(``);
  }

  nextPromptParts.push(`Priority fixes:`);
  // Top 3 most impactful recommendations
  const topRecs = recommendations.slice(0, 3);
  for (let i = 0; i < topRecs.length; i++) {
    nextPromptParts.push(`${i + 1}. ${topRecs[i].replace(/^\[ \] /, "")}`);
  }
  nextPromptParts.push(``);
  nextPromptParts.push(`Implement these fixes in the vercel-plugin repo, then re-run the benchmark suite with: bun run scripts/benchmark-runner.ts && bun run scripts/benchmark-verify.ts && bun run scripts/benchmark-analyze.ts && bun run scripts/benchmark-report.ts`);

  lines.push(nextPromptParts.join("\n"));
  lines.push("```");
  lines.push(``);

  // --- Suggested pattern additions (YAML) ---
  const suggestedPatterns = buildSuggestedPatterns(missingBySkill);

  if (suggestedPatterns.length > 0) {
    lines.push(`## Suggested Pattern Additions`);
    lines.push(``);
    lines.push(`Copy-pasteable YAML frontmatter entries for skills that were expected but not injected:`);
    lines.push(``);

    // Group by skill
    const bySkill = new Map<string, SuggestedPattern[]>();
    for (const p of suggestedPatterns) {
      if (!bySkill.has(p.skill)) bySkill.set(p.skill, []);
      bySkill.get(p.skill)!.push(p);
    }

    for (const [skill, patterns] of bySkill) {
      lines.push(`### ${skill}`);
      lines.push(``);
      lines.push("```yaml");
      lines.push(`metadata:`);
      lines.push(`  pathPatterns:`);
      for (const p of patterns) {
        lines.push(`    - '${p.glob}'`);
      }
      lines.push("```");
      lines.push(``);
    }
  }

  // -------------------------------------------------------------------------
  // Build JSON report
  // -------------------------------------------------------------------------

  const gaps: ReportGap[] = scorecards
    .filter((sc) => sc.missingSkills.length > 0)
    .map((sc) => ({
      slug: sc.slug,
      expected: sc.expectedSkills,
      actual: sc.actualSkills,
      missing: sc.missingSkills,
    }));

  const overallVerdict: "pass" | "partial" | "fail" =
    avgMatchScore === 1 && passCount === scorecards.length
      ? "pass"
      : avgMatchScore >= 0.5
        ? "partial"
        : "fail";

  const reportJson: ReportJson = {
    runId: runId,
    timestamp: new Date().toISOString(),
    verdict: overallVerdict,
    gaps,
    recommendations,
    suggestedPatterns,
  };

  // -------------------------------------------------------------------------
  // Write reports
  // -------------------------------------------------------------------------

  const reportPath = join(RESULTS_DIR, "report.md");
  const reportJsonPath = join(RESULTS_DIR, "report.json");
  const reportContent = lines.join("\n");

  await Promise.all([
    writeFile(reportPath, reportContent),
    writeFile(reportJsonPath, JSON.stringify(reportJson, null, 2)),
  ]);

  console.log(`Report written to: ${reportPath}`);
  console.log(`JSON report written to: ${reportJsonPath}`);
  console.log(`\n--- Report Preview ---\n`);
  // Print first 40 lines as preview
  const previewLines = reportContent.split("\n").slice(0, 40);
  console.log(previewLines.join("\n"));
  if (reportContent.split("\n").length > 40) {
    console.log(`\n... (${reportContent.split("\n").length - 40} more lines)`);
  }
  console.log();
}

// Only run main when executed directly (not when imported by tests)
const isDirectRun =
  typeof Bun !== "undefined"
    ? Bun.main === import.meta.path
    : process.argv[1] === import.meta.filename;

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(2);
  });
}
