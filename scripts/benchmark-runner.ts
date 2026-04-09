#!/usr/bin/env bun
/**
 * Benchmark runner: creates test directories, installs the vercel-plugin,
 * and runs `claude --print` with VERCEL_PLUGIN_LOG_LEVEL=trace to exercise
 * skill injection across realistic scenarios.
 *
 * Usage: bun run scripts/benchmark-runner.ts [options]
 *   --quick        Run only the first 3 projects
 *   --base <path>  Override base directory (default: ~/dev/vercel-plugin-testing)
 *   --timeout <ms> Per-project timeout in ms (default: 900000 = 15 min)
 *   --help         Print usage and exit
 */

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface BenchmarkProject {
  slug: string;
  prompt: string;
  expectedSkills: string[];
}

export interface BenchmarkRunManifestProject {
  slug: string;
  cwd: string;
  promptHash: string;
  expectedSkills: string[];
}

export interface BenchmarkRunManifest {
  runId: string;
  timestamp: string;
  baseDir: string;
  projects: BenchmarkRunManifestProject[];
}

const PROJECTS: BenchmarkProject[] = [
  {
    slug: "01-doc-qa-agent",
    prompt:
      "Build a documentation Q&A agent with semantic search, citation links, and follow-up question memory. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-sdk", "vercel-storage", "nextjs"],
  },
  {
    slug: "02-customer-support-agent",
    prompt:
      "Create a customer support agent that triages tickets, drafts replies, and escalates urgent conversations with an authenticated admin dashboard. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-sdk", "auth", "vercel-storage"],
  },
  {
    slug: "03-deploy-monitor",
    prompt:
      "Build a deploy monitor that tracks preview and production deploy health, surfaces incidents, and posts summaries to an internal dashboard. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["observability", "deployments-cicd", "vercel-api"],
  },
  {
    slug: "04-multi-model-router",
    prompt:
      "Create a multi-model router that chooses the best model per request, supports failover policies, and streams responses to the UI. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-gateway", "ai-sdk", "nextjs"],
  },
  {
    slug: "05-slack-pr-reviewer",
    prompt:
      "Build a Slack PR reviewer that reacts to pull-request webhooks, summarizes diffs, and posts review guidance to Slack threads. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-sdk", "vercel-functions", "vercel-api"],
  },
  {
    slug: "06-content-pipeline",
    prompt:
      "Create a content pipeline that ingests drafts, runs scheduled enrichment, and publishes to multiple channels with approvals. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["workflow", "cron-jobs", "cms"],
  },
  {
    slug: "07-feature-rollout",
    prompt:
      "Build a feature rollout system with audience targeting, gradual percentage releases, and rollback controls with experiment tracking. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["vercel-flags", "observability"],
  },
  {
    slug: "08-event-driven-crm",
    prompt:
      "Create an event-driven CRM that processes inbound events, updates customer timelines, and triggers follow-up workflows. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["vercel-queues", "workflow", "vercel-storage"],
  },
  {
    slug: "09-code-sandbox-tutor",
    prompt:
      "Build a code sandbox tutor that runs untrusted snippets safely, explains execution errors, and gives step-by-step coaching. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["vercel-sandbox", "ai-sdk", "nextjs"],
  },
  {
    slug: "10-multi-agent-research",
    prompt:
      "Create a multi-agent research assistant that delegates subtasks, aggregates findings, and produces a cited final report. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-sdk", "workflow", "chat-sdk"],
  },
  {
    slug: "11-discord-game-master",
    prompt:
      "Build a Discord game master bot with turn tracking, encounter memory, and persistent campaign state across sessions. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["chat-sdk", "runtime-cache", "vercel-functions"],
  },
  {
    slug: "12-compliance-auditor",
    prompt:
      "Create a compliance auditor that scans configs, flags policy drift, and generates remediation reports for engineering teams. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["vercel-firewall", "observability", "vercel-api"],
  },
];

const DEFAULT_BASE = join(homedir(), "dev", "vercel-plugin-testing");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const PLUGIN_URL = "https://github.com/vercel/vercel-plugin";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    quick: { type: "boolean", default: false },
    base: { type: "string", default: DEFAULT_BASE },
    timeout: { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: bun run scripts/benchmark-runner.ts [options]
  --quick        Run only the first 3 projects
  --base <path>  Override base directory (default: ~/dev/vercel-plugin-testing)
  --timeout <ms> Per-project timeout in ms (default: 900000 = 15 min)
  --help         Print usage and exit`);
  process.exit(0);
}

const BASE_DIR = resolve(flags.base!);
const TIMEOUT_MS = parseInt(flags.timeout!, 10);
const projects = flags.quick ? PROJECTS.slice(0, 3) : PROJECTS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(startMs: number): string {
  const s = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${s}s`;
}

function hashPrompt(prompt: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(prompt);
  return hasher.digest("hex").slice(0, 12);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function installPlugin(projectDir: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(
    ["npx", "add-plugin", PLUGIN_URL, "-s", "project", "-y"],
    { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, output: stdout + stderr };
}

interface RunResult {
  slug: string;
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  claudeOutput: string;
  traceLog: string;
  error?: string;
}

async function runClaude(
  projectDir: string,
  prompt: string,
  slug: string,
  timeoutMs: number,
): Promise<RunResult> {
  const start = Date.now();
  const settingsPath = join(projectDir, ".claude", "settings.json");

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    VERCEL_PLUGIN_LOG_LEVEL: "trace",
  };
  // Prevent nested session errors
  delete env.CLAUDECODE;

  const proc = Bun.spawn(
    ["claude", "--print", prompt, "--settings", settingsPath],
    {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env,
    },
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    // Force kill after 10s grace period
    setTimeout(() => proc.kill("SIGKILL"), 10_000);
  }, timeoutMs);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return {
    slug,
    success: exitCode === 0 && !timedOut,
    timedOut,
    durationMs: Date.now() - start,
    claudeOutput: stdout,
    traceLog: stderr,
    error: exitCode !== 0 ? `exit code ${exitCode}` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== Benchmark Runner ===`);
  console.log(`Base directory: ${BASE_DIR}`);
  console.log(`Projects: ${projects.length} (${flags.quick ? "quick" : "full"})`);
  console.log(`Timeout per project: ${TIMEOUT_MS / 1000}s\n`);

  const resultsDir = join(BASE_DIR, "results");
  await ensureDir(resultsDir);

  const summary: Array<{
    slug: string;
    success: boolean;
    timedOut: boolean;
    durationMs: number;
    pluginInstalled: boolean;
    expectedSkills: string[];
    error?: string;
  }> = [];

  for (const project of projects) {
    const projectDir = join(BASE_DIR, project.slug);
    const projectResultsDir = join(resultsDir, project.slug);

    try {
      await ensureDir(projectDir);
      await ensureDir(projectResultsDir);

      console.log(`--- ${project.slug} ---`);

      // Step 1: Install plugin
      console.log(`  Installing plugin...`);
      const install = await installPlugin(projectDir);
      if (!install.ok) {
        console.log(`  Plugin install FAILED`);
        await writeFile(join(projectResultsDir, "install.log"), install.output);
        await writeFile(
          join(projectResultsDir, "run-meta.json"),
          JSON.stringify(
            {
              slug: project.slug,
              success: false,
              timedOut: false,
              durationMs: 0,
              expectedSkills: project.expectedSkills,
              error: "plugin install failed",
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        summary.push({
          slug: project.slug,
          success: false,
          timedOut: false,
          durationMs: 0,
          pluginInstalled: false,
          expectedSkills: project.expectedSkills,
        });
        continue;
      }
      console.log(`  Plugin installed`);

      // Step 2: Run claude --print
      console.log(`  Running claude --print (timeout ${TIMEOUT_MS / 1000}s)...`);
      const result = await runClaude(projectDir, project.prompt, project.slug, TIMEOUT_MS);

      // Step 3: Save outputs
      await writeFile(join(projectResultsDir, "claude-output.txt"), result.claudeOutput);
      await writeFile(join(projectResultsDir, "trace.log"), result.traceLog);
      await writeFile(
        join(projectResultsDir, "run-meta.json"),
        JSON.stringify(
          {
            slug: project.slug,
            success: result.success,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            expectedSkills: project.expectedSkills,
            error: result.error ?? null,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const status = result.timedOut
        ? "TIMEOUT"
        : result.success
          ? "OK"
          : "FAIL";
      console.log(`  ${status} (${(result.durationMs / 1000).toFixed(1)}s)`);

      summary.push({
        slug: project.slug,
        success: result.success,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        pluginInstalled: true,
        expectedSkills: project.expectedSkills,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR: ${message}`);

      // Best-effort write run-meta.json with error
      try {
        await ensureDir(projectResultsDir);
        await writeFile(
          join(projectResultsDir, "run-meta.json"),
          JSON.stringify(
            {
              slug: project.slug,
              success: false,
              timedOut: false,
              durationMs: 0,
              expectedSkills: project.expectedSkills,
              error: message,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      } catch { /* ignore write failures */ }

      summary.push({
        slug: project.slug,
        success: false,
        timedOut: false,
        durationMs: 0,
        pluginInstalled: false,
        expectedSkills: project.expectedSkills,
        error: message,
      });
    }
  }

  // Write run manifest linking all pipeline stages
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const manifest: BenchmarkRunManifest = {
    runId,
    timestamp: new Date().toISOString(),
    baseDir: BASE_DIR,
    projects: projects.map((p) => ({
      slug: p.slug,
      cwd: join(BASE_DIR, p.slug),
      promptHash: hashPrompt(p.prompt),
      expectedSkills: p.expectedSkills,
    })),
  };
  const manifestPath = join(resultsDir, "run-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Always write overall summary, even if some projects failed
  const summaryPath = join(resultsDir, "runner-summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  // Print summary table
  console.log(`\n=== Summary ===`);
  console.log(`${"Slug".padEnd(28)} ${"Status".padEnd(10)} ${"Duration".padEnd(10)} Expected Skills`);
  console.log("-".repeat(80));
  for (const s of summary) {
    const status = !s.pluginInstalled
      ? "NO-PLUGIN"
      : s.timedOut
        ? "TIMEOUT"
        : s.success
          ? "OK"
          : "FAIL";
    const dur = s.durationMs > 0 ? `${(s.durationMs / 1000).toFixed(1)}s` : "-";
    console.log(
      `${s.slug.padEnd(28)} ${status.padEnd(10)} ${dur.padEnd(10)} ${s.expectedSkills.join(", ")}`,
    );
  }

  const passed = summary.filter((s) => s.success).length;
  console.log(`\n${passed}/${summary.length} projects completed successfully`);
  console.log(`Results saved to: ${resultsDir}\n`);

  // Exit codes: 0 = all pass, 1 = some failures, 2 = fatal only (caught in .catch)
  process.exit(passed === summary.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
