#!/usr/bin/env node

// hooks/src/posttooluse-bash-chain.mts
import { readFileSync, realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { detectPlatform } from "./compat.mjs";
import {
  pluginRoot as resolvePluginRoot,
  readSessionFile,
  tryClaimSessionKey,
  syncSessionFileFromClaims
} from "./hook-env.mjs";
import { createLogger } from "./logger.mjs";
import { loadProjectInstalledSkillState } from "./project-installed-skill-state.mjs";
import { readProjectSkillState } from "./project-skill-manifest.mjs";
import {
  readPersistedSkillInstallPlan,
  refreshPersistedSkillInstallPlan
} from "./orchestrator-install-plan-state.mjs";
import {
  buildSkillCacheStatus,
  formatProjectSkillStateLine,
  resolveSkillCacheBanner
} from "./skill-cache-banner.mjs";
import { formatOrchestratorActionPalette } from "./orchestrator-action-palette.mjs";
var PLUGIN_ROOT = resolvePluginRoot();
var CHAIN_BUDGET_BYTES = 18e3;
var DEFAULT_CHAIN_CAP = 2;
var PACKAGE_SKILL_MAP = {
  // Express / traditional Node servers → Vercel Functions
  express: {
    skill: "vercel-functions",
    message: "Express.js detected \u2014 Vercel uses Web API route handlers, not Express. Loading Vercel Functions guidance."
  },
  fastify: {
    skill: "vercel-functions",
    message: "Fastify detected \u2014 consider Vercel Functions with Web Request/Response API for serverless deployment."
  },
  koa: {
    skill: "vercel-functions",
    message: "Koa detected \u2014 consider Vercel Functions with Web Request/Response API for serverless deployment."
  },
  // Queue / background job libraries → Vercel Queues
  bullmq: {
    skill: "vercel-queues",
    message: "BullMQ detected \u2014 Vercel Queues provides durable event streaming without self-managed Redis. Loading Queues guidance."
  },
  bull: {
    skill: "vercel-queues",
    message: "Bull detected \u2014 Vercel Queues provides durable event streaming without self-managed Redis. Loading Queues guidance."
  },
  // Database / ORM libraries → Vercel Storage
  mongoose: {
    skill: "vercel-storage",
    message: "Mongoose detected \u2014 loading Vercel Storage guidance for database options on the platform."
  },
  prisma: {
    skill: "vercel-storage",
    message: "Prisma detected \u2014 loading Vercel Storage guidance for Neon Postgres (recommended) and other Marketplace databases."
  },
  "@libsql/client": {
    skill: "vercel-storage",
    message: "@libsql/client detected \u2014 loading Vercel Storage guidance for Marketplace database alternatives."
  },
  "@vercel/postgres": {
    skill: "vercel-storage",
    message: "@vercel/postgres is sunset \u2014 use @neondatabase/serverless instead. Loading Storage migration guidance."
  },
  "@vercel/kv": {
    skill: "vercel-storage",
    message: "@vercel/kv is sunset \u2014 use @upstash/redis instead. Loading Storage migration guidance."
  },
  // Payments → Stripe integration
  stripe: {
    skill: "payments",
    message: "Stripe detected \u2014 loading Vercel Marketplace Stripe integration guidance for checkout, webhooks, and subscriptions."
  },
  // Direct AI provider SDKs → AI Gateway
  openai: {
    skill: "ai-gateway",
    message: "Direct OpenAI SDK detected \u2014 AI Gateway provides OIDC auth, failover, and cost tracking with no manual API keys. Loading AI Gateway guidance."
  },
  "@anthropic-ai/sdk": {
    skill: "ai-gateway",
    message: "Direct Anthropic SDK detected \u2014 AI Gateway provides unified access to all providers. Loading AI Gateway guidance."
  },
  "@google/generative-ai": {
    skill: "ai-gateway",
    message: "Direct Google AI SDK detected \u2014 AI Gateway provides unified access to all providers. Loading AI Gateway guidance."
  },
  langchain: {
    skill: "ai-sdk",
    message: "LangChain detected \u2014 AI SDK v6 provides native tool calling, agents, and streaming without the LangChain abstraction layer. Loading AI SDK guidance."
  },
  "@langchain/core": {
    skill: "ai-sdk",
    message: "LangChain Core detected \u2014 AI SDK v6 provides native tool calling, agents, and streaming without the LangChain abstraction layer. Loading AI SDK guidance."
  },
  // Auth
  "next-auth": {
    skill: "auth",
    message: "next-auth detected \u2014 consider Clerk via Vercel Marketplace for managed auth with auto-provisioned env vars. Loading auth guidance."
  },
  "@clerk/nextjs": {
    skill: "auth",
    message: "@clerk/nextjs detected \u2014 loading Vercel Marketplace Clerk integration guidance for middleware auth and sign-in flows."
  },
  // CMS
  "@sanity/client": {
    skill: "cms",
    message: "@sanity/client detected \u2014 loading Vercel Marketplace Sanity integration guidance for studio, preview mode, and revalidation."
  },
  contentful: {
    skill: "cms",
    message: "Contentful detected \u2014 loading CMS integration guidance for content modeling, preview mode, and revalidation webhooks."
  },
  // Chat platforms → Chat SDK
  "@slack/bolt": {
    skill: "chat-sdk",
    message: "@slack/bolt detected \u2014 Chat SDK provides a unified multi-platform API (Slack, Teams, Discord, Telegram) with a single codebase. Loading Chat SDK guidance."
  },
  "@slack/web-api": {
    skill: "chat-sdk",
    message: "@slack/web-api detected \u2014 Chat SDK provides a unified multi-platform API with cards, streaming, and state management. Loading Chat SDK guidance."
  },
  "discord.js": {
    skill: "chat-sdk",
    message: "discord.js detected \u2014 Chat SDK provides a unified multi-platform API (Slack, Teams, Discord, Telegram) with a single codebase. Loading Chat SDK guidance."
  },
  telegraf: {
    skill: "chat-sdk",
    message: "Telegraf detected \u2014 Chat SDK provides a unified multi-platform API (Slack, Teams, Discord, Telegram) with a single codebase. Loading Chat SDK guidance."
  },
  grammy: {
    skill: "chat-sdk",
    message: "Grammy detected \u2014 Chat SDK provides a unified multi-platform API (Slack, Teams, Discord, Telegram) with a single codebase. Loading Chat SDK guidance."
  },
  // Email
  resend: {
    skill: "email",
    message: "Resend detected \u2014 loading Vercel Marketplace Resend integration guidance for transactional emails and React Email templates."
  },
  // Workflow-related
  workflow: {
    skill: "workflow",
    message: "Workflow DevKit installed \u2014 loading WDK guidance for durable workflows."
  },
  // AI SDK
  ai: {
    skill: "ai-sdk",
    message: "AI SDK installed \u2014 loading AI SDK v6 guidance."
  },
  "@ai-sdk/react": {
    skill: "ai-sdk",
    message: "@ai-sdk/react installed \u2014 loading AI SDK v6 guidance for React hooks."
  },
  // Feature flags
  "@vercel/flags": {
    skill: "vercel-flags",
    message: "Vercel Flags installed \u2014 loading feature flags guidance."
  },
  // SWR
  swr: {
    skill: "swr",
    message: "SWR installed \u2014 loading data-fetching guidance."
  },
  // Security / middleware
  helmet: {
    skill: "vercel-firewall",
    message: "Helmet detected \u2014 Vercel Firewall provides DDoS protection, WAF rules, and security headers at the edge. Loading Firewall guidance."
  },
  cors: {
    skill: "routing-middleware",
    message: "cors detected \u2014 Vercel Routing Middleware handles CORS at the platform level with rewrites and headers. Loading Routing Middleware guidance."
  },
  // Env management
  dotenv: {
    skill: "env-vars",
    message: "dotenv detected \u2014 Vercel manages environment variables natively via `vercel env`. Loading env-vars guidance."
  },
  // Cron / scheduling → Vercel cron jobs
  "node-cron": {
    skill: "cron-jobs",
    message: "node-cron detected \u2014 Vercel Cron Jobs provides managed scheduling via vercel.json. Loading cron guidance."
  },
  cron: {
    skill: "cron-jobs",
    message: "cron package detected \u2014 Vercel Cron Jobs provides managed scheduling via vercel.json. Loading cron guidance."
  }
};
var log = createLogger();
var INSTALL_CMD_RE = /(?:npm\s+(?:install|i|add)|yarn\s+add|pnpm\s+(?:add|install)|bun\s+(?:add|install))\s+(.+)/;
function parseInstallCommand(command) {
  if (!command || typeof command !== "string") return [];
  const match = INSTALL_CMD_RE.exec(command);
  if (!match) return [];
  const pkgString = match[1];
  const packages = [];
  for (const token of pkgString.split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith("-")) continue;
    if (token.startsWith(".") || token.startsWith("/")) continue;
    let pkgName = token;
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
      const atIndex = pkgName.indexOf("@");
      if (atIndex > 0) {
        pkgName = pkgName.slice(0, atIndex);
      }
    }
    if (pkgName) packages.push(pkgName);
  }
  return packages;
}
function resolveSessionId(input) {
  const sessionId = input.session_id ?? input.conversation_id;
  return typeof sessionId === "string" && sessionId.trim() !== "" ? sessionId : null;
}
function parseBashInput(raw, logger, env = process.env) {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  let input;
  try {
    input = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const toolName = input.tool_name || "";
  if (toolName !== "Bash") {
    l.debug("posttooluse-bash-chain-skip", { reason: "not_bash_tool", toolName });
    return null;
  }
  const toolInput = input.tool_input || {};
  const command = toolInput.command || "";
  if (!command) {
    l.debug("posttooluse-bash-chain-skip", { reason: "no_command" });
    return null;
  }
  const sessionId = resolveSessionId(input);
  const platform = detectPlatform(input);
  const workspaceRoot = Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === "string" ? input.workspace_roots[0] : void 0;
  const cwdCandidate = input.cwd ?? workspaceRoot ?? env.CURSOR_PROJECT_DIR ?? env.CLAUDE_PROJECT_ROOT ?? process.cwd();
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : process.cwd();
  return { command, sessionId, platform, cwd };
}
function filterDeferredByPhase(deferred, phase) {
  return deferred.filter((entry) => entry.phase === phase);
}
function tryInjectResolvedBashSkill(args) {
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
    phase
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
      budget: CHAIN_BUDGET_BYTES
    });
    return "budget-exceeded";
  }
  if (sessionId) {
    const claimed = tryClaimSessionKey(sessionId, "seen-skills", skill);
    if (!claimed) {
      l.debug(`posttooluse-bash-chain-skip-concurrent-claim${suffix}`, {
        skill
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
    phase
  });
  result.totalBytes += bytes;
  l.debug(`posttooluse-bash-chain-injected${suffix}`, {
    skill,
    bytes,
    totalBytes: result.totalBytes,
    source,
    phase
  });
  return "injected";
}
function buildDeferredSkills(args) {
  const { remainingResolvedSkills, missingCandidates, reason } = args;
  const results = [];
  for (const skill of remainingResolvedSkills) {
    const candidate = missingCandidates.get(skill);
    if (!candidate) continue;
    results.push({
      packageName: candidate.packageName,
      skill: candidate.skill,
      message: candidate.message,
      reason,
      phase: "after-install"
    });
  }
  return results;
}
function applyAfterInstallAttempt(args) {
  const {
    injectResult,
    deferred,
    missingCandidates,
    remainingResolvedSkills
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
          reason: injectResult
        })
      );
      return { kind: "stop", reason: injectResult };
  }
}
function mapPackagesToTargetSkills(packages) {
  return [
    ...new Set(
      packages.flatMap((pkg) => {
        const mapping = PACKAGE_SKILL_MAP[pkg];
        return mapping ? [mapping.skill] : [];
      })
    )
  ].sort();
}
async function runBashChainInjection(packages, sessionId, projectRoot, pluginRoot, logger, env = process.env, skillStore, registryClient) {
  const l = logger || log;
  const result = { injected: [], missing: [], deferred: [], banners: [], totalBytes: 0 };
  if (packages.length === 0) return result;
  const chainCap = Math.max(
    1,
    parseInt(env.VERCEL_PLUGIN_CHAIN_CAP || "", 10) || DEFAULT_CHAIN_CAP
  );
  const fileSeen = sessionId ? readSessionFile(sessionId, "seen-skills") : "";
  const seenSet = new Set(fileSeen.split(",").filter(Boolean));
  const bundledFallbackEnabled = env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1";
  const targetSkills = mapPackagesToTargetSkills(packages);
  const initialState = loadProjectInstalledSkillState({
    projectRoot,
    pluginRoot: pluginRoot ?? PLUGIN_ROOT,
    likelySkills: targetSkills,
    bundledFallbackEnabled,
    logger: l
  });
  const store = skillStore ?? initialState.skillStore;
  const targetsSeen = /* @__PURE__ */ new Set();
  const missingCandidates = /* @__PURE__ */ new Map();
  for (const pkg of packages) {
    const mapping = PACKAGE_SKILL_MAP[pkg];
    if (!mapping) continue;
    const { skill, message } = mapping;
    if (targetsSeen.has(skill)) continue;
    targetsSeen.add(skill);
    if (seenSet.has(skill)) {
      l.debug("posttooluse-bash-chain-skip-dedup", { pkg, skill });
      continue;
    }
    const resolved = store.resolveSkillBody(skill, l);
    if (!resolved) {
      result.missing.push(skill);
      if (!missingCandidates.has(skill)) {
        missingCandidates.set(skill, { packageName: pkg, skill, message });
      }
      l.debug("posttooluse-bash-chain-skip-missing", { pkg, skill, projectRoot });
      continue;
    }
    const trimmedBody = resolved.body.trim();
    if (!trimmedBody) continue;
    const injectResult = tryInjectResolvedBashSkill({
      packageName: pkg,
      skill,
      message,
      resolvedBody: trimmedBody,
      source: resolved.source,
      sessionId,
      seenSet,
      result,
      logger: l,
      chainCap,
      phase: "initial"
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
      targets: result.injected.map((i) => i.skill)
    });
  }
  const uniqueMissing = [...new Set(result.missing)].sort();
  if (uniqueMissing.length > 0) {
    const installedBeforeInstall = store.listInstalledSkills(l);
    const projectStateBeforeInstall = readProjectSkillState(projectRoot);
    const cacheStatusBeforeInstall = buildSkillCacheStatus({
      likelySkills: uniqueMissing,
      installedSkills: installedBeforeInstall,
      bundledFallbackEnabled
    });
    const resolvedBanner = await resolveSkillCacheBanner({
      ...cacheStatusBeforeInstall,
      projectRoot,
      projectState: projectStateBeforeInstall,
      autoInstall: env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL === "1",
      timeoutMs: 4e3,
      registryClient,
      logger: l
    });
    if (resolvedBanner.banner) {
      result.banners.push(resolvedBanner.banner);
    }
    const installedNow = (resolvedBanner.installResult?.installed.length ?? 0) > 0 || (resolvedBanner.installResult?.reused.length ?? 0) > 0;
    if (installedNow) {
      const injectedCountBeforeInstall = result.injected.length;
      const refreshedState = loadProjectInstalledSkillState({
        projectRoot,
        pluginRoot: pluginRoot ?? PLUGIN_ROOT,
        likelySkills: uniqueMissing,
        bundledFallbackEnabled,
        logger: l
      });
      const refreshedStore = refreshedState.skillStore;
      const resolvedAfterInstall = /* @__PURE__ */ new Map();
      const stillMissing = [];
      for (const skill of uniqueMissing) {
        const candidate = missingCandidates.get(skill);
        const resolved = refreshedStore.resolveSkillBody(skill, l);
        if (!resolved || !candidate) {
          stillMissing.push(skill);
          continue;
        }
        const trimmedBody = resolved.body.trim();
        if (!trimmedBody) {
          stillMissing.push(skill);
          continue;
        }
        resolvedAfterInstall.set(skill, {
          body: trimmedBody,
          source: resolved.source
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
          phase: "after-install"
        });
        const disposition = applyAfterInstallAttempt({
          injectResult,
          deferred: result.deferred,
          missingCandidates,
          remainingResolvedSkills: uniqueMissing.slice(currentIndex).filter((entry) => resolvedAfterInstall.has(entry))
        });
        if (disposition.kind === "stop") {
          break;
        }
      }
      const deferredSkillSet = new Set(result.deferred.map((d) => d.skill));
      result.missing = [...new Set(stillMissing)].filter((s) => !deferredSkillSet.has(s));
      const afterInstallInjected = result.injected.slice(injectedCountBeforeInstall);
      const afterInstallDeferred = filterDeferredByPhase(result.deferred, "after-install");
      const delegatedOutcomeBanner = buildDelegatedInstallOutcomeBanner({
        installResult: resolvedBanner.installResult,
        injectedAfterInstall: afterInstallInjected,
        deferredAfterInstall: afterInstallDeferred,
        remainingMissing: result.missing,
        projectStateSource: resolvedBanner.projectState.source,
        projectStatePath: resolvedBanner.projectState.projectSkillStatePath
      });
      if (delegatedOutcomeBanner) {
        result.banners.unshift(delegatedOutcomeBanner);
      }
    }
  }
  const nextActionPalette = buildPostInstallActionPalette({
    projectRoot,
    deferred: filterDeferredByPhase(result.deferred, "after-install"),
    env
  });
  if (nextActionPalette) {
    result.banners.push(nextActionPalette);
  }
  if (result.deferred.length > 0 || result.banners.length > 0) {
    const previousPlan = readPersistedSkillInstallPlan({
      projectRoot,
      rawEnvPlan: env.VERCEL_PLUGIN_INSTALL_PLAN
    });
    const wrapperPlan = previousPlan ? refreshPersistedSkillInstallPlan({
      projectRoot,
      previousPlan,
      pluginRootOverride: pluginRoot ?? PLUGIN_ROOT
    }) : null;
    if (wrapperPlan) {
      const wrapperPalette = formatOrchestratorActionPalette({
        pluginRoot: pluginRoot ?? PLUGIN_ROOT,
        plan: wrapperPlan
      });
      if (wrapperPalette) {
        result.banners.push(wrapperPalette);
      }
    }
  }
  return result;
}
function formatDeferredSkillLine(deferred) {
  return deferred.map((entry) => `${entry.skill} (${entry.reason})`).join(", ");
}
function buildPostInstallActionPalette(args) {
  if (args.deferred.length === 0) return null;
  const plan = readPersistedSkillInstallPlan({
    projectRoot: args.projectRoot,
    rawEnvPlan: args.env.VERCEL_PLUGIN_INSTALL_PLAN
  });
  const orderedIds = [
    "vercel-link",
    "vercel-env-pull",
    "vercel-deploy",
    "explain"
  ];
  const lines = [
    "### Vercel next actions",
    `- Deferred skill injection: ${formatDeferredSkillLine(args.deferred)}`,
    "- [1] Continue by making another relevant tool call, or run one of the real CLI actions below."
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
function buildDelegatedInstallOutcomeBanner(args) {
  if (!args.installResult && args.injectedAfterInstall.length === 0 && args.deferredAfterInstall.length === 0 && args.remainingMissing.length === 0) {
    return null;
  }
  const lines = ["### Vercel skill delegation"];
  if (args.injectedAfterInstall.length > 0 && args.deferredAfterInstall.length === 0 && args.remainingMissing.length === 0) {
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
      `- Injected now: ${args.injectedAfterInstall.map((entry) => entry.skill).join(", ")}`
    );
  }
  if (args.deferredAfterInstall.length) {
    lines.push(
      `- Deferred: ${args.deferredAfterInstall.map((entry) => `${entry.skill} (${entry.reason})`).join(", ")}`
    );
  }
  if (args.remainingMissing.length) {
    lines.push(`- Still missing: ${args.remainingMissing.join(", ")}`);
  }
  const readStateLine = formatProjectSkillStateLine({
    source: args.projectStateSource,
    path: args.projectStatePath
  });
  if (readStateLine) {
    lines.push(`- ${readStateLine}`);
  }
  return lines.join("\n");
}
function formatBashChainContextTitle(chain) {
  const sourceLabel = chain.source === "project-cache" ? "project cache" : chain.source === "global-cache" ? "global cache" : "bundled fallback";
  const phaseLabel = chain.phase === "after-install" ? "installed now" : "cached";
  return `**Skill context auto-loaded** (${chain.skill} \u2022 ${phaseLabel} \u2022 ${sourceLabel}): ${chain.message}`;
}
function formatPlatformOutput(platform, additionalContext) {
  if (platform === "cursor") {
    return JSON.stringify({ additional_context: additionalContext });
  }
  const output = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext
    }
  };
  return JSON.stringify(output);
}
function formatBashChainOutput(chainResult, platform = "claude-code") {
  if (chainResult.injected.length === 0 && chainResult.banners.length === 0 && chainResult.deferred.length === 0) {
    return "{}";
  }
  const contextParts = [...chainResult.banners];
  for (const chain of chainResult.injected) {
    contextParts.push(
      [
        `<!-- posttooluse-bash-chain: ${chain.packageName} \u2192 ${chain.skill} -->`,
        formatBashChainContextTitle(chain),
        "",
        chain.content,
        `<!-- /posttooluse-bash-chain: ${chain.skill} -->`
      ].join("\n")
    );
  }
  const metadata = {
    version: 2,
    hook: "posttooluse-bash-chain",
    packages: chainResult.injected.map((i) => i.packageName),
    chainedSkills: chainResult.injected.map((i) => i.skill),
    missing: chainResult.missing,
    deferred: chainResult.deferred
  };
  contextParts.push(`<!-- postBashChain: ${JSON.stringify(metadata)} -->`);
  return formatPlatformOutput(platform, contextParts.join("\n\n"));
}
async function run() {
  const tStart = log.active ? log.now() : 0;
  let raw;
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
  const chainResult = await runBashChainInjection(packages, sessionId, cwd, PLUGIN_ROOT, log, process.env);
  const output = formatBashChainOutput(chainResult, platform);
  log.complete("posttooluse-bash-chain-done", {
    matchedCount: packages.length,
    injectedCount: chainResult.injected.length,
    dedupedCount: 0,
    cappedCount: 0
  }, log.active ? { total: Math.round(log.now() - tStart) } : {});
  return output;
}
function isMainModule() {
  try {
    const scriptPath = realpathSync(resolve(process.argv[1] || ""));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}
if (isMainModule()) {
  run().then((output) => {
    process.stdout.write(output);
  }).catch((err) => {
    const entry = [
      `[${(/* @__PURE__ */ new Date()).toISOString()}] CRASH in posttooluse-bash-chain.mts`,
      `  error: ${err?.message || String(err)}`,
      `  stack: ${err?.stack || "(no stack)"}`,
      `  PLUGIN_ROOT: ${PLUGIN_ROOT}`,
      ""
    ].join("\n");
    process.stderr.write(entry);
    process.stdout.write("{}");
  });
}
export {
  PACKAGE_SKILL_MAP,
  buildDelegatedInstallOutcomeBanner,
  buildPostInstallActionPalette,
  formatBashChainOutput,
  parseBashInput,
  parseInstallCommand,
  run,
  runBashChainInjection
};
