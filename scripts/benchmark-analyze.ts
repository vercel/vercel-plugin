#!/usr/bin/env bun
/**
 * Benchmark analyzer: walks ~/.claude/projects/ JSONL files, matches sessions
 * to benchmark test directories, extracts token usage, tool calls, and skill
 * injection data, then compares against expected skills to produce scorecards.
 *
 * Usage: bun run scripts/benchmark-analyze.ts [options]
 *   --base <path>  Override base directory (default: ~/dev/vercel-plugin-testing)
 *   --help         Print usage and exit
 */

import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import type { BenchmarkRunManifest } from "./benchmark-runner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Scorecard {
  slug: string;
  sessionId: string | null;
  expectedSkills: string[];
  actualSkills: string[];
  matchedSkills: string[];
  missingSkills: string[];
  unexpectedSkills: string[];
  matchScore: number; // 0–1
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

interface RunMeta {
  slug: string;
  expectedSkills: string[];
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  timestamp?: string;
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
  console.log(`Usage: bun run scripts/benchmark-analyze.ts [options]
  --base <path>  Override base directory (default: ~/dev/vercel-plugin-testing)
  --help         Print usage and exit`);
  process.exit(0);
}

const BASE_DIR = resolve(flags.base!);
const RESULTS_DIR = join(BASE_DIR, "results");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const BENCHMARK_AGENT_SLUGS = [
  "01-doc-qa-agent",
  "02-customer-support-agent",
  "03-deploy-monitor",
  "04-multi-model-router",
  "05-slack-pr-reviewer",
  "06-content-pipeline",
  "07-feature-rollout",
  "08-event-driven-crm",
  "09-code-sandbox-tutor",
  "10-multi-agent-research",
  "11-discord-game-master",
  "12-compliance-auditor",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to the Claude projects directory name format.
 * Claude Code replaces "/" with "-" and keeps the leading "-".
 * e.g. "/Users/john/dev/app" → "-Users-john-dev-app"
 */
export function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

async function safeReadJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function safeReadText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
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

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JSONL Session Analysis
// ---------------------------------------------------------------------------

export interface SessionStats {
  sessionId: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  toolCalls: Record<string, number>;
  totalToolCalls: number;
  errors: string[];
}

export async function analyzeSessionJsonl(jsonlPath: string): Promise<SessionStats> {
  const text = await readFile(jsonlPath, "utf-8");
  const lines = text.split("\n").filter((l) => l.trim());

  let sessionId = "";
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const toolCalls: Record<string, number> = {};
  let totalToolCalls = 0;
  const errors: string[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract session ID from first entry that has one
    if (!sessionId && typeof entry.sessionId === "string") {
      sessionId = entry.sessionId;
    }

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    // Accumulate token usage from assistant messages
    const usage = msg.usage as Record<string, number> | undefined;
    if (usage) {
      tokens.input += usage.input_tokens || 0;
      tokens.output += usage.output_tokens || 0;
      tokens.cacheRead += usage.cache_read_input_tokens || 0;
      tokens.cacheCreation += usage.cache_creation_input_tokens || 0;
    }

    // Extract tool calls from content blocks
    const content = msg.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          toolCalls[block.name] = (toolCalls[block.name] || 0) + 1;
          totalToolCalls++;
        }
        // Capture errors from tool results
        if (block.type === "tool_result" && block.is_error === true) {
          const errContent = block.content;
          if (typeof errContent === "string" && errContent.length < 500) {
            errors.push(errContent.slice(0, 200));
          } else if (Array.isArray(errContent)) {
            for (const c of errContent) {
              if (typeof c === "object" && c && (c as Record<string, unknown>).type === "text") {
                const t = (c as Record<string, string>).text || "";
                if (t.length < 500) errors.push(t.slice(0, 200));
              }
            }
          }
        }
      }
    }
  }

  return { sessionId, tokens, toolCalls, totalToolCalls, errors: errors.slice(0, 20) };
}

/**
 * Find JSONL files in ~/.claude/projects/ that match a given cwd.
 * Returns paths sorted by modification time (newest first).
 */
export async function findSessionJsonls(cwd: string): Promise<string[]> {
  const dirName = cwdToProjectDirName(cwd);
  const projectDir = join(CLAUDE_PROJECTS_DIR, dirName);

  if (!(await dirExists(projectDir))) return [];

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }
  const jsonls = entries.filter((e) => e.endsWith(".jsonl"));
  if (jsonls.length === 0) return [];

  // Sort by mtime descending (newest first)
  const withMtime = (
    await Promise.all(
      jsonls.map(async (f) => {
        const fp = join(projectDir, f);
        try {
          const s = await stat(fp);
          return { path: fp, mtime: s.mtimeMs };
        } catch {
          return null;
        }
      }),
    )
  ).filter((w): w is { path: string; mtime: number } => w !== null);
  withMtime.sort((a, b) => b.mtime - a.mtime);

  return withMtime.map((w) => w.path);
}

// ---------------------------------------------------------------------------
// Trace Log Parsing
// ---------------------------------------------------------------------------

export function parseTraceLog(traceText: string): TraceInjection[] {
  const injections: TraceInjection[] = [];
  const lines = traceText.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Look for "complete" events that have injection counts,
    // or direct skill-injection audit log entries
    if (entry.event === "skill-injection") {
      injections.push({
        toolName: (entry.toolName as string) || "",
        matchedSkills: (entry.matchedSkills as string[]) || [],
        injectedSkills: (entry.injectedSkills as string[]) || [],
        droppedByCap: (entry.droppedByCap as string[]) || [],
        droppedByBudget: (entry.droppedByBudget as string[]) || [],
      });
    }
  }

  return injections;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function hookNameToToolName(hookName: string): string {
  const parts = hookName.split(":");
  return parts.length > 1 ? parts[parts.length - 1] : hookName;
}

function makeTraceInjectionFromRecord(
  record: Record<string, unknown>,
  fallbackToolName: string,
): TraceInjection | null {
  const matchedSkills = asStringArray(record.matchedSkills);
  const injectedSkills = asStringArray(record.injectedSkills);
  const droppedByCap = asStringArray(record.droppedByCap);
  const droppedByBudget = asStringArray(record.droppedByBudget);

  if (
    matchedSkills.length === 0
    && injectedSkills.length === 0
    && droppedByCap.length === 0
    && droppedByBudget.length === 0
  ) {
    return null;
  }

  const toolName =
    typeof record.toolName === "string" && record.toolName.length > 0
      ? record.toolName
      : fallbackToolName;

  return {
    toolName,
    matchedSkills,
    injectedSkills,
    droppedByCap,
    droppedByBudget,
  };
}

function extractTraceInjectionsFromUnknown(
  value: unknown,
  fallbackToolName: string,
): TraceInjection[] {
  const injections: TraceInjection[] = [];
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (!trimmed) continue;
      try {
        queue.push(JSON.parse(trimmed));
      } catch {
        // ignore non-JSON strings
      }
      continue;
    }
    if (!current || typeof current !== "object") continue;

    const record = current as Record<string, unknown>;
    const maybeInjection = makeTraceInjectionFromRecord(record, fallbackToolName);
    if (maybeInjection) injections.push(maybeInjection);

    for (const key of ["skillInjection", "metadata", "result", "output", "payload", "data"]) {
      if (key in record) queue.push(record[key]);
    }
  }

  return injections;
}

async function parseHookProgressInjectionsFromSessionJsonl(jsonlPath: string): Promise<TraceInjection[]> {
  const text = await safeReadText(jsonlPath);
  if (!text) return [];

  const lines = text.split("\n").filter((l) => l.trim());
  const dedup = new Map<string, TraceInjection>();

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "progress") continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (!data || data.type !== "hook_progress") continue;

    const command = typeof data.command === "string" ? data.command : "";
    if (!command.includes("pretooluse-skill-inject")) continue;

    const hookName = typeof data.hookName === "string" ? data.hookName : "";
    const fallbackToolName = hookName ? hookNameToToolName(hookName) : "";

    const extracted = extractTraceInjectionsFromUnknown(data, fallbackToolName);
    const candidates =
      extracted.length > 0
        ? extracted
        : [
            {
              toolName: fallbackToolName,
              matchedSkills: [],
              injectedSkills: [],
              droppedByCap: [],
              droppedByBudget: [],
            } satisfies TraceInjection,
          ];

    for (const injection of candidates) {
      const key = JSON.stringify(injection);
      if (!dedup.has(key)) dedup.set(key, injection);
    }
  }

  return [...dedup.values()];
}

interface AuditLogParseResult {
  found: boolean;
  injections: TraceInjection[];
}

/**
 * Also parse the .vercel-plugin/skill-injections.jsonl audit log
 * in the project directory for skill injection data.
 */
async function parseAuditLog(projectDir: string): Promise<AuditLogParseResult> {
  const auditPath = join(projectDir, ".vercel-plugin", "skill-injections.jsonl");
  const found = await fileExists(auditPath);
  if (!found) return { found: false, injections: [] };

  const text = await safeReadText(auditPath);
  if (!text) return { found: true, injections: [] };
  return { found: true, injections: parseTraceLog(text) };
}

async function discoverBenchmarkAgentSlugEntries(baseDir: string): Promise<Array<{ slug: string; cwd: string }>> {
  const discovered: Array<{ slug: string; cwd: string }> = [];

  for (const slug of BENCHMARK_AGENT_SLUGS) {
    const cwd = join(baseDir, slug);
    const jsonls = await findSessionJsonls(cwd);
    if (jsonls.length > 0) discovered.push({ slug, cwd });
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeScorecard(
  slug: string,
  expectedSkills: string[],
  sessionStats: SessionStats | null,
  traceInjections: TraceInjection[],
): Scorecard {
  // Collect all unique injected skills from trace
  const actualSkillSet = new Set<string>();
  for (const inj of traceInjections) {
    for (const s of inj.injectedSkills) actualSkillSet.add(s);
  }
  const actualSkills = [...actualSkillSet].sort();

  const expectedSet = new Set(expectedSkills);
  const matchedSkills = actualSkills.filter((s) => expectedSet.has(s));
  const missingSkills = expectedSkills.filter((s) => !actualSkillSet.has(s));
  const unexpectedSkills = actualSkills.filter((s) => !expectedSet.has(s));

  // Score: fraction of expected skills that were injected
  const matchScore =
    expectedSkills.length > 0 ? matchedSkills.length / expectedSkills.length : 1;

  return {
    slug,
    sessionId: sessionStats?.sessionId ?? null,
    expectedSkills,
    actualSkills,
    matchedSkills,
    missingSkills,
    unexpectedSkills,
    matchScore,
    tokens: sessionStats?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    toolCalls: sessionStats?.toolCalls ?? {},
    totalToolCalls: sessionStats?.totalToolCalls ?? 0,
    errors: sessionStats?.errors ?? [],
    traceInjections,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== Benchmark Analyzer ===`);
  console.log(`Base directory: ${BASE_DIR}`);
  console.log(`Results directory: ${RESULTS_DIR}\n`);

  // Load run manifest for exact project discovery and cwd correlation
  const manifestPath = join(RESULTS_DIR, "run-manifest.json");
  let manifest: BenchmarkRunManifest | null = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as BenchmarkRunManifest;
    console.log(`Loaded run manifest: ${manifest.runId}`);
  } catch {
    console.log(`No run manifest found, falling back to directory discovery`);
  }

  // Discover project slugs from manifest or results directory
  let slugEntries: Array<{ slug: string; cwd: string }>;

  if (manifest) {
    slugEntries = manifest.projects.map((p) => ({ slug: p.slug, cwd: p.cwd }));
  } else {
    const slugDirs: string[] = [];

    if (await dirExists(RESULTS_DIR)) {
      const resultEntries = await readdir(RESULTS_DIR);
      const discoveredFromResults = (
        await Promise.all(
          resultEntries.map(async (e) => {
            const p = join(RESULTS_DIR, e);
            return (await dirExists(p)) ? e : null;
          }),
        )
      ).filter((e): e is string => e !== null);
      slugDirs.push(...discoveredFromResults);
    }

    if (slugDirs.length > 0) {
      slugEntries = slugDirs.map((s) => ({ slug: s, cwd: join(BASE_DIR, s) }));
    } else {
      const discoveredFromSessions = await discoverBenchmarkAgentSlugEntries(BASE_DIR);
      if (discoveredFromSessions.length > 0) {
        slugEntries = discoveredFromSessions;
        await mkdir(RESULTS_DIR, { recursive: true });
        console.log(
          `No result subdirectories found; discovered ${slugEntries.length} benchmark-agent project(s) from ~/.claude/projects`,
        );
      } else {
        console.log(`No benchmark project sessions found in ${CLAUDE_PROJECTS_DIR}`);
        console.log(`Nothing to analyze.`);
        await mkdir(RESULTS_DIR, { recursive: true });
        await writeFile(
          join(RESULTS_DIR, "analysis-summary.json"),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            runId: null,
            projectCount: 0,
            avgMatchScore: 0,
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalToolCalls: 0,
            allMissingSkills: [],
            allUnexpectedSkills: [],
            scorecards: [],
          }, null, 2),
        );
        process.exit(0);
      }
    }
  }

  if (slugEntries.length === 0) {
    console.log(`No project result directories found in ${RESULTS_DIR}`);
    console.log(`Nothing to analyze.`);
    process.exit(0);
  }

  console.log(`Found ${slugEntries.length} project(s) to analyze\n`);

  const scorecards: Scorecard[] = [];

  for (const { slug, cwd: projectDir } of slugEntries.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const projectResultsDir = join(RESULTS_DIR, slug);

    console.log(`--- ${slug} ---`);

    // 1. Read run-meta.json for expected skills
    const meta = await safeReadJson<RunMeta>(join(projectResultsDir, "run-meta.json"));
    const expectedSkills = meta?.expectedSkills ?? [];

    // 2. Parse trace log from runner output
    const traceText = await safeReadText(join(projectResultsDir, "trace.log"));
    let traceInjections = parseTraceLog(traceText);

    // 3. Also check audit log in project directory
    const auditLog = await parseAuditLog(projectDir);
    if (auditLog.injections.length > 0 && traceInjections.length === 0) {
      traceInjections = auditLog.injections;
    } else if (auditLog.injections.length > traceInjections.length) {
      // Prefer the richer source
      traceInjections = auditLog.injections;
    }

    // 4. Find and analyze JSONL conversation logs
    let sessionStats: SessionStats | null = null;
    const jsonls = await findSessionJsonls(projectDir);
    if (jsonls.length > 0) {
      // Use the most recent session
      console.log(`  Found ${jsonls.length} session log(s), analyzing newest`);
      sessionStats = await analyzeSessionJsonl(jsonls[0]);
      console.log(
        `  Tokens: ${sessionStats.tokens.input} in / ${sessionStats.tokens.output} out | Tools: ${sessionStats.totalToolCalls}`,
      );

      if (!auditLog.found && traceInjections.length === 0) {
        const hookProgressInjections = await parseHookProgressInjectionsFromSessionJsonl(jsonls[0]);
        if (hookProgressInjections.length > 0) {
          traceInjections = hookProgressInjections;
          console.log(
            `  Using hook_progress fallback from session JSONL (${hookProgressInjections.length} event(s))`,
          );
        }
      }
    } else {
      console.log(`  No session logs found`);
    }

    console.log(`  Trace injections: ${traceInjections.length}`);

    // 5. Compute scorecard
    const scorecard = computeScorecard(slug, expectedSkills, sessionStats, traceInjections);
    scorecards.push(scorecard);

    // 6. Write per-slug scorecard
    await mkdir(projectResultsDir, { recursive: true });
    await writeFile(
      join(projectResultsDir, "scorecard.json"),
      JSON.stringify(scorecard, null, 2),
    );

    const score = (scorecard.matchScore * 100).toFixed(0);
    const status =
      scorecard.missingSkills.length === 0
        ? "PASS"
        : scorecard.matchScore >= 0.5
          ? "PARTIAL"
          : "MISS";
    console.log(
      `  Score: ${score}% (${status}) | Expected: [${expectedSkills.join(", ")}] | Actual: [${scorecard.actualSkills.join(", ")}]`,
    );
    if (scorecard.missingSkills.length > 0) {
      console.log(`  Missing: [${scorecard.missingSkills.join(", ")}]`);
    }
    if (scorecard.unexpectedSkills.length > 0) {
      console.log(`  Unexpected: [${scorecard.unexpectedSkills.join(", ")}]`);
    }
    console.log();
  }

  // Write aggregate summary
  const aggregatePath = join(RESULTS_DIR, "analysis-summary.json");
  const aggregate = {
    timestamp: new Date().toISOString(),
    runId: manifest?.runId ?? null,
    projectCount: scorecards.length,
    avgMatchScore:
      scorecards.length > 0
        ? scorecards.reduce((sum, s) => sum + s.matchScore, 0) / scorecards.length
        : 0,
    totalTokensIn: scorecards.reduce((sum, s) => sum + s.tokens.input, 0),
    totalTokensOut: scorecards.reduce((sum, s) => sum + s.tokens.output, 0),
    totalToolCalls: scorecards.reduce((sum, s) => sum + s.totalToolCalls, 0),
    allMissingSkills: [...new Set(scorecards.flatMap((s) => s.missingSkills))].sort(),
    allUnexpectedSkills: [...new Set(scorecards.flatMap((s) => s.unexpectedSkills))].sort(),
    scorecards: scorecards.map((s) => ({
      slug: s.slug,
      matchScore: s.matchScore,
      expected: s.expectedSkills,
      actual: s.actualSkills,
      missing: s.missingSkills,
      unexpected: s.unexpectedSkills,
    })),
  };
  await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2));

  // Print summary table
  console.log(`=== Analysis Summary ===`);
  console.log(
    `${"Slug".padEnd(28)} ${"Score".padEnd(8)} ${"Expected".padEnd(30)} ${"Actual".padEnd(30)} Missing`,
  );
  console.log("-".repeat(120));
  for (const s of scorecards) {
    const score = `${(s.matchScore * 100).toFixed(0)}%`;
    console.log(
      `${s.slug.padEnd(28)} ${score.padEnd(8)} ${s.expectedSkills.join(", ").padEnd(30)} ${s.actualSkills.join(", ").padEnd(30)} ${s.missingSkills.join(", ")}`,
    );
  }

  const avgScore = (aggregate.avgMatchScore * 100).toFixed(0);
  console.log(`\nAverage match score: ${avgScore}%`);
  console.log(`Total tokens: ${aggregate.totalTokensIn} in / ${aggregate.totalTokensOut} out`);
  console.log(`Total tool calls: ${aggregate.totalToolCalls}`);
  if (aggregate.allMissingSkills.length > 0) {
    console.log(`\nSkills never injected when expected: ${aggregate.allMissingSkills.join(", ")}`);
  }
  console.log(`\nResults saved to: ${RESULTS_DIR}`);
  console.log(`Per-project scorecards: results/<slug>/scorecard.json`);
  console.log(`Aggregate summary: results/analysis-summary.json\n`);

  // Exit with failure if average score is below 50%
  process.exit(aggregate.avgMatchScore < 0.5 ? 1 : 0);
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
