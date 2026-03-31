#!/usr/bin/env node
/**
 * PostToolUse hook: detects package installations from Bash tool output
 * and chains to the appropriate skill context.
 *
 * Input: JSON on stdin with tool_name, tool_input, session_id
 * Output: JSON on stdout with { hookSpecificOutput: { additionalContext: "..." } } or {}
 *
 * Only fires for Bash tool calls. Parses npm install/yarn add/pnpm add/bun add
 * commands, extracts package names, maps them to skills, and injects skill context.
 *
 * Respects the session-backed dedup contract (atomic claims, seen-skills file).
 */

import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPlatform, type HookPlatform } from "./compat.mjs";
import {
  pluginRoot as resolvePluginRoot,
  readSessionFile,
  tryClaimSessionKey,
  syncSessionFileFromClaims,
} from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import type { Logger } from "./logger.mjs";
import { createSkillStore, type SkillStore } from "./skill-store.mjs";

const PLUGIN_ROOT = resolvePluginRoot();
const CHAIN_BUDGET_BYTES = 18_000;
const DEFAULT_CHAIN_CAP = 2;

// ---------------------------------------------------------------------------
// Package → Skill mapping
// ---------------------------------------------------------------------------

/**
 * Maps known npm package names to skill slugs. When a user installs one of
 * these packages, we inject the corresponding skill context so the agent
 * has up-to-date guidance for the Vercel-ecosystem alternative or best practice.
 */
export const PACKAGE_SKILL_MAP: Record<string, { skill: string; message: string }> = {
  // Express / traditional Node servers → Vercel Functions
  express: {
    skill: "vercel-functions",
    message: "Express.js detected — Vercel uses Web API route handlers, not Express. Loading Vercel Functions guidance.",
  },
  fastify: {
    skill: "vercel-functions",
    message: "Fastify detected — consider Vercel Functions with Web Request/Response API for serverless deployment.",
  },
  koa: {
    skill: "vercel-functions",
    message: "Koa detected — consider Vercel Functions with Web Request/Response API for serverless deployment.",
  },

  // Queue / background job libraries → Vercel Queues
  bullmq: {
    skill: "vercel-queues",
    message: "BullMQ detected — Vercel Queues provides durable event streaming without self-managed Redis. Loading Queues guidance.",
  },
  bull: {
    skill: "vercel-queues",
    message: "Bull detected — Vercel Queues provides durable event streaming without self-managed Redis. Loading Queues guidance.",
  },

  // Database / ORM libraries → Vercel Storage
  mongoose: {
    skill: "vercel-storage",
    message: "Mongoose detected — loading Vercel Storage guidance for database options on the platform.",
  },
  prisma: {
    skill: "vercel-storage",
    message: "Prisma detected — loading Vercel Storage guidance for Neon Postgres (recommended) and other Marketplace databases.",
  },
  "@libsql/client": {
    skill: "vercel-storage",
    message: "@libsql/client detected — loading Vercel Storage guidance for Marketplace database alternatives.",
  },
  "@vercel/postgres": {
    skill: "vercel-storage",
    message: "@vercel/postgres is sunset — use @neondatabase/serverless instead. Loading Storage migration guidance.",
  },
  "@vercel/kv": {
    skill: "vercel-storage",
    message: "@vercel/kv is sunset — use @upstash/redis instead. Loading Storage migration guidance.",
  },

  // Payments → Stripe integration
  stripe: {
    skill: "payments",
    message: "Stripe detected — loading Vercel Marketplace Stripe integration guidance for checkout, webhooks, and subscriptions.",
  },

  // Direct AI provider SDKs → AI Gateway
  openai: {
    skill: "ai-gateway",
    message: "Direct OpenAI SDK detected — AI Gateway provides OIDC auth, failover, and cost tracking with no manual API keys. Loading AI Gateway guidance.",
  },
  "@anthropic-ai/sdk": {
    skill: "ai-gateway",
    message: "Direct Anthropic SDK detected — AI Gateway provides unified access to all providers. Loading AI Gateway guidance.",
  },
  "@google/generative-ai": {
    skill: "ai-gateway",
    message: "Direct Google AI SDK detected — AI Gateway provides unified access to all providers. Loading AI Gateway guidance.",
  },
  langchain: {
    skill: "ai-sdk",
    message: "LangChain detected — AI SDK v6 provides native tool calling, agents, and streaming without the LangChain abstraction layer. Loading AI SDK guidance.",
  },
  "@langchain/core": {
    skill: "ai-sdk",
    message: "LangChain Core detected — AI SDK v6 provides native tool calling, agents, and streaming without the LangChain abstraction layer. Loading AI SDK guidance.",
  },

  // Auth
  "next-auth": {
    skill: "auth",
    message: "next-auth detected — consider Clerk via Vercel Marketplace for managed auth with auto-provisioned env vars. Loading auth guidance.",
  },
  "@clerk/nextjs": {
    skill: "auth",
    message: "@clerk/nextjs detected — loading Vercel Marketplace Clerk integration guidance for middleware auth and sign-in flows.",
  },

  // CMS
  "@sanity/client": {
    skill: "cms",
    message: "@sanity/client detected — loading Vercel Marketplace Sanity integration guidance for studio, preview mode, and revalidation.",
  },
  contentful: {
    skill: "cms",
    message: "Contentful detected — loading CMS integration guidance for content modeling, preview mode, and revalidation webhooks.",
  },

  // Chat platforms → Chat SDK
  "@slack/bolt": {
    skill: "chat-sdk",
    message: "@slack/bolt detected — Chat SDK provides a unified multi-platform API (Slack, Teams, Discord, Telegram) with a single codebase. Loading Chat SDK guidance.",
  },
  "@slack/web-api": {
    skill: "chat-sdk",
    message: "@slack/web-api detected — Chat SDK provides a unified multi-platform API with cards, streaming, and state management. Loading Chat SDK guidance.",
  },
  "discord.js": {
    skill: "chat-sdk",
    message: "discord.js detected — Chat SDK provides a unified multi-platform API (Slack, Teams, Discord, Telegram) with a single codebase. Loading Chat SDK guidance.",
  },
  telegraf: {
    skill: "chat-sdk",
    message: "Telegraf detected — Chat SDK provides a unified multi-platform API (Slack, Teams, Discord, Telegram) with a single codebase. Loading Chat SDK guidance.",
  },
  grammy: {
    skill: "chat-sdk",
    message: "Grammy detected — Chat SDK provides a unified multi-platform API (Slack, Teams, Discord, Telegram) with a single codebase. Loading Chat SDK guidance.",
  },

  // Email
  resend: {
    skill: "email",
    message: "Resend detected — loading Vercel Marketplace Resend integration guidance for transactional emails and React Email templates.",
  },

  // Workflow-related
  workflow: {
    skill: "workflow",
    message: "Workflow DevKit installed — loading WDK guidance for durable workflows.",
  },

  // AI SDK
  ai: {
    skill: "ai-sdk",
    message: "AI SDK installed — loading AI SDK v6 guidance.",
  },
  "@ai-sdk/react": {
    skill: "ai-sdk",
    message: "@ai-sdk/react installed — loading AI SDK v6 guidance for React hooks.",
  },

  // Feature flags
  "@vercel/flags": {
    skill: "vercel-flags",
    message: "Vercel Flags installed — loading feature flags guidance.",
  },

  // SWR
  swr: {
    skill: "swr",
    message: "SWR installed — loading data-fetching guidance.",
  },

  // Security / middleware
  helmet: {
    skill: "vercel-firewall",
    message: "Helmet detected — Vercel Firewall provides DDoS protection, WAF rules, and security headers at the edge. Loading Firewall guidance.",
  },
  cors: {
    skill: "routing-middleware",
    message: "cors detected — Vercel Routing Middleware handles CORS at the platform level with rewrites and headers. Loading Routing Middleware guidance.",
  },

  // Env management
  dotenv: {
    skill: "env-vars",
    message: "dotenv detected — Vercel manages environment variables natively via `vercel env`. Loading env-vars guidance.",
  },

  // Cron / scheduling → Vercel cron jobs
  "node-cron": {
    skill: "cron-jobs",
    message: "node-cron detected — Vercel Cron Jobs provides managed scheduling via vercel.json. Loading cron guidance.",
  },
  cron: {
    skill: "cron-jobs",
    message: "cron package detected — Vercel Cron Jobs provides managed scheduling via vercel.json. Loading cron guidance.",
  },
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/**
 * Regex that matches package manager install commands and captures the
 * package list portion. Handles:
 *   npm install <pkgs>
 *   npm i <pkgs>
 *   npm add <pkgs>
 *   yarn add <pkgs>
 *   pnpm add <pkgs>
 *   pnpm install <pkgs>  (when followed by package names)
 *   bun add <pkgs>
 *   bun install <pkgs>   (when followed by package names)
 */
const INSTALL_CMD_RE =
  /(?:npm\s+(?:install|i|add)|yarn\s+add|pnpm\s+(?:add|install)|bun\s+(?:add|install))\s+(.+)/;

/**
 * Parse a bash command string and extract installed package names.
 * Returns an array of package names (without version specifiers).
 */
export function parseInstallCommand(command: string): string[] {
  if (!command || typeof command !== "string") return [];

  const match = INSTALL_CMD_RE.exec(command);
  if (!match) return [];

  const pkgString = match[1];
  const packages: string[] = [];

  // Split on whitespace, filter flags (--save-dev, -D, etc.) and version specs
  for (const token of pkgString.split(/\s+/)) {
    if (!token) continue;
    // Skip flags
    if (token.startsWith("-")) continue;
    // Skip if it looks like a path (./foo, ../bar, /abs)
    if (token.startsWith(".") || token.startsWith("/")) continue;

    // Strip version specifier (@latest, @^1.0.0, etc.) but preserve scoped packages (@scope/pkg)
    let pkgName = token;
    // For scoped packages like @scope/pkg@1.0.0, strip version after the second @
    if (pkgName.startsWith("@")) {
      const slashIndex = pkgName.indexOf("/");
      if (slashIndex > 0) {
        const afterSlash = pkgName.slice(slashIndex + 1);
        const versionAt = afterSlash.indexOf("@");
        if (versionAt > 0) {
          pkgName = pkgName.slice(0, slashIndex + 1 + versionAt);
        }
      }
    } else {
      // Unscoped: strip @version
      const atIndex = pkgName.indexOf("@");
      if (atIndex > 0) {
        pkgName = pkgName.slice(0, atIndex);
      }
    }

    if (pkgName) packages.push(pkgName);
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export interface ParsedBashInput {
  command: string;
  sessionId: string | null;
  platform: HookPlatform;
  cwd: string;
}

function resolveSessionId(input: Record<string, unknown>): string | null {
  const sessionId = input.session_id ?? input.conversation_id;
  return typeof sessionId === "string" && sessionId.trim() !== "" ? sessionId : null;
}

export function parseBashInput(
  raw: string,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
): ParsedBashInput | null {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const toolName = (input.tool_name as string) || "";
  if (toolName !== "Bash") {
    l.debug("posttooluse-bash-chain-skip", { reason: "not_bash_tool", toolName });
    return null;
  }

  const toolInput = (input.tool_input as Record<string, unknown>) || {};
  const command = (toolInput.command as string) || "";
  if (!command) {
    l.debug("posttooluse-bash-chain-skip", { reason: "no_command" });
    return null;
  }

  const sessionId = resolveSessionId(input);
  const platform = detectPlatform(input);

  const workspaceRoot = Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === "string"
    ? input.workspace_roots[0]
    : undefined;
  const cwdCandidate = input.cwd ?? workspaceRoot ?? env.CURSOR_PROJECT_DIR ?? env.CLAUDE_PROJECT_ROOT ?? process.cwd();
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== ""
    ? cwdCandidate
    : process.cwd();

  return { command, sessionId, platform, cwd };
}

// ---------------------------------------------------------------------------
// Skill injection
// ---------------------------------------------------------------------------

export interface BashChainInjection {
  packageName: string;
  skill: string;
  message: string;
  content: string;
}

export interface BashChainResult {
  injected: BashChainInjection[];
  totalBytes: number;
}

/**
 * For each installed package that maps to a skill, read the SKILL.md body
 * and prepare it for injection (respecting dedup and budget).
 */
export function runBashChainInjection(
  packages: string[],
  sessionId: string | null,
  projectRoot: string,
  pluginRoot: string,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
  skillStore?: SkillStore,
): BashChainResult {
  const l = logger || log;
  const result: BashChainResult = { injected: [], totalBytes: 0 };

  if (packages.length === 0) return result;

  const chainCap = Math.max(
    1,
    parseInt(env.VERCEL_PLUGIN_CHAIN_CAP || "", 10) || DEFAULT_CHAIN_CAP,
  );

  // Read the persisted session-backed seen-skills state for dedup
  const fileSeen = sessionId ? readSessionFile(sessionId, "seen-skills") : "";
  const seenSet = new Set(fileSeen.split(",").filter(Boolean));

  // Create the store once for the entire run (not per-package)
  const store = skillStore ?? createSkillStore({
    projectRoot,
    pluginRoot,
    bundledFallback: env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
  });

  // Deduplicate target skills across packages (first package wins per skill)
  const targetsSeen = new Set<string>();

  for (const pkg of packages) {
    const mapping = PACKAGE_SKILL_MAP[pkg];
    if (!mapping) continue;

    const { skill, message } = mapping;

    // Skip duplicate targets within this invocation
    if (targetsSeen.has(skill)) continue;
    targetsSeen.add(skill);

    // Enforce chain cap
    if (result.injected.length >= chainCap) {
      l.debug("posttooluse-bash-chain-cap-reached", {
        cap: chainCap,
        remaining: packages.length - result.injected.length,
      });
      break;
    }

    // Skip if already injected this session
    if (seenSet.has(skill)) {
      l.debug("posttooluse-bash-chain-skip-dedup", { pkg, skill });
      continue;
    }

    // Read target SKILL.md via skill store (cache-first resolution)
    const resolved = store.resolveSkillBody(skill, l);
    if (!resolved) {
      l.debug("posttooluse-bash-chain-skip-missing", { pkg, skill });
      continue;
    }

    const trimmedBody = resolved.body.trim();
    if (!trimmedBody) continue;

    // Check budget
    const bytes = Buffer.byteLength(trimmedBody, "utf-8");
    if (result.totalBytes + bytes > CHAIN_BUDGET_BYTES) {
      l.debug("posttooluse-bash-chain-budget-exceeded", {
        pkg,
        skill,
        bytes,
        totalBytes: result.totalBytes,
        budget: CHAIN_BUDGET_BYTES,
      });
      break;
    }

    // Claim via dedup
    if (sessionId) {
      const claimed = tryClaimSessionKey(sessionId, "seen-skills", skill);
      if (!claimed) {
        l.debug("posttooluse-bash-chain-skip-concurrent-claim", { pkg, skill });
        seenSet.add(skill);
        continue;
      }
      syncSessionFileFromClaims(sessionId, "seen-skills");
    }

    seenSet.add(skill);

    result.injected.push({ packageName: pkg, skill, message, content: trimmedBody });
    result.totalBytes += bytes;

    l.debug("posttooluse-bash-chain-injected", { pkg, skill, bytes, totalBytes: result.totalBytes });
  }

  if (result.injected.length > 0) {
    l.summary("posttooluse-bash-chain-result", {
      injectedCount: result.injected.length,
      totalBytes: result.totalBytes,
      targets: result.injected.map((i) => i.skill),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatPlatformOutput(
  platform: HookPlatform,
  additionalContext: string,
): string {
  if (platform === "cursor") {
    return JSON.stringify({ additional_context: additionalContext });
  }

  const output: SyncHookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse" as const,
      additionalContext,
    },
  };
  return JSON.stringify(output);
}

export function formatBashChainOutput(
  chainResult: BashChainResult,
  platform: HookPlatform = "claude-code",
): string {
  if (chainResult.injected.length === 0) return "{}";

  const parts: string[] = [];
  for (const chain of chainResult.injected) {
    parts.push(
      `<!-- posttooluse-bash-chain: ${chain.packageName} → ${chain.skill} -->`,
      `**Skill context auto-loaded** (${chain.skill}): ${chain.message}`,
      "",
      chain.content,
      `<!-- /posttooluse-bash-chain: ${chain.skill} -->`,
    );
  }

  const metadata = {
    version: 1,
    hook: "posttooluse-bash-chain",
    packages: chainResult.injected.map((i) => i.packageName),
    chainedSkills: chainResult.injected.map((i) => i.skill),
  };
  parts.push(`<!-- postBashChain: ${JSON.stringify(metadata)} -->`);

  return formatPlatformOutput(platform, parts.join("\n"));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function run(): string {
  const tStart = log.active ? log.now() : 0;

  let raw: string;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }

  const parsed = parseBashInput(raw, log);
  if (!parsed) return "{}";

  const { command, sessionId, platform, cwd } = parsed;

  const packages = parseInstallCommand(command);
  if (packages.length === 0) {
    log.debug("posttooluse-bash-chain-skip", { reason: "no_packages_detected", command });
    return "{}";
  }

  log.debug("posttooluse-bash-chain-packages", { packages, command });

  const store = createSkillStore({
    projectRoot: cwd,
    pluginRoot: PLUGIN_ROOT,
    bundledFallback: process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
  });
  const chainResult = runBashChainInjection(packages, sessionId, cwd, PLUGIN_ROOT, log, process.env, store);
  const output = formatBashChainOutput(chainResult, platform);

  log.complete("posttooluse-bash-chain-done", {
    matchedCount: packages.length,
    injectedCount: chainResult.injected.length,
    dedupedCount: 0,
    cappedCount: 0,
  }, log.active ? { total: Math.round(log.now() - tStart) } : {});

  return output;
}

// ---------------------------------------------------------------------------
// Execute (only when run directly)
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  try {
    const scriptPath = realpathSync(resolve(process.argv[1] || ""));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const output = run();
    process.stdout.write(output);
  } catch (err) {
    const entry = [
      `[${new Date().toISOString()}] CRASH in posttooluse-bash-chain.mts`,
      `  error: ${(err as Error)?.message || String(err)}`,
      `  stack: ${(err as Error)?.stack || "(no stack)"}`,
      `  PLUGIN_ROOT: ${PLUGIN_ROOT}`,
      "",
    ].join("\n");
    process.stderr.write(entry);
    process.stdout.write("{}");
  }
}
