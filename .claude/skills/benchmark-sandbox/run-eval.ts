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
// Per-scenario runner
// ---------------------------------------------------------------------------

interface VerificationResult {
  ran: boolean;
  exitCode: number;
  stories: Array<{ index: number; status: "pass" | "fail" | "unknown" }>;
  output: string;
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
  let sandbox: InstanceType<typeof Sandbox> | undefined;

  try {
    // 1. Create sandbox with port 3000
    console.log(`  [${scenario.slug}] Creating sandbox...`);
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
    let appUrl: string | undefined;
    try { appUrl = sandbox.domain(3000); } catch {}
    console.log(`  [${scenario.slug}] Sandbox ${sandbox.sandboxId}${appUrl ? ` | ${appUrl}` : ""} (${elapsed(t0)})`);

    // 2. Install Claude Code + Vercel CLI + agent-browser
    await sandbox.runCommand("sh", ["-c", "npm install -g @anthropic-ai/claude-code vercel agent-browser"]);
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
    await sandbox.runCommand("sh", ["-c", `mkdir -p ${projectDir} && cd ${projectDir} && npm init -y`]);
    await sandbox.writeFiles(pluginFiles);
    await sh(sandbox, `cd ${projectDir} && npx -y add-plugin ${SANDBOX_PLUGIN_DIR} -s project -y --target claude-code 2>&1 | tail -1`);
    console.log(`  [${scenario.slug}] Plugin installed (${elapsed(t0)})`);

    // 5. Phase 1: Build the app
    await sandbox.writeFiles([{ path: "/tmp/prompt.txt", content: Buffer.from(scenario.prompt) }]);
    const settingsPath = `${projectDir}/.claude/settings.json`;
    const buildCmd = `cd ${projectDir} && ${claudeBin} --dangerously-skip-permissions --debug --settings ${settingsPath} "$(cat /tmp/prompt.txt)"`;

    console.log(`  [${scenario.slug}] Phase 1: BUILD started (${elapsed(t0)})`);
    const buildPromise = sandbox.runCommand("sh", ["-c", buildCmd], { signal: AbortSignal.timeout(TIMEOUT_MS) });

    // Poll during build
    const pollInterval = setInterval(async () => {
      try {
        const skills = (await sh(sandbox!, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
        const fileCount = parseInt(await sh(sandbox!, `find ${projectDir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.claude/*' -newer /tmp/prompt.txt -type f 2>/dev/null | wc -l`), 10) || 0;
        const port3000 = await sh(sandbox!, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null || echo 'down'");
        if (!appUrl && port3000 !== "000down" && port3000 !== "down") {
          try { appUrl = sandbox!.domain(3000); } catch {}
        }
        pollHistory.push({ elapsed: elapsed(t0), skills, files: fileCount });
        console.log(`  [${scenario.slug}] ${elapsed(t0)} | skills: ${skills.join(", ") || "(none)"} | files: ${fileCount} | :3000=${port3000}`);
      } catch {}
    }, 20_000);

    let buildExit = -1;
    try {
      const r = await buildPromise;
      clearInterval(pollInterval);
      buildExit = (r as any).exitCode ?? 0;
    } catch (e: any) {
      clearInterval(pollInterval);
      if (e.message?.includes("timed out") || e.message?.includes("abort")) {
        console.log(`  [${scenario.slug}] Build timed out (${elapsed(t0)})`);
        buildExit = 124;
      } else throw e;
    }

    // Extract artifacts after build
    const claimedSkills = (await sh(sandbox, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
    const projectFilesList = (await sh(sandbox, `find ${projectDir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.claude/*' -type f 2>/dev/null | head -40`)).split("\n").filter(Boolean);
    console.log(`  [${scenario.slug}] Build done (exit=${buildExit}) | skills=${claimedSkills.length} | files=${projectFilesList.length} (${elapsed(t0)})`);

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
      }

      // Parse verification results from output
      const stories: VerificationResult["stories"] = scenario.userStories.map((_, i) => {
        const idx = i + 1;
        const passMatch = verifyOut.match(new RegExp(`STORY_${idx}:\\s*(PASS|FAIL)`, "i"));
        return {
          index: idx,
          status: passMatch ? (passMatch[1].toLowerCase() as "pass" | "fail") : "unknown",
        };
      });

      verification = { ran: true, exitCode: verifyExit, stories, output: verifyOut.slice(-500) };
      const passCount = stories.filter(s => s.status === "pass").length;
      console.log(`  [${scenario.slug}] Verify: ${passCount}/${stories.length} passed (exit=${verifyExit}) (${elapsed(t0)})`);

      // Re-extract skills after verify phase (agent-browser + fixes trigger more)
      const postVerifySkills = (await sh(sandbox, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
      if (postVerifySkills.length > claimedSkills.length) {
        const newSkills = postVerifySkills.filter(s => !claimedSkills.includes(s));
        if (newSkills.length > 0) {
          console.log(`  [${scenario.slug}] +${newSkills.length} skills from verify: ${newSkills.join(", ")}`);
          claimedSkills.push(...newSkills);
        }
      }
    } else if (SKIP_VERIFY) {
      console.log(`  [${scenario.slug}] Verification skipped (--skip-verify)`);
    } else {
      console.log(`  [${scenario.slug}] Verification skipped (only ${projectFilesList.length} files built)`);
    }

    // 9. Phase 3: Deploy to Vercel for permanent URL
    //    Uses Claude Code to link, fix build errors, and deploy.
    //    Deployment protection is on by default for vercel-labs team.
    let deployUrl: string | undefined;
    if (!SKIP_DEPLOY && vercelToken && projectFilesList.length > 3) {
      console.log(`  [${scenario.slug}] Phase 3: DEPLOY (${elapsed(t0)})`);
      const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
      const projectName = `${scenario.slug}-${ts}`.toLowerCase();

      const deployPrompt = `The app in this directory needs to be deployed to Vercel. Follow these steps exactly:

1. Run: vercel link --yes --scope vercel-labs --project ${projectName}
2. Run: vercel deploy --yes
3. If the deploy fails with a build error, fix the code and try again (up to 3 attempts).
4. After a successful deploy, output the deployment URL on its own line starting with DEPLOY_URL:

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
      }

      // Extract deploy URL from Claude's output
      const urlMatch = deployOut.match(/DEPLOY_URL:\s*(https:\/\/[^\s]+\.vercel\.app)/);
      if (urlMatch) {
        deployUrl = urlMatch[1];
        console.log(`  [${scenario.slug}] Deployed: ${deployUrl} (${elapsed(t0)})`);
      } else {
        // Fall back to scanning for any vercel.app URL in output
        const fallback = deployOut.match(/(https:\/\/[^\s]+\.vercel\.app)/);
        if (fallback) {
          deployUrl = fallback[1];
          console.log(`  [${scenario.slug}] Deployed (parsed): ${deployUrl} (${elapsed(t0)})`);
        } else {
          console.log(`  [${scenario.slug}] Deploy failed (exit=${deployExit}) (${elapsed(t0)})`);
        }
      }

      // Re-extract skills after deploy phase (Claude may have triggered more)
      const postDeploySkills = (await sh(sandbox, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
      if (postDeploySkills.length > claimedSkills.length) {
        const newSkills = postDeploySkills.filter(s => !claimedSkills.includes(s));
        if (newSkills.length > 0) {
          console.log(`  [${scenario.slug}] +${newSkills.length} skills from deploy: ${newSkills.join(", ")}`);
          claimedSkills.push(...newSkills);
        }
      }
    }

    // 10. Extract source code to local filesystem
    let sourcePath: string | undefined;
    if (projectFilesList.length > 3) {
      try {
        const archiveDir = join(RESULTS_DIR, runId, scenario.slug);
        await mkdir(archiveDir, { recursive: true });
        // Tar source (exclude node_modules, .next, .git)
        await sandbox.runCommand("sh", ["-c", `cd ${SANDBOX_HOME} && tar czf /tmp/source.tar.gz --exclude='node_modules' --exclude='.next' --exclude='.git' ${scenario.slug}/`]);
        const stream = await sandbox.readFile({ path: "/tmp/source.tar.gz" });
        if (stream) {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          const archivePath = join(archiveDir, "source.tar.gz");
          await writeFile(archivePath, Buffer.concat(chunks));
          sourcePath = archivePath;
          console.log(`  [${scenario.slug}] Source saved: ${archivePath} (${(Buffer.concat(chunks).length / 1024).toFixed(0)}KB) (${elapsed(t0)})`);
        }
      } catch (e: any) {
        console.log(`  [${scenario.slug}] Source extract failed: ${e.message?.slice(0, 80)}`);
      }
    }

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

  const scenarioMap = Object.fromEntries(SCENARIOS.map(s => [s.slug, s]));
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
  console.log(`\nReport: ${reportPath}`);
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

main().catch(e => { console.error("Fatal:", e); process.exit(2); });
