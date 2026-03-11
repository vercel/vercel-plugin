#!/usr/bin/env bun
/**
 * Sandbox eval runner with 3-phase pipeline: Build → Verify → Deploy.
 *
 * Phase 1 (BUILD):  Claude Code builds the app in a fresh sandbox.
 * Phase 2 (VERIFY): A follow-up Claude Code session uses agent-browser to
 *                    walk through user stories, fixing issues until all pass.
 * Phase 3 (DEPLOY): A third Claude Code session links to vercel-labs, runs
 *                    `vercel deploy`, and fixes build errors (up to 3 retries).
 *                    Deployed apps have deployment protection enabled by default.
 *
 * Skills are tracked across all 3 phases — each phase may trigger additional
 * skill injections as new files/patterns are created.
 *
 * Usage:
 *   bun run .claude/skills/benchmark-sandbox/run-eval.ts [options]
 *   --concurrency N     Max parallel sandboxes (default 5, max 10)
 *   --timeout MS        Per-phase timeout in ms (default 1800000 = 30 min)
 *   --keep-alive        Keep sandboxes running after eval
 *   --keep-hours N      Hours to keep alive (default 8)
 *   --skip-verify       Skip the agent-browser verification phase
 *   --skip-deploy       Skip the Vercel deploy phase
 *   --scenarios a,b,c   Only run specific scenarios by slug
 *   --scenarios-file f  Load scenarios from a JSON file
 */

import { Sandbox } from "@vercel/sandbox";
import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SANDBOX_HOME = "/home/vercel-sandbox";
const SANDBOX_PLUGIN_DIR = `${SANDBOX_HOME}/vercel-plugin`;
const LOCAL_PLUGIN_DIR = join(homedir(), "dev", "vercel-plugin");
const UPLOAD_DIRS = ["hooks", "skills", "generated"];
const RESULTS_DIR = join(homedir(), "dev", "vercel-plugin-testing", "sandbox-results");

const args = process.argv.slice(2);
const getArg = (name: string, fallback: number) =>
  args.includes(`--${name}`) ? parseInt(args[args.indexOf(`--${name}`) + 1], 10) : fallback;
const CONCURRENCY = Math.min(Math.max(getArg("concurrency", 5), 1), 10);
const TIMEOUT_MS = getArg("timeout", 1_800_000);
let runId = "";
const KEEP_ALIVE = args.includes("--keep-alive");
const KEEP_ALIVE_HOURS = getArg("keep-hours", 8);
const SKIP_VERIFY = args.includes("--skip-verify");
const SKIP_DEPLOY = args.includes("--skip-deploy");
const BUILD_STATUS_INTERVAL_MS = 20_000;
const BUILD_WAIT_POLL_MS = 15_000;
const SCENARIO_FILTER = args.includes("--scenarios")
  ? args[args.indexOf("--scenarios") + 1]?.split(",").map(s => s.trim()) ?? []
  : [];
const SCENARIOS_FILE = args.includes("--scenarios-file")
  ? args[args.indexOf("--scenarios-file") + 1]
  : undefined;

// ---------------------------------------------------------------------------
// Scenarios — loaded from --scenarios-file if provided, otherwise defaults
// ---------------------------------------------------------------------------

interface Scenario {
  slug: string;
  prompt: string;
  expectedSkills: string[];
  userStories: [string, string, string];
}

const SCENARIOS: Scenario[] = [
  {
    slug: "ai-writing-assistant",
    prompt: `Build a Next.js AI writing assistant app. Requirements:
- Use AI SDK (\`ai\` package) with \`streamText\` and the anthropic provider (\`@ai-sdk/anthropic\`) for real AI responses
- Create /api/chat route handler using AI SDK's \`streamText\` that streams a writing assistant response
- The assistant should help rewrite, expand, or summarize text the user provides
- Use shadcn/ui (Textarea for input, Button, Card for output, Tabs for mode: rewrite/expand/summarize)
- Use SWR (\`swr\`) for client-side state management
- Use Geist font via next/font
- Add middleware.ts that logs request paths with timestamps
- Link the project to my vercel-labs team so we can deploy it later
After building all files, start the dev server on port 3000 with \`npx next dev --port 3000\`.`,
    expectedSkills: ["ai-sdk", "swr", "shadcn", "routing-middleware", "geist", "nextjs"],
    userStories: [
      "As a user, I can see a text area where I can paste or type content to be processed by AI",
      "As a user, I can select a mode (rewrite, expand, or summarize) and click a button to get an AI response",
      "As a user, I can see the AI-generated response appear with streaming text output",
    ],
  },
  {
    slug: "ai-code-reviewer",
    prompt: `Build a Next.js AI code review tool. Requirements:
- Use AI SDK (\`ai\` package) with \`streamText\` and the anthropic provider (\`@ai-sdk/anthropic\`) for real AI code analysis
- Create /api/review route that accepts code and returns AI review comments with streaming
- Use shadcn/ui (Textarea with monospace font for code input, Card for review results, Badge for severity, Button)
- Use Vercel Flags (\`@vercel/flags/next\`) with a flag to toggle between "quick review" and "deep review" modes
- Create a flags.ts with the review mode flag using \`flag()\`
- Add /api/cron/stats route for tracking review statistics (mock implementation)
- Add structured observability logging in all API routes (JSON with timestamp, level, message, duration)
- Use edge runtime for a /api/health route
- Link the project to my vercel-labs team
After building all files, start the dev server on port 3000 with \`npx next dev --port 3000\`.`,
    expectedSkills: ["ai-sdk", "vercel-flags", "shadcn", "cron-jobs", "observability", "edge-runtime", "nextjs", "vercel-functions"],
    userStories: [
      "As a user, I can see a code input area where I can paste code for review",
      "As a user, I can click a Review button and see AI-generated code review comments appear",
      "As a user, I can see severity indicators (like badges) on the review feedback",
    ],
  },
  {
    slug: "ai-flashcard-trainer",
    prompt: `Build a Next.js AI flashcard study app. Requirements:
- Use AI SDK (\`ai\` package) with \`generateText\` and the anthropic provider (\`@ai-sdk/anthropic\`) to generate flashcard content from a topic
- Create /api/generate route that takes a topic and returns 5 flashcards (question + answer) as JSON using AI
- Create /api/quiz route that uses AI to evaluate user answers and provide feedback
- Store flashcard decks in-memory via a /api/decks CRUD route (GET returns all decks, POST creates new)
- Use shadcn/ui (Card for flashcards with flip animation via CSS, Button, Input, Progress bar for score)
- Use SWR for fetching decks on the client
- Use Vercel KV / runtime cache pattern (mock with in-memory Map) for caching generated decks
- Use Geist font
- Link the project to my vercel-labs team
After building all files, start the dev server on port 3000 with \`npx next dev --port 3000\`.`,
    expectedSkills: ["ai-sdk", "swr", "shadcn", "runtime-cache", "geist", "nextjs", "vercel-functions"],
    userStories: [
      "As a user, I can enter a topic and click Generate to have AI create flashcards",
      "As a user, I can see flashcards displayed and flip them to reveal the answer",
      "As a user, I can see a score or progress indicator showing how many cards I got right",
    ],
  },
  {
    slug: "ai-meeting-summarizer",
    prompt: `Build a Next.js AI meeting notes summarizer. Requirements:
- Use AI SDK (\`ai\` package) with \`streamText\` and the anthropic provider (\`@ai-sdk/anthropic\`) for streaming summaries
- Create /api/summarize route that takes meeting notes text and streams an AI summary with action items
- Create /api/meetings CRUD routes (GET, POST) storing meetings in-memory
- Use shadcn/ui (Textarea for notes input, Card for summary output, Table for action items, Button, Dialog)
- Use Satori (\`satori\`) in an /api/og/[id] route to generate OG image cards showing meeting title and date
- Add middleware.ts with request timing and path logging
- Use edge runtime for the /api/og route
- Use Vercel Functions for all other API routes
- Link the project to my vercel-labs team
After building all files, start the dev server on port 3000 with \`npx next dev --port 3000\`.`,
    expectedSkills: ["ai-sdk", "satori", "shadcn", "routing-middleware", "edge-runtime", "nextjs", "vercel-functions"],
    userStories: [
      "As a user, I can paste meeting notes into a text area and click Summarize",
      "As a user, I can see an AI-generated summary with key points streamed to the page",
      "As a user, I can see extracted action items displayed in a list or table",
    ],
  },
  {
    slug: "ai-deploy-analyzer",
    prompt: `Build a Next.js deployment health analyzer with AI insights. Requirements:
- Create /api/deployments route returning mock deployment data (10 deployments with status, url, timestamp, duration)
- Use AI SDK (\`ai\` package) with \`generateText\` and the anthropic provider (\`@ai-sdk/anthropic\`) in /api/analyze route that takes deployment data and returns AI health analysis
- Use Vercel Flags (\`@vercel/flags/next\`) to toggle "show AI insights" with a \`flag()\` definition
- Create flags.ts with the feature flag
- Use shadcn/ui (Table for deployments, Badge for status, Card for AI insights, Tabs, Alert)
- Add /api/cron/health-check route that returns a health status JSON
- Add vercel.json with crons config for the health check
- Add structured observability logging (JSON with timestamp, level, message) in every API route
- Use edge runtime for the health-check cron route
- Link the project to my vercel-labs team
After building all files, start the dev server on port 3000 with \`npx next dev --port 3000\`.`,
    expectedSkills: ["ai-sdk", "vercel-flags", "shadcn", "cron-jobs", "observability", "edge-runtime", "nextjs", "vercel-functions"],
    userStories: [
      "As a user, I can see a table of deployments with status badges showing health",
      "As a user, I can click an Analyze button and see AI-generated health insights appear",
      "As a user, I can see alert or warning cards highlighting any deployment issues the AI found",
    ],
  },
];

// Load scenarios from file if --scenarios-file is provided
let ACTIVE_SCENARIOS = SCENARIOS;
if (SCENARIOS_FILE) {
  try {
    const raw = require("fs").readFileSync(SCENARIOS_FILE, "utf-8");
    ACTIVE_SCENARIOS = JSON.parse(raw) as Scenario[];
    console.log(`Loaded ${ACTIVE_SCENARIOS.length} scenarios from ${SCENARIOS_FILE}`);
  } catch (e: any) {
    console.error(`Failed to load scenarios from ${SCENARIOS_FILE}: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(0)}s`;
}

function resolveApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return execSync('security find-generic-password -a "$USER" -s "ANTHROPIC_AUTH_TOKEN" -w', {
      encoding: "utf-8", timeout: 5000,
    }).trim();
  } catch {}
  console.error("Missing ANTHROPIC_API_KEY"); process.exit(1);
}

function resolveVercelToken(): string | undefined {
  try {
    return JSON.parse(require("fs").readFileSync(join(homedir(), ".local/share/com.vercel.cli/auth.json"), "utf-8")).token;
  } catch { return undefined; }
}

async function collectPluginFiles(): Promise<Array<{ path: string; content: Buffer }>> {
  const files: Array<{ path: string; content: Buffer }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(join(LOCAL_PLUGIN_DIR, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = join(dir, entry.name);
      const fullPath = join(LOCAL_PLUGIN_DIR, relPath);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "src", ".claude", "tests", "scripts", ".playground"].includes(entry.name)) continue;
        await walk(relPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".mts") || entry.name.endsWith(".test.ts")) continue;
        const s = await stat(fullPath);
        if (s.size > 200_000) continue;
        files.push({ path: join(SANDBOX_PLUGIN_DIR, relPath), content: await readFile(fullPath) });
      }
    }
  }
  for (const dir of UPLOAD_DIRS) await walk(dir);
  for (const f of ["hooks/hooks.json", "package.json"]) {
    try { files.push({ path: join(SANDBOX_PLUGIN_DIR, f), content: await readFile(join(LOCAL_PLUGIN_DIR, f)) }); } catch {}
  }
  return files;
}

async function sh(sandbox: any, cmd: string): Promise<string> {
  try { const r = await sandbox.runCommand("sh", ["-c", cmd]); return (await r.stdout()).trim(); }
  catch { return "(cmd failed)"; }
}

function normalizeShellOutput(output: string): string {
  return output === "(cmd failed)" ? "" : output.trim();
}

export function isExpectedRunCommandTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timed out|deadline exceeded|operation timed out|request timeout/i.test(message);
}

export function parseBuildExitCode(output: string): number | null {
  const normalized = normalizeShellOutput(output);
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);
  const matches = [...normalized.matchAll(/EXIT:(\d+)/g)];
  if (matches.length === 0) return null;
  return parseInt(matches[matches.length - 1][1], 10);
}

type BuildWaitInput = {
  claudeProbe: string;
  debugLine: string;
  elapsedMs: number;
  timeoutMs: number;
};

export type BuildWaitState = {
  claudeRunning: boolean;
  sessionEnded: boolean;
  timedOut: boolean;
  shouldKeepPolling: boolean;
};

export function evaluateBuildWaitState(input: BuildWaitInput): BuildWaitState {
  const claudeRunning = normalizeShellOutput(input.claudeProbe).length > 0;
  const sessionEnded = /\bSessionEnd\b/.test(normalizeShellOutput(input.debugLine));
  const timedOut = input.elapsedMs >= input.timeoutMs;
  return {
    claudeRunning,
    sessionEnded,
    timedOut,
    shouldKeepPolling: !timedOut && claudeRunning && !sessionEnded,
  };
}

function buildVerificationPrompt(userStories: string[]): string {
  const stories = userStories.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `First, make sure the dev server is running. Check if http://localhost:3000 responds. If not, run \`npx next dev --port 3000\` in the background and wait for it to be ready.

Then use agent-browser to verify these user stories:

${stories}

For EACH story, follow this exact workflow:
1. agent-browser open http://localhost:3000
2. agent-browser wait --load networkidle
3. agent-browser screenshot --annotate
4. agent-browser snapshot -i
5. Interact with the UI (click buttons, fill inputs, etc.) to test the story
6. agent-browser screenshot --annotate (capture the result)
7. Determine if the story PASSED or FAILED

If a story FAILS:
- Fix the code to make it pass
- Restart the dev server if needed: kill the old one and run \`npx next dev --port 3000\` again
- Re-verify the story

After testing all stories, output a summary in this exact format:
VERIFICATION_RESULTS:
STORY_1: PASS or FAIL
STORY_2: PASS or FAIL
STORY_3: PASS or FAIL`;
}

// ---------------------------------------------------------------------------
// Structured scoring via haiku (runs inside sandbox, no hooks)
// ---------------------------------------------------------------------------

interface HaikuScore {
  [key: string]: unknown;
}

async function scoreWithHaiku(
  sandbox: any,
  claudeBin: string,
  prompt: string,
  schema: Record<string, unknown>,
  label: string,
  slug: string,
  t0: number,
): Promise<HaikuScore | null> {
  const schemaJson = JSON.stringify(schema).replace(/'/g, "'\\''"); // escape single quotes for shell
  const promptPath = `/tmp/score-${label}.txt`;
  await sandbox.writeFiles([{ path: promptPath, content: Buffer.from(prompt) }]);
  const cmd = `${claudeBin} -p "$(cat ${promptPath})" --json-schema '${schemaJson}' --output-format json --model haiku --setting-sources ""`;
  try {
    const sr = await sandbox.runCommand("sh", ["-c", cmd], { signal: AbortSignal.timeout(120_000) }); // 2 min max
    const out = (await sr.stdout()).trim();
    const parsed = JSON.parse(out);
    // claude -p --output-format json wraps the result — structured_output has our schema data
    return parsed.structured_output ?? parsed;
  } catch (e: any) {
    console.log(`  [${slug}] ${label} score failed: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

const STORIES_SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          status: { type: "string", enum: ["pass", "fail"] },
          reason: { type: "string" },
        },
        required: ["index", "status", "reason"],
      },
    },
  },
  required: ["stories"],
};

const BUILD_SCORE_SCHEMA = {
  type: "object",
  properties: {
    completeness: { type: "string", enum: ["complete", "partial", "minimal", "empty"] },
    hasApiRoutes: { type: "boolean" },
    hasUIComponents: { type: "boolean" },
    hasAIFeature: { type: "boolean" },
    devServerRunning: { type: "boolean" },
    missingFeatures: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["completeness", "hasApiRoutes", "hasUIComponents", "hasAIFeature", "devServerRunning", "missingFeatures", "summary"],
};

const DEPLOY_SCORE_SCHEMA = {
  type: "object",
  properties: {
    deployed: { type: "boolean" },
    url: { type: "string" },
    buildSucceeded: { type: "boolean" },
    errors: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["deployed", "buildSucceeded", "summary"],
};

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

interface VerificationResult {
  ran: boolean;
  exitCode: number;
  stories: Array<{ index: number; status: "pass" | "fail" | "unknown" }>;
  output: string;
}

interface ScenarioTiming {
  sandboxCreateMs: number | null;
  installMs: number | null;
  pluginInstallMs: number | null;
  buildStartMs: number | null;
  buildEndMs: number | null;
  verifyStartMs: number | null;
  verifyEndMs: number | null;
  deployStartMs: number | null;
  deployEndMs: number | null;
  extractMs: number | null;
}

interface ArtifactManifestEntry {
  fileName: string;
  sizeBytes: number;
  description: string;
}

interface ScenarioResult {
  slug: string;
  sandboxId: string;
  success: boolean;
  durationMs: number;
  claimedSkills: string[];
  expectedSkills: string[];
  projectFiles: string[];
  appUrl?: string;
  deployUrl?: string;
  sourcePath?: string;
  error?: string;
  pollHistory: Array<{ elapsed: string; skills: string[]; files: number }>;
  verification?: VerificationResult;
  buildScore?: HaikuScore | null;
  deployScore?: HaikuScore | null;
  timing: ScenarioTiming;
}

function captureElapsedMs(start: number, end = performance.now()): number {
  return Math.max(0, Math.round(end - start));
}

function captureRelativeMs(start: number, end = performance.now()): number {
  return Math.max(0, Math.round(end - start));
}

export function calculatePhaseDuration(startMs: number | null | undefined, endMs: number | null | undefined): number | null {
  if (typeof startMs !== "number" || typeof endMs !== "number") return null;
  return Math.max(0, endMs - startMs);
}

function formatTimingDuration(durationMs: number | null | undefined): string {
  return typeof durationMs === "number" ? `${(durationMs / 1000).toFixed(1)}s` : "skip";
}

export function renderTimingMarkdownTable(results: Array<{ slug: string; timing?: ScenarioTiming }>): string {
  let md = `## Timing\n\n`;
  md += `| Scenario | Sandbox | Install | Plugin | Build | Verify | Deploy | Extract |\n`;
  md += `|----------|---------|---------|--------|-------|--------|--------|---------|\n`;
  for (const result of results) {
    const timing = result.timing;
    md += `| ${result.slug} | ${formatTimingDuration(timing?.sandboxCreateMs)} | ${formatTimingDuration(timing?.installMs)} | ${formatTimingDuration(timing?.pluginInstallMs)} | ${formatTimingDuration(calculatePhaseDuration(timing?.buildStartMs, timing?.buildEndMs))} | ${formatTimingDuration(calculatePhaseDuration(timing?.verifyStartMs, timing?.verifyEndMs))} | ${formatTimingDuration(calculatePhaseDuration(timing?.deployStartMs, timing?.deployEndMs))} | ${formatTimingDuration(timing?.extractMs)} |\n`;
  }
  return md;
}

export function buildArtifactManifest(entries: ArtifactManifestEntry[]) {
  return {
    generatedAt: new Date().toISOString(),
    artifactCount: entries.length,
    artifacts: [...entries].sort((a, b) => a.fileName.localeCompare(b.fileName)),
  };
}

export function summarizeToolCalls(grepOutput: string): string {
  const normalized = normalizeShellOutput(grepOutput);
  if (!normalized) return "No executePreToolHooks entries found.";

  return normalized
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const timestampMatch = line.match(/"timestamp":"([^"]+)"/) ?? line.match(/\d{4}-\d{2}-\d{2}T[^\s"]+/);
      const timestamp = timestampMatch
        ? timestampMatch[1] ?? timestampMatch[0]
        : "unknown-timestamp";
      const toolMatch =
        line.match(/"tool(?:Name)?":"([^"]+)"/i)
        ?? line.match(/\btool(?:Name)?[=: ]+["']?([A-Za-z0-9._-]+)["']?/i)
        ?? line.match(/"tool_name":"([^"]+)"/i);
      const toolName = toolMatch
        ? toolMatch[1]
        : "unknown-tool";
      return `${timestamp} | ${toolName} | ${line}`;
    })
    .join("\n");
}

async function readSandboxFileBuffer(sandbox: any, path: string): Promise<Buffer | null> {
  const stream = await sandbox.readFile({ path });
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function writeArchiveArtifact(
  archiveDir: string,
  fileName: string,
  description: string,
  content: Buffer | string,
): Promise<ArtifactManifestEntry> {
  const artifactPath = join(archiveDir, fileName);
  await writeFile(artifactPath, content);
  const artifactStats = await stat(artifactPath);
  return {
    fileName,
    sizeBytes: artifactStats.size,
    description,
  };
}

async function runScenario(
  scenario: Scenario,
  apiKey: string,
  baseUrl: string,
  vercelToken: string | undefined,
  pluginFiles: Array<{ path: string; content: Buffer }>,
): Promise<ScenarioResult> {
  const t0 = performance.now();
  const projectDir = `${SANDBOX_HOME}/${scenario.slug}`;
  const pollHistory: ScenarioResult["pollHistory"] = [];
  const timing: ScenarioTiming = {
    sandboxCreateMs: null,
    installMs: null,
    pluginInstallMs: null,
    buildStartMs: null,
    buildEndMs: null,
    verifyStartMs: null,
    verifyEndMs: null,
    deployStartMs: null,
    deployEndMs: null,
    extractMs: null,
  };
  let sandbox: InstanceType<typeof Sandbox> | undefined;

  try {
    // 1. Create sandbox with port 3000
    console.log(`  [${scenario.slug}] Creating sandbox...`);
    const sandboxCreateStartedAt = performance.now();
    sandbox = await Sandbox.create({
      runtime: "node24",
      ports: [3000],
      env: {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: baseUrl,
        VERCEL_PLUGIN_LOG_LEVEL: "trace",
        ...(vercelToken ? { VERCEL_TOKEN: vercelToken } : {}),
      },
      timeout: TIMEOUT_MS + 300_000,
    } as any);
    timing.sandboxCreateMs = captureElapsedMs(sandboxCreateStartedAt);
    let appUrl: string | undefined;
    try { appUrl = sandbox.domain(3000); } catch {}
    console.log(`  [${scenario.slug}] Sandbox ${sandbox.sandboxId}${appUrl ? ` | ${appUrl}` : ""} (${elapsed(t0)})`);

    // 2. Install Claude Code + Vercel CLI + agent-browser
    const installStartedAt = performance.now();
    await sandbox.runCommand("sh", ["-c", "npm install -g @anthropic-ai/claude-code vercel agent-browser"]);
    timing.installMs = captureElapsedMs(installStartedAt);
    const claudeBin = await sh(sandbox, "which claude");
    const abBin = await sh(sandbox, "which agent-browser");
    console.log(`  [${scenario.slug}] claude=${claudeBin} agent-browser=${abBin} (${elapsed(t0)})`);

    // 3. Vercel CLI auth
    if (vercelToken) {
      await sandbox.writeFiles([{
        path: `${SANDBOX_HOME}/.local/share/com.vercel.cli/auth.json`,
        content: Buffer.from(JSON.stringify({ token: vercelToken })),
      }]);
    }

    // 4. Project setup + plugin
    const pluginInstallStartedAt = performance.now();
    await sandbox.runCommand("sh", ["-c", `mkdir -p ${projectDir} && cd ${projectDir} && npm init -y`]);
    await sandbox.writeFiles(pluginFiles);
    await sh(sandbox, `cd ${projectDir} && npx -y add-plugin ${SANDBOX_PLUGIN_DIR} -s project -y --target claude-code 2>&1 | tail -1`);
    timing.pluginInstallMs = captureElapsedMs(pluginInstallStartedAt);
    console.log(`  [${scenario.slug}] Plugin installed (${elapsed(t0)})`);

    // 5. Phase 1: Build the app
    await sandbox.writeFiles([{ path: "/tmp/prompt.txt", content: Buffer.from(scenario.prompt) }]);
    const settingsPath = `${projectDir}/.claude/settings.json`;
    const buildCmd = `cd ${projectDir} && ${claudeBin} --dangerously-skip-permissions --debug --settings ${settingsPath} "$(cat /tmp/prompt.txt)"`;
    const buildStartedAt = Date.now();
    timing.buildStartMs = captureRelativeMs(t0);
    const logFile = "/tmp/claude-build-round-1.log";
    const errFile = "/tmp/claude-build-round-1.err";
    const exitFile = "/tmp/claude-build-round-1.exit";

    async function pollBuildProgress(includeProcessState = false): Promise<BuildWaitState | null> {
      try {
        const [skillsRaw, fileCountRaw, port3000Raw, claudeProbeRaw, debugLineRaw] = await Promise.all([
          sh(sandbox!, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null"),
          sh(sandbox!, `find ${projectDir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.claude/*' -newer /tmp/prompt.txt -type f 2>/dev/null | wc -l`),
          sh(sandbox!, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null || echo 'down'"),
          includeProcessState
            ? sh(sandbox!, "pgrep -f claude 2>/dev/null || true")
            : Promise.resolve(""),
          includeProcessState
            ? sh(sandbox!, "ls -t ~/.claude/debug/*.txt 2>/dev/null | head -1 | xargs tail -1 2>/dev/null || true")
            : Promise.resolve(""),
        ]);
        const skills = normalizeShellOutput(skillsRaw).split("\n").filter(Boolean);
        const fileCount = parseInt(normalizeShellOutput(fileCountRaw), 10) || 0;
        const port3000 = normalizeShellOutput(port3000Raw) || "down";
        if (!appUrl && port3000 !== "000down" && port3000 !== "down") {
          try { appUrl = sandbox!.domain(3000); } catch {}
        }
        pollHistory.push({ elapsed: elapsed(t0), skills, files: fileCount });
        const waitState = includeProcessState
          ? evaluateBuildWaitState({
            claudeProbe: claudeProbeRaw,
            debugLine: debugLineRaw,
            elapsedMs: Date.now() - buildStartedAt,
            timeoutMs: TIMEOUT_MS,
          })
          : null;
        const debugLine = normalizeShellOutput(debugLineRaw);
        const waitSuffix = waitState
          ? ` | claude=${waitState.claudeRunning ? "running" : "exited"} | sessionEnd=${waitState.sessionEnded ? "yes" : "no"}${waitState.timedOut ? " | wait=timeout" : ""}${debugLine ? ` | debug=${debugLine.slice(-120)}` : ""}`
          : "";
        console.log(`  [${scenario.slug}] ${elapsed(t0)} | skills: ${skills.join(", ") || "(none)"} | files: ${fileCount} | :3000=${port3000}${waitSuffix}`);
        return waitState;
      } catch {
        return null;
      }
    }

    async function readBuildExitCode(): Promise<number | null> {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const exitRaw = await sh(sandbox!, `cat ${exitFile} 2>/dev/null || grep -o 'EXIT:[0-9]\\+' ${logFile} 2>/dev/null | tail -1`);
        const parsed = parseBuildExitCode(exitRaw);
        if (parsed !== null) return parsed;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return null;
    }

    console.log(`  [${scenario.slug}] Phase 1: BUILD started (single launch + fire-and-forget poll after API timeout) (${elapsed(t0)})`);

    const pollInterval = setInterval(() => {
      void pollBuildProgress(false);
    }, BUILD_STATUS_INTERVAL_MS);

    let buildExit = -1;
    let buildLaunchTimedOut = false;
    // Redirect stdout/stderr to files so we can capture them even if runCommand times out.
    const wrappedCmd = `${buildCmd} > ${logFile} 2> ${errFile}; status=$?; echo "EXIT:$status" >> ${logFile}; printf '%s' "$status" > ${exitFile}`;
    try {
      const r = await sandbox.runCommand("sh", ["-c", wrappedCmd]);
      buildExit = (r as any).exitCode ?? 0;
    } catch (e: any) {
      if (isExpectedRunCommandTimeout(e)) {
        buildLaunchTimedOut = true;
        buildExit = 124;
        console.log(`  [${scenario.slug}] Build launch hit the expected 300s API timeout; waiting on sandbox process state (${elapsed(t0)})`);
      } else {
        console.log(`  [${scenario.slug}] Build launch failed | attempt=runCommand | state=launching | error=${e.message?.slice(0, 200)} (${elapsed(t0)})`);
        buildExit = 1;
      }
    } finally {
      clearInterval(pollInterval);
    }

    if (buildLaunchTimedOut) {
      // After the HTTP timeout the shell keeps running inside the sandbox, so poll
      // process/debug state until Claude exits or the phase deadline is exhausted.
      while (true) {
        const waitState = await pollBuildProgress(true);
        if (!waitState) {
          if (Date.now() - buildStartedAt >= TIMEOUT_MS) {
            buildExit = 124;
            console.log(`  [${scenario.slug}] Build wait probe stalled past phase timeout (${TIMEOUT_MS / 1000}s) (${elapsed(t0)})`);
            break;
          }
          console.log(`  [${scenario.slug}] Build wait probe failed; retrying in ${BUILD_WAIT_POLL_MS / 1000}s (${elapsed(t0)})`);
          await new Promise((resolve) => setTimeout(resolve, BUILD_WAIT_POLL_MS));
          continue;
        }
        if (!waitState.shouldKeepPolling) {
          if (waitState.timedOut) {
            buildExit = 124;
            console.log(`  [${scenario.slug}] Build wait reached phase timeout (${TIMEOUT_MS / 1000}s) (${elapsed(t0)})`);
          } else {
            const exitCode = await readBuildExitCode();
            if (exitCode !== null) buildExit = exitCode;
            console.log(`  [${scenario.slug}] Build process finished | claude=${waitState.claudeRunning ? "running" : "exited"} | sessionEnd=${waitState.sessionEnded ? "yes" : "no"} | exit=${exitCode ?? "unknown"} (${elapsed(t0)})`);
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, BUILD_WAIT_POLL_MS));
      }
    }

    // Grab tail of stdout/stderr no matter what happened.
    try {
      const tail = await sh(sandbox, `tail -30 ${logFile} 2>/dev/null`);
      const errTail = await sh(sandbox, `tail -10 ${errFile} 2>/dev/null`);
      if (tail) console.log(`  [${scenario.slug}] Build stdout (last 30 lines):\n${tail}`);
      if (errTail) console.log(`  [${scenario.slug}] Build stderr (last 10 lines):\n${errTail}`);
    } catch {}
    timing.buildEndMs = captureRelativeMs(t0);
    if (buildExit === 0) {
      console.log(`  [${scenario.slug}] Build completed (${elapsed(t0)})`);
    }

    // Extract artifacts after build
    const claimedSkills = (await sh(sandbox, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
    const projectFilesList = (await sh(sandbox, `find ${projectDir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.claude/*' -type f 2>/dev/null | head -40`)).split("\n").filter(Boolean);
    console.log(`  [${scenario.slug}] Build done (exit=${buildExit}) | skills=${claimedSkills.length} | files=${projectFilesList.length} (${elapsed(t0)})`);

    // Score build completeness with haiku
    let buildScore: HaikuScore | null = null;
    if (projectFilesList.length > 0) {
      const fileList = projectFilesList.map(f => f.replace(`${SANDBOX_HOME}/${scenario.slug}/`, "")).join("\n");
      buildScore = await scoreWithHaiku(sandbox, claudeBin,
        `A Next.js app was built with this prompt:\n"${scenario.prompt.slice(0, 500)}"\n\nThe following files were created:\n${fileList}\n\nPort 3000 status: ${await sh(sandbox, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null || echo down")}\n\nScore the build completeness.`,
        BUILD_SCORE_SCHEMA, "build", scenario.slug, t0,
      );
      if (buildScore) {
        console.log(`  [${scenario.slug}] Build score: ${(buildScore as any).completeness} | API=${(buildScore as any).hasApiRoutes} UI=${(buildScore as any).hasUIComponents} AI=${(buildScore as any).hasAIFeature} (${elapsed(t0)})`);
      }
    }

    // 6. Start dev server (if not already running from the build prompt)
    let port3000Up = false;
    const portCheck = await sh(sandbox, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null");
    if (portCheck === "200" || portCheck === "307") {
      port3000Up = true;
      console.log(`  [${scenario.slug}] Dev server already running (${elapsed(t0)})`);
    } else {
      const hasNext = await sh(sandbox, `test -f ${projectDir}/node_modules/.bin/next && echo YES || echo NO`);
      if (hasNext === "YES") {
        console.log(`  [${scenario.slug}] Starting dev server... (${elapsed(t0)})`);
        await sh(sandbox, `cd ${projectDir} && nohup npx next dev --port 3000 --turbopack > /tmp/next-dev.log 2>&1 & echo started`);
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const status = await sh(sandbox, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null");
          if (status === "200" || status === "307") {
            port3000Up = true;
            try { appUrl = sandbox.domain(3000); } catch {}
            console.log(`  [${scenario.slug}] Dev server UP: ${appUrl} (${elapsed(t0)})`);
            break;
          }
        }
      }
    }

    // 7. Extend timeout for verification + keep-alive
    try {
      await sandbox.extendTimeout(KEEP_ALIVE ? KEEP_ALIVE_HOURS * 3600_000 : 600_000);
      console.log(`  [${scenario.slug}] Timeout extended (${elapsed(t0)})`);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] extendTimeout: ${e.message?.slice(0, 60)}`);
    }

    // 8. Phase 2: Verification with agent-browser
    let verification: VerificationResult | undefined;
    if (!SKIP_VERIFY && projectFilesList.length > 1) {
      console.log(`  [${scenario.slug}] Phase 2: VERIFY with agent-browser (${elapsed(t0)})`);
      timing.verifyStartMs = captureRelativeMs(t0);
      const verifyPrompt = buildVerificationPrompt(scenario.userStories);
      await sandbox.writeFiles([{ path: "/tmp/verify.txt", content: Buffer.from(verifyPrompt) }]);

      const verifyCmd = `cd ${projectDir} && ${claudeBin} --dangerously-skip-permissions --debug --settings ${settingsPath} "$(cat /tmp/verify.txt)"`;
      let verifyExit = -1;
      let verifyOut = "";
      try {
        const vr = await sandbox.runCommand("sh", ["-c", verifyCmd], { signal: AbortSignal.timeout(1_200_000) }); // 20 min
        verifyExit = (vr as any).exitCode ?? 0;
        verifyOut = (await vr.stdout()).trim();
      } catch (e: any) {
        if (e.message?.includes("timed out")) {
          verifyExit = 124;
          console.log(`  [${scenario.slug}] Verify timed out (${elapsed(t0)})`);
        }
      } finally {
        timing.verifyEndMs = captureRelativeMs(t0);
      }

      // Re-extract skills after verify phase (agent-browser + fixes trigger more)
      const postVerifySkills = (await sh(sandbox, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
      if (postVerifySkills.length > claimedSkills.length) {
        const newSkills = postVerifySkills.filter(s => !claimedSkills.includes(s));
        if (newSkills.length > 0) {
          console.log(`  [${scenario.slug}] +${newSkills.length} skills from verify: ${newSkills.join(", ")}`);
          claimedSkills.push(...newSkills);
        }
      }

      // Score verification results with haiku structured output
      const storyList = scenario.userStories.map((s, i) => `${i + 1}. ${s}`).join("\n");
      const verifyScore = await scoreWithHaiku(sandbox, claudeBin,
        `You are scoring whether user stories were verified in a web app test session.\n\nThe user stories were:\n${storyList}\n\nThe verification session output (last 2000 chars):\n${verifyOut.slice(-2000)}\n\nFor each story, determine if it PASSED or FAILED based on evidence in the output. If the output mentions screenshots, successful interactions, or confirmations — mark as pass. If there are errors, missing elements, or the story was never tested — mark as fail. Give a brief reason for each.`,
        STORIES_SCHEMA, "verify", scenario.slug, t0,
      );

      let stories: VerificationResult["stories"] = scenario.userStories.map((_, i) => ({
        index: i + 1, status: "unknown" as const,
      }));
      if (verifyScore && Array.isArray((verifyScore as any).stories)) {
        stories = (verifyScore as any).stories.map((s: any) => ({
          index: s.index,
          status: s.status === "pass" ? "pass" as const : "fail" as const,
        }));
      }

      verification = { ran: true, exitCode: verifyExit, stories, output: verifyOut.slice(-500) };
      const passCount = stories.filter(s => s.status === "pass").length;
      console.log(`  [${scenario.slug}] Verify: ${passCount}/${stories.length} passed (exit=${verifyExit}) (${elapsed(t0)})`)
    } else if (SKIP_VERIFY) {
      console.log(`  [${scenario.slug}] Verification skipped (--skip-verify)`);
    } else {
      console.log(`  [${scenario.slug}] Verification skipped (only ${projectFilesList.length} files built)`);
    }

    // 9. Phase 3: Deploy to Vercel for permanent URL
    //    Uses Claude Code for skill tracking during deploy + build error fixes.
    //    Deployment protection is on by default for vercel-labs team.
    let deployUrl: string | undefined;
    let deployScore: HaikuScore | null = null;
    if (!SKIP_DEPLOY && vercelToken && projectFilesList.length > 3) {
      console.log(`  [${scenario.slug}] Phase 3: DEPLOY (${elapsed(t0)})`);
      timing.deployStartMs = captureRelativeMs(t0);
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
      const projectName = `${scenario.slug}-${ts}`.toLowerCase();

      const deployPrompt = `Deploy this app to Vercel. Follow these steps:

1. Run: vercel link --yes --scope vercel-labs --project ${projectName}
2. Run: vercel deploy --yes
3. If the deploy fails with a build error, fix the code and try again (up to 3 attempts).

Important:
- Do NOT set or use VERCEL_TOKEN env var — the CLI auth is already configured
- If you see tsconfig or type errors, fix them before retrying
- Deployment protection is enabled by default, which is what we want`;

      await sandbox.writeFiles([{ path: "/tmp/deploy.txt", content: Buffer.from(deployPrompt) }]);
      const deployCmd = `cd ${projectDir} && unset VERCEL_TOKEN && ${claudeBin} --dangerously-skip-permissions --debug --settings ${settingsPath} "$(cat /tmp/deploy.txt)"`;

      let deployExit = -1;
      let deployOut = "";
      try {
        const dr = await sandbox.runCommand("sh", ["-c", deployCmd], { signal: AbortSignal.timeout(TIMEOUT_MS) });
        deployExit = (dr as any).exitCode ?? 0;
        deployOut = (await dr.stdout()).trim();
      } catch (e: any) {
        if (e.message?.includes("timed out")) {
          deployExit = 124;
          console.log(`  [${scenario.slug}] Deploy timed out (${elapsed(t0)})`);
        }
      } finally {
        timing.deployEndMs = captureRelativeMs(t0);
      }

      // Extract deploy URL from output (scan for any vercel.app URL)
      const urlMatch = deployOut.match(/(https:\/\/[^\s]+\.vercel\.app)/);
      if (urlMatch) {
        deployUrl = urlMatch[1];
        console.log(`  [${scenario.slug}] Deployed: ${deployUrl} (${elapsed(t0)})`);
      }

      // Re-extract skills after deploy phase
      const postDeploySkills = (await sh(sandbox, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
      if (postDeploySkills.length > claimedSkills.length) {
        const newSkills = postDeploySkills.filter(s => !claimedSkills.includes(s));
        if (newSkills.length > 0) {
          console.log(`  [${scenario.slug}] +${newSkills.length} skills from deploy: ${newSkills.join(", ")}`);
          claimedSkills.push(...newSkills);
        }
      }

      // Score deploy results with haiku
      deployScore = await scoreWithHaiku(sandbox, claudeBin,
        `A Vercel deploy was attempted. Here's the output (last 1500 chars):\n\n${deployOut.slice(-1500)}\n\nDid the deploy succeed? Extract the URL if present. List any errors.`,
        DEPLOY_SCORE_SCHEMA, "deploy", scenario.slug, t0,
      );
      if (deployScore) {
        const ds = deployScore as any;
        console.log(`  [${scenario.slug}] Deploy score: deployed=${ds.deployed} build=${ds.buildSucceeded}${ds.url ? ` url=${ds.url}` : ""} (${elapsed(t0)})`);
        // If haiku found a URL we missed, use it
        if (!deployUrl && ds.url && ds.url.includes("vercel.app")) {
          deployUrl = ds.url;
          console.log(`  [${scenario.slug}] Deploy URL from haiku: ${deployUrl}`);
        }
      }

      if (!deployUrl) {
        console.log(`  [${scenario.slug}] Deploy failed (exit=${deployExit}) (${elapsed(t0)})`);
      }
    }

    // 10. Extract source code + debug logs to local filesystem
    let sourcePath: string | undefined;
    const archiveDir = join(RESULTS_DIR, runId, scenario.slug);
    await mkdir(archiveDir, { recursive: true });
    const extractStartedAt = performance.now();

    const extractedArtifacts: ArtifactManifestEntry[] = [];
    const trackArtifact = async (
      fileName: string,
      description: string,
      content: Buffer | string,
    ): Promise<ArtifactManifestEntry> => {
      const artifact = await writeArchiveArtifact(archiveDir, fileName, description, content);
      extractedArtifacts.push(artifact);
      console.log(`  [${scenario.slug}] Artifact saved | file=${fileName} | sizeKB=${(artifact.sizeBytes / 1024).toFixed(0)} (${elapsed(t0)})`);
      return artifact;
    };

    // Always extract debug logs (even if build produced few files)
    try {
      await sh(sandbox, `tar czf /tmp/debug-logs.tar.gz -C ${SANDBOX_HOME} .claude/debug/ 2>/dev/null`);
      const debugBuffer = await readSandboxFileBuffer(sandbox, "/tmp/debug-logs.tar.gz");
      if (!debugBuffer) throw new Error("sandbox file /tmp/debug-logs.tar.gz missing");
      await trackArtifact("debug-logs.tar.gz", "Full Claude debug logs captured from ~/.claude/debug.", debugBuffer);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=debug-logs.tar.gz | attempted=tar-debug-logs | error=${e.message?.slice(0, 160)}`);
    }

    // Extract Claude Code stdout/stderr from all build rounds
    try {
      await sh(sandbox, "tar czf /tmp/claude-output.tar.gz /tmp/claude-build-round-*.log /tmp/claude-build-round-*.err 2>/dev/null");
      const claudeOutputBuffer = await readSandboxFileBuffer(sandbox, "/tmp/claude-output.tar.gz");
      if (!claudeOutputBuffer) throw new Error("sandbox file /tmp/claude-output.tar.gz missing");
      await trackArtifact("claude-output.tar.gz", "Claude build stdout/stderr logs captured from /tmp.", claudeOutputBuffer);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=claude-output.tar.gz | attempted=tar-claude-output | error=${e.message?.slice(0, 160)}`);
    }

    try {
      await sh(sandbox, `cd ${SANDBOX_HOME} && tar czf /tmp/source.tar.gz --exclude='node_modules' --exclude='.next' --exclude='.git' ${scenario.slug}/ 2>/dev/null`);
      const sourceBuffer = await readSandboxFileBuffer(sandbox, "/tmp/source.tar.gz");
      if (!sourceBuffer) throw new Error("sandbox file /tmp/source.tar.gz missing");
      const artifact = await trackArtifact("source.tar.gz", "Generated project source tree excluding node_modules, .next, and .git.", sourceBuffer);
      sourcePath = join(archiveDir, artifact.fileName);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=source.tar.gz | attempted=tar-project-source | error=${e.message?.slice(0, 160)}`);
    }

    try {
      const hookTrace = await sh(
        sandbox,
        "grep -RniE 'vercel-plugin|VERCEL_PLUGIN|PreToolUse|PostToolUse|SessionStart|SessionEnd|UserPromptSubmit' ~/.claude/debug 2>/dev/null || true",
      );
      const hookTraceOutput = normalizeShellOutput(hookTrace) || "No hook/session trace lines matched.";
      await trackArtifact("hook-trace.txt", "Filtered hook and session trace lines from Claude debug logs.", `${hookTraceOutput}\n`);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=hook-trace.txt | attempted=grep-hook-trace | error=${e.message?.slice(0, 160)}`);
    }

    try {
      const fileTree = await sh(
        sandbox,
        `find ${projectDir} -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*' -type f -exec ls -la {} + 2>/dev/null || true`,
      );
      const fileTreeOutput = normalizeShellOutput(fileTree) || "No project files found.";
      await trackArtifact("file-tree.txt", "Readable file tree for the generated project.", `${fileTreeOutput}\n`);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=file-tree.txt | attempted=find-project-files | error=${e.message?.slice(0, 160)}`);
    }

    try {
      const pluginEnv = await sh(sandbox, "env | grep -i vercel_plugin || true");
      const pluginEnvOutput = normalizeShellOutput(pluginEnv) || "No VERCEL_PLUGIN environment variables found.";
      await trackArtifact("plugin-env.txt", "Sandbox environment variables matching VERCEL_PLUGIN.", `${pluginEnvOutput}\n`);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=plugin-env.txt | attempted=grep-plugin-env | error=${e.message?.slice(0, 160)}`);
    }

    try {
      const npmGlobals = await sh(sandbox, "npm ls -g --depth=0 2>/dev/null || true");
      const npmGlobalsOutput = normalizeShellOutput(npmGlobals) || "npm global package listing returned no output.";
      await trackArtifact("npm-globals.txt", "Globally installed npm packages inside the sandbox.", `${npmGlobalsOutput}\n`);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=npm-globals.txt | attempted=npm-ls-global | error=${e.message?.slice(0, 160)}`);
    }

    try {
      const settingsExists = await sh(sandbox, `test -f ${settingsPath} && echo present || true`);
      if (normalizeShellOutput(settingsExists) === "present") {
        const settingsBuffer = await readSandboxFileBuffer(sandbox, settingsPath);
        if (!settingsBuffer) throw new Error(`sandbox file ${settingsPath} missing`);
        await trackArtifact("settings.json", "Claude settings generated for the scenario project.", settingsBuffer);
      }
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=settings.json | attempted=copy-settings | error=${e.message?.slice(0, 160)}`);
    }

    try {
      const toolCallsRaw = await sh(sandbox, "grep -Rni 'executePreToolHooks called' ~/.claude/debug 2>/dev/null || true");
      await trackArtifact("tool-calls.txt", "Pre-tool hook calls with parsed timestamp and tool name.", `${summarizeToolCalls(toolCallsRaw)}\n`);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=tool-calls.txt | attempted=grep-pretool-hooks | error=${e.message?.slice(0, 160)}`);
    }

    try {
      const claimDirs = await sh(sandbox, "ls -la /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null || true");
      const claimFiles = await sh(sandbox, "cat /tmp/vercel-plugin-*-seen-skills.txt 2>/dev/null || true");
      const claimsOutput = [
        "=== claim directories ===",
        normalizeShellOutput(claimDirs) || "(none)",
        "",
        "=== claim files ===",
        normalizeShellOutput(claimFiles) || "(none)",
      ].join("\n");
      await trackArtifact("skill-claims.txt", "Seen-skills claim directories and files emitted by the plugin.", `${claimsOutput}\n`);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=skill-claims.txt | attempted=collect-skill-claims | error=${e.message?.slice(0, 160)}`);
    }

    try {
      const manifestPath = join(archiveDir, "manifest.json");
      const manifestEntry: ArtifactManifestEntry = {
        fileName: "manifest.json",
        sizeBytes: 0,
        description: "Manifest of archived observability artifacts.",
      };
      const manifestEntries = [...extractedArtifacts, manifestEntry];
      for (let attempt = 0; attempt < 3; attempt++) {
        await writeFile(manifestPath, JSON.stringify(buildArtifactManifest(manifestEntries), null, 2));
        const manifestStats = await stat(manifestPath);
        if (manifestEntry.sizeBytes === manifestStats.size) break;
        manifestEntry.sizeBytes = manifestStats.size;
      }
      if (!extractedArtifacts.some((artifact) => artifact.fileName === "manifest.json")) {
        extractedArtifacts.push(manifestEntry);
      }
      console.log(`  [${scenario.slug}] Artifact saved | file=manifest.json | sizeKB=${(manifestEntry.sizeBytes / 1024).toFixed(0)} (${elapsed(t0)})`);
    } catch (e: any) {
      console.log(`  [${scenario.slug}] Artifact extract failed | artifact=manifest.json | attempted=write-manifest | error=${e.message?.slice(0, 160)}`);
    }

    timing.extractMs = captureElapsedMs(extractStartedAt);

    console.log(`  [${scenario.slug}] DONE (${elapsed(t0)}) | skills=${claimedSkills.length} | files=${projectFilesList.length}${deployUrl ? ` | ${deployUrl}` : appUrl ? ` | ${appUrl}` : ""}`);

    return {
      slug: scenario.slug,
      sandboxId: sandbox.sandboxId,
      success: buildExit === 0 || buildExit === 124,
      durationMs: performance.now() - t0,
      claimedSkills,
      expectedSkills: scenario.expectedSkills,
      projectFiles: projectFilesList,
      appUrl,
      deployUrl,
      sourcePath,
      pollHistory,
      verification,
      buildScore,
      deployScore,
      timing,
    };
  } catch (err: any) {
    console.error(`  [${scenario.slug}] ERROR: ${err.message?.slice(0, 200)}`);
    return {
      slug: scenario.slug,
      sandboxId: sandbox?.sandboxId ?? "unknown",
      success: false,
      durationMs: performance.now() - t0,
      claimedSkills: [],
      expectedSkills: scenario.expectedSkills,
      projectFiles: [],
      error: err.message?.slice(0, 400),
      pollHistory,
      timing,
    };
  } finally {
    if (sandbox && !KEEP_ALIVE) {
      try { await sandbox.stop(); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

async function generateReport(
  runId: string,
  results: ScenarioResult[],
  totalMs: number,
  resultsPath: string,
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportsDir = join(LOCAL_PLUGIN_DIR, ".reports");
  await mkdir(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${ts}.md`);

  const scenarioMap = Object.fromEntries(ACTIVE_SCENARIOS.map(s => [s.slug, s]));
  const totalSkills = new Set(results.flatMap(r => r.claimedSkills));
  const verified = results.filter(r => r.verification?.ran);
  const totalStories = verified.reduce((a, r) => a + r.verification!.stories.length, 0);
  const passedStories = verified.reduce((a, r) => a + r.verification!.stories.filter(s => s.status === "pass").length, 0);

  let md = `# Sandbox Eval Report — ${ts}\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Run ID | \`${runId}\` |\n`;
  md += `| Date | ${new Date().toISOString()} |\n`;
  md += `| Duration | ${(totalMs / 1000).toFixed(0)}s |\n`;
  md += `| Scenarios | ${results.length} |\n`;
  md += `| Builds succeeded | ${results.filter(r => r.success).length}/${results.length} |\n`;
  md += `| Unique skills injected | ${totalSkills.size} |\n`;
  md += `| User stories verified | ${passedStories}/${totalStories} |\n`;
  md += `| Results JSON | \`${resultsPath}/results.json\` |\n\n`;

  // Summary table
  md += `## Summary\n\n`;
  md += `| Scenario | Build | Skills | Files | Verify | Duration | Deploy URL |\n`;
  md += `|----------|-------|--------|-------|--------|----------|------------|\n`;
  for (const r of results) {
    const build = r.success ? "OK" : "FAIL";
    const verify = r.verification
      ? `${r.verification.stories.filter(s => s.status === "pass").length}/${r.verification.stories.length}`
      : "skip";
    const url = r.deployUrl ? `[${r.slug}](${r.deployUrl})` : r.appUrl ? `[sandbox](${r.appUrl})` : "—";
    md += `| ${r.slug} | ${build} | ${r.claimedSkills.length} | ${r.projectFiles.length} | ${verify} | ${(r.durationMs / 1000).toFixed(0)}s | ${url} |\n`;
  }

  md += `\n${renderTimingMarkdownTable(results)}\n`;

  // Deployed + Live URLs
  const deployed = results.filter(r => r.deployUrl);
  const liveApps = results.filter(r => r.appUrl);
  if (deployed.length > 0) {
    md += `\n## Deployed URLs (permanent)\n\n`;
    for (const r of deployed) md += `- **${r.slug}**: ${r.deployUrl}\n`;
  }
  if (liveApps.length > 0) {
    md += `\n## Sandbox URLs (temporary)\n\n`;
    for (const r of liveApps) md += `- **${r.slug}**: ${r.appUrl}\n`;
  }

  // Per-scenario details
  md += `\n## Scenario Details\n`;
  for (const r of results) {
    const scenario = scenarioMap[r.slug];
    md += `\n### ${r.slug}\n\n`;
    md += `**Sandbox ID**: \`${r.sandboxId}\`\n`;
    if (r.deployUrl) md += `**Deploy URL**: ${r.deployUrl}\n`;
    if (r.appUrl) md += `**Sandbox URL**: ${r.appUrl}\n`;
    md += `**Duration**: ${(r.durationMs / 1000).toFixed(0)}s\n`;
    md += `**Build**: ${r.success ? "OK" : "FAIL"}`;
    if (r.error) md += ` — \`${r.error.slice(0, 100)}\``;
    md += `\n`;
    if (r.sourcePath) {
      md += `**Source archive**: \`${r.sourcePath}\`\n`;
      md += `\nExtract source locally:\n`;
      md += `\`\`\`bash\nmkdir -p /tmp/${r.slug} && tar xzf "${r.sourcePath}" -C /tmp/${r.slug}\ncd /tmp/${r.slug}/${r.slug} && npm install && npx next dev\n\`\`\`\n`;
    }
    md += `\n`;

    // Prompt
    if (scenario) {
      md += `<details><summary>Build Prompt</summary>\n\n${scenario.prompt}\n\n</details>\n\n`;
    }

    // Skills
    md += `**Skills injected (${r.claimedSkills.length})**:`;
    if (r.claimedSkills.length > 0) {
      md += ` ${r.claimedSkills.join(", ")}\n`;
    } else {
      md += ` (none)\n`;
    }

    // Expected vs actual
    if (scenario) {
      const expected = new Set(scenario.expectedSkills);
      const actual = new Set(r.claimedSkills);
      const hit = [...expected].filter(s => actual.has(s));
      const miss = [...expected].filter(s => !actual.has(s));
      const extra = [...actual].filter(s => !expected.has(s));
      md += `**Expected**: ${scenario.expectedSkills.join(", ")}\n`;
      md += `**Match**: ${hit.length}/${expected.size}`;
      if (miss.length) md += ` | Missing: ${miss.join(", ")}`;
      if (extra.length) md += ` | Bonus: ${extra.join(", ")}`;
      md += `\n`;
    }

    // Project files
    if (r.projectFiles.length > 0) {
      md += `\n**Project files (${r.projectFiles.length})**:\n`;
      md += `\`\`\`\n${r.projectFiles.map(f => f.split("/").slice(-2).join("/")).join("\n")}\n\`\`\`\n`;
    }

    // Skill injection timeline (from polls)
    if (r.pollHistory.length > 0) {
      md += `\n**Skill injection timeline**:\n`;
      let prevSkills = new Set<string>();
      for (const p of r.pollHistory) {
        const curr = new Set(p.skills);
        const newSkills = [...curr].filter(s => !prevSkills.has(s));
        if (newSkills.length > 0) {
          md += `- ${p.elapsed}: +${newSkills.join(", ")} (total: ${curr.size}, files: ${p.files})\n`;
        }
        prevSkills = curr;
      }
    }

    // Build score (from haiku)
    if (r.buildScore) {
      const bs = r.buildScore as any;
      md += `\n**Build Score** (haiku): ${bs.completeness} | API=${bs.hasApiRoutes} UI=${bs.hasUIComponents} AI=${bs.hasAIFeature} Server=${bs.devServerRunning}\n`;
      if (bs.missingFeatures?.length) md += `Missing: ${bs.missingFeatures.join(", ")}\n`;
      if (bs.summary) md += `> ${bs.summary}\n`;
    }

    // Deploy score (from haiku)
    if (r.deployScore) {
      const ds = r.deployScore as any;
      md += `\n**Deploy Score** (haiku): deployed=${ds.deployed} build=${ds.buildSucceeded}${ds.url ? ` url=${ds.url}` : ""}\n`;
      if (ds.errors?.length) md += `Errors: ${ds.errors.join(", ")}\n`;
      if (ds.summary) md += `> ${ds.summary}\n`;
    }

    // Verification
    if (r.verification?.ran) {
      md += `\n**Verification** (exit=${r.verification.exitCode}):\n`;
      for (let i = 0; i < r.verification.stories.length; i++) {
        const s = r.verification.stories[i];
        const story = scenario?.userStories[i] ?? `Story ${s.index}`;
        const icon = s.status === "pass" ? "PASS" : s.status === "fail" ? "FAIL" : "???";
        md += `- **${icon}**: ${story}\n`;
      }
      if (r.verification.output) {
        md += `\n<details><summary>Verification output (last 500 chars)</summary>\n\n\`\`\`\n${r.verification.output}\n\`\`\`\n\n</details>\n`;
      }
    }
  }

  // Aggregate skill coverage
  md += `\n## Aggregate Skill Coverage\n\n`;
  md += `**${totalSkills.size} unique skills** injected across ${results.length} scenarios:\n`;
  md += [...totalSkills].sort().map(s => `\`${s}\``).join(", ") + "\n";

  await writeFile(reportPath, md);
  // Also write to results dir for easy access alongside results.json
  await writeFile(join(resultsPath, "report.md"), md);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Report copy: ${join(resultsPath, "report.md")}`);
  return reportPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = performance.now();
  runId = `eval-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const resultsPath = join(RESULTS_DIR, runId);
  await mkdir(resultsPath, { recursive: true });

  const filtered = SCENARIO_FILTER.length > 0
    ? ACTIVE_SCENARIOS.filter(s => SCENARIO_FILTER.includes(s.slug))
    : ACTIVE_SCENARIOS;

  console.log("=== Sandbox Eval Runner: Build → Verify → Deploy ===");
  console.log(`Scenarios: ${filtered.length}${SCENARIO_FILTER.length ? ` (filtered: ${SCENARIO_FILTER.join(", ")})` : ""}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Timeout: ${TIMEOUT_MS / 1000}s per phase`);
  console.log(`Phases: Build${SKIP_VERIFY ? "" : " → Verify"}${SKIP_DEPLOY ? "" : " → Deploy"}`);
  console.log(`Keep-alive: ${KEEP_ALIVE ? `${KEEP_ALIVE_HOURS}h` : "OFF"}`);
  console.log(`Results: ${resultsPath}\n`);

  const apiKey = resolveApiKey();
  const baseUrl = "https://ai-gateway.vercel.sh";
  const vercelToken = resolveVercelToken();

  console.log("Collecting plugin files...");
  const pluginFiles = await collectPluginFiles();
  console.log(`  ${pluginFiles.length} files (${(pluginFiles.reduce((a, f) => a + f.content.length, 0) / 1024).toFixed(0)}KB)\n`);

  const queue = [...filtered];
  const results: ScenarioResult[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const scenario = queue.shift()!;
      console.log(`\n--- ${scenario.slug} ---`);
      const result = await runScenario(scenario, apiKey, baseUrl, vercelToken, pluginFiles);
      results.push(result);

      // Write individual result immediately so it survives crashes
      try {
        const scenarioDir = join(resultsPath, result.slug);
        await mkdir(scenarioDir, { recursive: true });
        await writeFile(join(scenarioDir, "result.json"), JSON.stringify(result, null, 2));
        // Also update the aggregate results.json with everything so far
        await writeFile(join(resultsPath, "results.json"), JSON.stringify({ runId, results, totalMs: performance.now() - t0, complete: false }, null, 2));
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, filtered.length) }, () => worker()));

  // Save final results (marks complete: true)
  const totalMs = performance.now() - t0;
  await writeFile(join(resultsPath, "results.json"), JSON.stringify({ runId, results, totalMs, complete: true }, null, 2));

  // Generate markdown report
  await generateReport(runId, results, totalMs, resultsPath);

  // Print summary
  console.log("\n\n=== SUMMARY ===");
  console.log(`${"Slug".padEnd(22)} ${"Build".padEnd(6)} ${"Skills".padEnd(6)} ${"Files".padEnd(6)} ${"Verify".padEnd(10)} Duration`);
  console.log("-".repeat(80));
  for (const r of results) {
    const build = r.success ? "OK" : "FAIL";
    const verify = r.verification
      ? `${r.verification.stories.filter(s => s.status === "pass").length}/${r.verification.stories.length}`
      : "skip";
    console.log(`${r.slug.padEnd(22)} ${build.padEnd(6)} ${String(r.claimedSkills.length).padEnd(6)} ${String(r.projectFiles.length).padEnd(6)} ${verify.padEnd(10)} ${(r.durationMs / 1000).toFixed(0)}s`);
  }

  // Verification details
  const verified = results.filter(r => r.verification?.ran);
  if (verified.length > 0) {
    console.log("\n=== VERIFICATION DETAILS ===");
    for (const r of verified) {
      console.log(`\n  ${r.slug}:`);
      for (const s of r.verification!.stories) {
        const icon = s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : "?";
        console.log(`    ${icon} Story ${s.index}: ${s.status.toUpperCase()}`);
      }
    }
    const totalStories = verified.reduce((a, r) => a + r.verification!.stories.length, 0);
    const passedStories = verified.reduce((a, r) => a + r.verification!.stories.filter(s => s.status === "pass").length, 0);
    console.log(`\n  Total: ${passedStories}/${totalStories} stories passed`);
  }

  // App URLs
  const appsWithUrls = results.filter(r => r.appUrl);
  if (appsWithUrls.length > 0) {
    console.log("\n=== APP URLs ===");
    for (const r of appsWithUrls) console.log(`  ${r.slug}: ${r.appUrl}`);
  }

  // Skill coverage
  console.log("\n=== SKILL COVERAGE ===");
  for (const r of results) {
    const expected = new Set(r.expectedSkills);
    const actual = new Set(r.claimedSkills);
    const hit = [...expected].filter(s => actual.has(s));
    const miss = [...expected].filter(s => !actual.has(s));
    const extra = [...actual].filter(s => !expected.has(s));
    console.log(`  ${r.slug}: ${hit.length}/${expected.size} expected | +${extra.length} bonus | -${miss.length} missing`);
    if (miss.length) console.log(`    missing: ${miss.join(", ")}`);
  }

  if (!KEEP_ALIVE) {
    const allPassed = results.every(r => r.success);
    process.exit(allPassed ? 0 : 1);
  }

  // Keep-alive mode
  if (appsWithUrls.length > 0) {
    console.log(`\n=== SANDBOXES KEPT ALIVE (${KEEP_ALIVE_HOURS}h) ===`);
    for (const r of appsWithUrls) console.log(`  ${r.slug}: ${r.appUrl}`);
    await writeFile(join(resultsPath, "live-urls.json"), JSON.stringify(
      Object.fromEntries(appsWithUrls.map(r => [r.slug, { url: r.appUrl, sandboxId: r.sandboxId }])),
      null, 2,
    ));
    console.log(`\nPress Ctrl+C to stop all sandboxes.\n`);
    await new Promise(() => {});
  }
}

if (import.meta.main) {
  main().catch(e => { console.error("Fatal:", e); process.exit(2); });
}
