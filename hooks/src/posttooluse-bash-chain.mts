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
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { loadProjectInstalledSkillState } from "./project-installed-skill-state.mjs";
import type { InstallSkillsResult, RegistryClient } from "./registry-client.mjs";
import { readProjectSkillState, type ProjectSkillState } from "./project-skill-manifest.mjs";
import type { SkillInstallPlan, SkillInstallAction } from "./orchestrator-install-plan.mjs";
import {
  readPersistedSkillInstallPlan,
  refreshPersistedSkillInstallPlan,
} from "./orchestrator-install-plan-state.mjs";
import {
  buildSkillCacheStatus,
  formatProjectSkillStateLine,
  resolveSkillCacheBanner,
} from "./skill-cache-banner.mjs";
import type { SkillStore } from "./skill-store.mjs";
import type { SkillSource } from "./skill-store.mjs";
import { formatOrchestratorActionPalette } from "./orchestrator-action-palette.mjs";

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

// ---------------------------------------------------------------------------
// npx skills add detection
// ---------------------------------------------------------------------------

const SKILLS_ADD_RE = /npx\s+skills\s+add\b/;
const SKILL_FLAG_RE = /--skill\s+(\S+)/g;

/**
 * Detect `npx skills add` commands, parse --skill flags, read installed
 * SKILL.md files, and inject them as `Loaded Skill()` additionalContext.
 */
export function parseAndInjectSkillsAdd(
  command: string,
  cwd: string | undefined,
  platform: HookPlatform,
): { output: string; injectedCount: number } | null {
  if (!command || !SKILLS_ADD_RE.test(command)) return null;

  // Parse all --skill flags from the command (may span multiple && chains)
  const slugs: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(SKILL_FLAG_RE.source, "g");
  while ((match = re.exec(command)) !== null) {
    slugs.push(match[1]);
  }

  if (slugs.length === 0) return null;

  // Read SKILL.md bodies from <cwd>/.claude/skills/<slug>/SKILL.md
  const projectRoot = cwd || process.cwd();
  const parts: string[] = [];
  for (const slug of slugs) {
    const skillPath = join(projectRoot, ".claude", "skills", slug, "SKILL.md");
    try {
      const raw = readFileSync(skillPath, "utf-8");
      parts.push(`Loaded Skill(${slug}) from ${skillPath}:\n${raw}`);
    } catch {
      // Skill file may not exist yet if install failed or used a different slug
    }
  }

  if (parts.length === 0) return null;

  const additionalContext = parts.join("\n\n");

  if (platform === "cursor") {
    return {
      output: JSON.stringify({ additional_context: additionalContext, continue: true }),
      injectedCount: parts.length,
    };
  }

  return {
    output: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        additionalContext,
      },
    }),
    injectedCount: parts.length,
  };
}

// ---------------------------------------------------------------------------
// Package install detection
// ---------------------------------------------------------------------------

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

type BashChainSkillSource = SkillSource;

export interface BashChainInjection {
  packageName: string;
  skill: string;
  message: string;
  content: string;
  source: BashChainSkillSource;
  phase: InjectionPhase;
}

export interface DeferredBashSkill {
  packageName: string;
  skill: string;
  message: string;
  reason: "cap-reached" | "budget-exceeded";
  phase: InjectionPhase;
}

function filterDeferredByPhase(
  deferred: DeferredBashSkill[],
  phase: DeferredBashSkill["phase"],
): DeferredBashSkill[] {
  return deferred.filter((entry) => entry.phase === phase);
}

export interface BashChainResult {
  injected: BashChainInjection[];
  missing: string[];
  deferred: DeferredBashSkill[];
  banners: string[];
  totalBytes: number;
}

interface MissingInjectionCandidate {
  packageName: string;
  skill: string;
  message: string;
}

type InjectionPhase = "initial" | "after-install";
type InjectionAttemptResult =
  | "injected"
  | "skip"
  | "cap-reached"
  | "budget-exceeded";

function tryInjectResolvedBashSkill(args: {
  packageName: string;
  skill: string;
  message: string;
  resolvedBody: string;
  source: BashChainSkillSource;
  sessionId: string | null;
  seenSet: Set<string>;
  result: BashChainResult;
  logger: Logger;
  chainCap: number;
  phase: InjectionPhase;
}): InjectionAttemptResult {
  const {
    packageName,
    skill,
    message,
    resolvedBody,
    source,
    sessionId,
    seenSet,
    result,
    logger: l,
    chainCap,
    phase,
  } = args;

  const suffix = phase === "after-install" ? "-after-install" : "";

  if (result.injected.length >= chainCap) return "cap-reached";
  if (seenSet.has(skill)) return "skip";
  if (!resolvedBody) return "skip";

  const bytes = Buffer.byteLength(resolvedBody, "utf-8");
  if (result.totalBytes + bytes > CHAIN_BUDGET_BYTES) {
    l.debug(`posttooluse-bash-chain-budget-exceeded${suffix}`, {
      skill,
      bytes,
      totalBytes: result.totalBytes,
      budget: CHAIN_BUDGET_BYTES,
    });
    return "budget-exceeded";
  }

  if (sessionId) {
    const claimed = tryClaimSessionKey(sessionId, "seen-skills", skill);
    if (!claimed) {
      l.debug(`posttooluse-bash-chain-skip-concurrent-claim${suffix}`, {
        skill,
      });
      seenSet.add(skill);
      return "skip";
    }
    syncSessionFileFromClaims(sessionId, "seen-skills");
  }

  seenSet.add(skill);

  result.injected.push({
    packageName,
    skill,
    message,
    content: resolvedBody,
    source,
    phase,
  });
  result.totalBytes += bytes;

  l.debug(`posttooluse-bash-chain-injected${suffix}`, {
    skill,
    bytes,
    totalBytes: result.totalBytes,
    source,
    phase,
  });

  return "injected";
}

type AfterInstallDisposition =
  | { kind: "continue" }
  | { kind: "stop"; reason: "cap-reached" | "budget-exceeded" };

function buildDeferredSkills(args: {
  remainingResolvedSkills: string[];
  missingCandidates: Map<string, MissingInjectionCandidate>;
  reason: "cap-reached" | "budget-exceeded";
}): DeferredBashSkill[] {
  const { remainingResolvedSkills, missingCandidates, reason } = args;
  const results: DeferredBashSkill[] = [];
  for (const skill of remainingResolvedSkills) {
    const candidate = missingCandidates.get(skill);
    if (!candidate) continue;
    results.push({
      packageName: candidate.packageName,
      skill: candidate.skill,
      message: candidate.message,
      reason,
      phase: "after-install",
    });
  }
  return results;
}

function applyAfterInstallAttempt(args: {
  injectResult: InjectionAttemptResult;
  deferred: DeferredBashSkill[];
  missingCandidates: Map<string, MissingInjectionCandidate>;
  remainingResolvedSkills: string[];
}): AfterInstallDisposition {
  const {
    injectResult,
    deferred,
    missingCandidates,
    remainingResolvedSkills,
  } = args;
  switch (injectResult) {
    case "injected":
    case "skip":
      return { kind: "continue" };
    case "cap-reached":
    case "budget-exceeded":
      deferred.push(
        ...buildDeferredSkills({
          remainingResolvedSkills,
          missingCandidates,
          reason: injectResult,
        }),
      );
      return { kind: "stop", reason: injectResult };
  }
}

function mapPackagesToTargetSkills(packages: string[]): string[] {
  return [
    ...new Set(
      packages.flatMap((pkg) => {
        const mapping = PACKAGE_SKILL_MAP[pkg];
        return mapping ? [mapping.skill] : [];
      }),
    ),
  ].sort();
}

/**
 * For each installed package that maps to a skill, read the SKILL.md body
 * and prepare it for injection (respecting dedup and budget).
 */
export async function runBashChainInjection(
  packages: string[],
  sessionId: string | null,
  projectRoot: string,
  pluginRoot?: string,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
  skillStore?: SkillStore,
  registryClient?: RegistryClient,
): Promise<BashChainResult> {
  const l = logger || log;
  const result: BashChainResult = { injected: [], missing: [], deferred: [], banners: [], totalBytes: 0 };

  if (packages.length === 0) return result;

  const chainCap = Math.max(
    1,
    parseInt(env.VERCEL_PLUGIN_CHAIN_CAP || "", 10) || DEFAULT_CHAIN_CAP,
  );

  // Read the persisted session-backed seen-skills state for dedup
  const fileSeen = sessionId ? readSessionFile(sessionId, "seen-skills") : "";
  const seenSet = new Set(fileSeen.split(",").filter(Boolean));

  // Create the store once for the entire run (not per-package)
  const bundledFallbackEnabled = env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1";
  const targetSkills = mapPackagesToTargetSkills(packages);
  const initialState = loadProjectInstalledSkillState({
    projectRoot,
    pluginRoot: pluginRoot ?? PLUGIN_ROOT,
    likelySkills: targetSkills,
    bundledFallbackEnabled,
    logger: l,
  });
  const store = skillStore ?? initialState.skillStore;

  // Deduplicate target skills across packages (first package wins per skill)
  const targetsSeen = new Set<string>();
  const missingCandidates = new Map<string, MissingInjectionCandidate>();

  for (const pkg of packages) {
    const mapping = PACKAGE_SKILL_MAP[pkg];
    if (!mapping) continue;

    const { skill, message } = mapping;

    // Skip duplicate targets within this invocation
    if (targetsSeen.has(skill)) continue;
    targetsSeen.add(skill);

    // Skip if already injected this session
    if (seenSet.has(skill)) {
      l.debug("posttooluse-bash-chain-skip-dedup", { pkg, skill });
      continue;
    }

    // Resolve target skill via skill store (cache-first, summary fallback)
    const payload = store.resolveSkillPayload(skill, l);
    if (!payload) {
      result.missing.push(skill);
      if (!missingCandidates.has(skill)) {
        missingCandidates.set(skill, { packageName: pkg, skill, message });
      }
      l.debug("posttooluse-bash-chain-skip-missing", { pkg, skill, projectRoot });
      continue;
    }

    const resolvedContent =
      payload.mode === "body" && payload.body
        ? payload.body.trim()
        : [
            payload.summary.trim() !== "" ? `Summary: ${payload.summary.trim()}` : null,
            payload.docs.length > 0 ? `Docs: ${payload.docs.join(", ")}` : null,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n")
            .trim();
    if (resolvedContent === "") continue;

    const injectResult = tryInjectResolvedBashSkill({
      packageName: pkg,
      skill,
      message,
      resolvedBody: resolvedContent,
      source: payload.source as BashChainSkillSource,
      sessionId,
      seenSet,
      result,
      logger: l,
      chainCap,
      phase: "initial",
    });
    if (injectResult === "cap-reached" || injectResult === "budget-exceeded") {
      break;
    }
    if (injectResult === "skip") {
      continue;
    }
  }

  if (result.injected.length > 0) {
    l.summary("posttooluse-bash-chain-result", {
      injectedCount: result.injected.length,
      totalBytes: result.totalBytes,
      targets: result.injected.map((i) => i.skill),
    });
  }

  // Build a cache-status banner for any missing skills, optionally auto-installing.
  // Reuse the already-open store for pre-install cache status instead of building
  // a fresh loadProjectInstalledSkillState — saves one full store + project-state read.
  const uniqueMissing = [...new Set(result.missing)].sort();
  if (uniqueMissing.length > 0) {
    const installedBeforeInstall = store.listInstalledSkills(l);
    const projectStateBeforeInstall = readProjectSkillState(projectRoot);
    const cacheStatusBeforeInstall = buildSkillCacheStatus({
      likelySkills: uniqueMissing,
      installedSkills: installedBeforeInstall,
      bundledFallbackEnabled,
    });
    const resolvedBanner = await resolveSkillCacheBanner({
      ...cacheStatusBeforeInstall,
      projectRoot,
      projectState: projectStateBeforeInstall,
      autoInstall: env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL === "1",
      timeoutMs: 4_000,
      registryClient,
      logger: l,
    });
    if (resolvedBanner.banner) {
      result.banners.push(resolvedBanner.banner);
    }

    // Retry injection for skills that were just installed/reused by the banner
    const installedNow =
      (resolvedBanner.installResult?.installed.length ?? 0) > 0 ||
      (resolvedBanner.installResult?.reused.length ?? 0) > 0;

    if (installedNow) {
      const injectedCountBeforeInstall = result.injected.length;
      const refreshedState = loadProjectInstalledSkillState({
        projectRoot,
        pluginRoot: pluginRoot ?? PLUGIN_ROOT,
        likelySkills: uniqueMissing,
        bundledFallbackEnabled,
        logger: l,
      });
      const refreshedStore = refreshedState.skillStore;

      const resolvedAfterInstall = new Map<
        string,
        { body: string; source: BashChainSkillSource }
      >();
      const stillMissing: string[] = [];
      for (const skill of uniqueMissing) {
        const candidate = missingCandidates.get(skill);
        const refreshedPayload = refreshedStore.resolveSkillPayload(skill, l);
        if (!refreshedPayload || !candidate) {
          stillMissing.push(skill);
          continue;
        }
        const resolvedBody =
          refreshedPayload.mode === "body" && refreshedPayload.body
            ? refreshedPayload.body.trim()
            : [
                refreshedPayload.summary.trim() !== "" ? `Summary: ${refreshedPayload.summary.trim()}` : null,
                refreshedPayload.docs.length > 0 ? `Docs: ${refreshedPayload.docs.join(", ")}` : null,
              ]
                .filter((line): line is string => Boolean(line))
                .join("\n")
                .trim();
        if (resolvedBody === "") {
          stillMissing.push(skill);
          continue;
        }
        resolvedAfterInstall.set(skill, {
          body: resolvedBody,
          source: refreshedPayload.source as BashChainSkillSource,
        });
      }

      for (const [currentIndex, skill] of uniqueMissing.entries()) {
        const candidate = missingCandidates.get(skill);
        const resolvedAfterInstallEntry = resolvedAfterInstall.get(skill);
        if (!resolvedAfterInstallEntry || !candidate) {
          continue;
        }
        const injectResult = tryInjectResolvedBashSkill({
          packageName: candidate.packageName,
          skill: candidate.skill,
          message: candidate.message,
          resolvedBody: resolvedAfterInstallEntry.body,
          source: resolvedAfterInstallEntry.source,
          sessionId,
          seenSet,
          result,
          logger: l,
          chainCap,
          phase: "after-install",
        });
        const disposition = applyAfterInstallAttempt({
          injectResult,
          deferred: result.deferred,
          missingCandidates,
          remainingResolvedSkills: uniqueMissing
            .slice(currentIndex)
            .filter((entry) => resolvedAfterInstall.has(entry)),
        });
        if (disposition.kind === "stop") {
          break;
        }
      }
      // Deferred skills (installed but not injected) should not appear in missing
      const deferredSkillSet = new Set(result.deferred.map((d) => d.skill));
      result.missing = [...new Set(stillMissing)].filter((s) => !deferredSkillSet.has(s));

      // Wire delegation outcome banner
      const afterInstallInjected = result.injected.slice(injectedCountBeforeInstall);
      const afterInstallDeferred = filterDeferredByPhase(result.deferred, "after-install");
      const delegatedOutcomeBanner = buildDelegatedInstallOutcomeBanner({
        installResult: resolvedBanner.installResult,
        injectedAfterInstall: afterInstallInjected,
        deferredAfterInstall: afterInstallDeferred,
        remainingMissing: result.missing,
        projectStateSource: resolvedBanner.projectState.source,
        projectStatePath: resolvedBanner.projectState.projectSkillStatePath,
      });
      if (delegatedOutcomeBanner) {
        result.banners.unshift(delegatedOutcomeBanner);
      }
    }
  }

  // Append a next-action palette when deferred skills exist
  const nextActionPalette = buildPostInstallActionPalette({
    projectRoot,
    deferred: filterDeferredByPhase(result.deferred, "after-install"),
    env,
  });
  if (nextActionPalette) {
    result.banners.push(nextActionPalette);
  }

  // Append the wrapper palette after install activity surfaces actionable items.
  // Always refresh the persisted plan from on-disk state first so the wrapper
  // reflects any delegated changes that just happened during this Bash chain.
  if (result.deferred.length > 0 || result.banners.length > 0) {
    const previousPlan = readPersistedSkillInstallPlan({
      projectRoot,
      rawEnvPlan: env.VERCEL_PLUGIN_INSTALL_PLAN,
    });
    const wrapperPlan = previousPlan
      ? refreshPersistedSkillInstallPlan({
          projectRoot,
          previousPlan,
          pluginRootOverride: pluginRoot ?? PLUGIN_ROOT,
          logger: l,
        })
      : null;
    if (wrapperPlan) {
      const wrapperPalette = formatOrchestratorActionPalette({
        pluginRoot: pluginRoot ?? PLUGIN_ROOT,
        plan: wrapperPlan,
      });
      if (wrapperPalette) {
        result.banners.push(wrapperPalette);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Post-install action palette
// ---------------------------------------------------------------------------


function formatDeferredSkillLine(deferred: DeferredBashSkill[]): string {
  return deferred
    .map((entry) => `${entry.skill} (${entry.reason})`)
    .join(", ");
}

export function buildPostInstallActionPalette(args: {
  projectRoot: string;
  deferred: DeferredBashSkill[];
  env: NodeJS.ProcessEnv;
}): string | null {
  if (args.deferred.length === 0) return null;

  const plan = readPersistedSkillInstallPlan({
    projectRoot: args.projectRoot,
    rawEnvPlan: args.env.VERCEL_PLUGIN_INSTALL_PLAN,
  });
  const orderedIds: Array<SkillInstallAction["id"]> = [
    "vercel-link",
    "vercel-env-pull",
    "vercel-deploy",
    "explain",
  ];

  const lines: string[] = [
    "### Vercel next actions",
    `- Deferred skill injection: ${formatDeferredSkillLine(args.deferred)}`,
    "- [1] Continue by making another relevant tool call, or run one of the real CLI actions below.",
  ];

  let index = 2;
  for (const id of orderedIds) {
    const action = plan?.actions.find((entry) => entry.id === id);
    if (!action?.command) continue;
    lines.push(`- [${index}] ${action.label}: \`${action.command}\``);
    index += 1;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Delegation outcome banner + context title
// ---------------------------------------------------------------------------

export function buildDelegatedInstallOutcomeBanner(args: {
  installResult: InstallSkillsResult | null;
  injectedAfterInstall: BashChainInjection[];
  deferredAfterInstall: DeferredBashSkill[];
  remainingMissing: string[];
  projectStateSource: ProjectSkillState["source"];
  projectStatePath: string | null;
}): string | null {
  if (
    !args.installResult &&
    args.injectedAfterInstall.length === 0 &&
    args.deferredAfterInstall.length === 0 &&
    args.remainingMissing.length === 0
  ) {
    return null;
  }

  const lines: string[] = ["### Vercel skill delegation"];

  if (
    args.injectedAfterInstall.length > 0 &&
    args.deferredAfterInstall.length === 0 &&
    args.remainingMissing.length === 0
  ) {
    lines.push("- Flow: detect \u2192 install \u2192 inject");
  } else if (args.deferredAfterInstall.length > 0) {
    lines.push("- Flow: detect \u2192 install \u2192 defer");
  } else if (args.remainingMissing.length > 0) {
    lines.push("- Flow: detect \u2192 install \u2192 partial");
  } else {
    lines.push("- Flow: detect \u2192 install \u2192 read");
  }

  if (args.installResult?.installed.length) {
    lines.push(`- Installed now: ${args.installResult.installed.join(", ")}`);
  }
  if (args.installResult?.reused.length) {
    lines.push(`- Already cached: ${args.installResult.reused.join(", ")}`);
  }
  if (args.injectedAfterInstall.length) {
    lines.push(
      `- Injected now: ${args.injectedAfterInstall.map((entry) => entry.skill).join(", ")}`,
    );
  }
  if (args.deferredAfterInstall.length) {
    lines.push(
      `- Deferred: ${args.deferredAfterInstall.map((entry) => `${entry.skill} (${entry.reason})`).join(", ")}`,
    );
  }
  if (args.remainingMissing.length) {
    lines.push(`- Still missing: ${args.remainingMissing.join(", ")}`);
  }

  const readStateLine = formatProjectSkillStateLine({
    source: args.projectStateSource,
    path: args.projectStatePath,
  });
  if (readStateLine) {
    lines.push(`- ${readStateLine}`);
  }

  return lines.join("\n");
}

function formatBashChainContextTitle(chain: BashChainInjection): string {
  const sourceLabel =
    chain.source === "project-cache"
      ? "project cache"
      : chain.source === "global-cache"
        ? "global cache"
        : "rules manifest";
  const phaseLabel =
    chain.phase === "after-install" ? "installed now" : "cached";
  return `**Skill context auto-loaded** (${chain.skill} \u2022 ${phaseLabel} \u2022 ${sourceLabel}): ${chain.message}`;
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
  if (
    chainResult.injected.length === 0 &&
    chainResult.banners.length === 0 &&
    chainResult.deferred.length === 0
  ) {
    return "{}";
  }

  const contextParts: string[] = [...chainResult.banners];

  for (const chain of chainResult.injected) {
    contextParts.push(
      [
        `<!-- posttooluse-bash-chain: ${chain.packageName} → ${chain.skill} -->`,
        formatBashChainContextTitle(chain),
        "",
        chain.content,
        `<!-- /posttooluse-bash-chain: ${chain.skill} -->`,
      ].join("\n"),
    );
  }

  const metadata = {
    version: 2,
    hook: "posttooluse-bash-chain",
    packages: chainResult.injected.map((i) => i.packageName),
    chainedSkills: chainResult.injected.map((i) => i.skill),
    missing: chainResult.missing,
    deferred: chainResult.deferred,
  };
  contextParts.push(`<!-- postBashChain: ${JSON.stringify(metadata)} -->`);

  return formatPlatformOutput(platform, contextParts.join("\n\n"));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function run(): Promise<string> {
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

  // Check for `npx skills add` commands — inject installed skill bodies
  try { writeFileSync("/tmp/posttooluse-debug.log", `[${new Date().toISOString()}] command=${command.substring(0, 200)} cwd=${cwd ?? "(null)"} hasSkillsAdd=${/npx\s+skills\s+add\b/.test(command)}\n`, { flag: "a" }); } catch {}
  const skillsInstallResult = parseAndInjectSkillsAdd(command, cwd, platform);
  if (skillsInstallResult) {
    log.debug("posttooluse-skills-add-detected", { command, injectedCount: skillsInstallResult.injectedCount });
    try { writeFileSync("/tmp/posttooluse-debug.log", `[${new Date().toISOString()}] INJECTED ${skillsInstallResult.injectedCount} skills\n`, { flag: "a" }); } catch {}
    return skillsInstallResult.output;
  }

  const packages = parseInstallCommand(command);
  if (packages.length === 0) {
    log.debug("posttooluse-bash-chain-skip", { reason: "no_packages_detected", command });
    return "{}";
  }

  log.debug("posttooluse-bash-chain-packages", { packages, command });

  const chainResult = await runBashChainInjection(packages, sessionId, cwd, PLUGIN_ROOT, log, process.env);
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
  run()
    .then((output) => {
      process.stdout.write(output);
    })
    .catch((err) => {
      const entry = [
        `[${new Date().toISOString()}] CRASH in posttooluse-bash-chain.mts`,
        `  error: ${(err as Error)?.message || String(err)}`,
        `  stack: ${(err as Error)?.stack || "(no stack)"}`,
        `  PLUGIN_ROOT: ${PLUGIN_ROOT}`,
        "",
      ].join("\n");
      process.stderr.write(entry);
      process.stdout.write("{}");
    });
}
