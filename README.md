# vercel-plugin

## Getting Started

### Supported Tools

| Tool | Status |
|------|--------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Supported |
| [Cursor](https://www.cursor.com) | Supported |
| [OpenAI Codex](https://openai.com/index/codex/) | Coming soon |

### Prerequisites

- One of the supported AI coding tools listed above
- Node.js 18+
- [Bun](https://bun.sh)

### Installation

```bash
npx plugins add vercel/vercel-plugin
```

That's it. The plugin activates automatically — no setup, no commands to learn. Just build.

## What It Does

This plugin pre-loads AI agents with a **relational knowledge graph** of the entire Vercel ecosystem — every product, library, CLI, API, and service — showing how they relate, when to use each, and providing deep guidance through bundled skills.

## How Do I Use This?

After installing, there's nothing to learn — all Vercel guidance happens automatically. The plugin detects what you're working on from your tool calls, file paths, and project config, then injects the right expertise at the right time. Just use your AI agent as you normally would and the plugin handles the rest.

## Components

### Ecosystem Graph (`vercel.md`)

A text-form relational graph covering:
- All Vercel products and their relationships
- Decision matrices for choosing the right tool
- Common cross-product workflows
- Migration awareness for sunset products

### Skills (49 skills)

| Skill | Covers |
|-------|--------|
| `agent-browser` | Browser automation CLI — dev server verification, page interaction, screenshots, form filling |
| `agent-browser-verify` | Automated dev-server verification — visual gut-check on page load, console errors, key UI elements |
| `ai-elements` | Pre-built React components for AI interfaces — chat UIs, tool call rendering, streaming responses |
| `ai-gateway` | Unified model API, provider routing, failover, cost tracking, 100+ models |
| `ai-generation-persistence` | AI generation persistence — unique IDs, addressable URLs, database storage, cost tracking |
| `ai-sdk` | AI SDK v6 — text/object generation, streaming, tool calling, agents, MCP, providers, embeddings |
| `auth` | Authentication integrations — Clerk, Descope, Auth0 setup for Next.js with Marketplace provisioning |
| `bootstrap` | Project bootstrapping orchestrator — linking, env provisioning, db setup, first-run commands |
| `chat-sdk` | Multi-platform chat bots — Slack, Telegram, Teams, Discord, Google Chat, GitHub, Linear |
| `cms` | Headless CMS integrations — Sanity, Contentful, DatoCMS, Storyblok, Builder.io, Visual Editing |
| `cron-jobs` | Vercel Cron Jobs configuration, scheduling, and best practices |
| `deployments-cicd` | Deployment and CI/CD — deploy, promote, rollback, --prebuilt, CI workflow files |
| `email` | Email sending — Resend with React Email templates, domain verification, transactional emails |
| `env-vars` | Environment variable management — .env files, vercel env commands, OIDC tokens |
| `geist` | Vercel's font family — Geist Sans, Geist Mono, next/font integration, CSS variables |
| `geistdocs` | Documentation template — Next.js + Fumadocs, MDX authoring, AI chat, i18n |
| `investigation-mode` | Orchestrated debugging — runtime logs, workflow status, browser verify, deploy/env triage |
| `json-render` | AI chat response rendering — UIMessage parts, tool call displays, streaming states |
| `marketplace` | Integration discovery, installation, auto-provisioned env vars, unified billing |
| `micro` | Lightweight async HTTP microservices framework |
| `ncc` | Node.js compiler — single-file bundling for serverless, CLIs, GitHub Actions |
| `next-cache-components` | Next.js 16 Cache Components — PPR, `use cache`, cacheLife, cacheTag, updateTag |
| `next-forge` | Production SaaS monorepo starter — Turborepo, Clerk, Prisma/Neon, Stripe, shadcn/ui |
| `next-upgrade` | Next.js version upgrades — codemods, migration guides, dependency updates |
| `nextjs` | App Router, Server Components, Server Actions, Cache Components, routing, rendering strategies |
| `observability` | Web Analytics, Speed Insights, runtime logs, Log Drains, OpenTelemetry, monitoring |
| `payments` | Stripe payments — Marketplace setup, checkout sessions, webhooks, subscription billing |
| `react-best-practices` | TSX/JSX quality review — component structure, hooks, a11y, performance, TypeScript |
| `routing-middleware` | Request interception before cache, rewrites, redirects, personalization — Edge/Node.js/Bun runtimes |
| `runtime-cache` | Ephemeral per-region key-value cache, tag-based invalidation, shared across Functions/Middleware/Builds |
| `satori` | HTML/CSS to SVG conversion — dynamic OG images for Next.js and other frameworks |
| `shadcn` | shadcn/ui — CLI, component installation, custom registries, theming, Tailwind CSS integration |
| `sign-in-with-vercel` | OAuth 2.0/OIDC identity provider, user authentication via Vercel accounts |
| `swr` | Client-side data fetching — stale-while-revalidate caching, mutations, pagination, infinite loading |
| `turbopack` | Next.js bundler, HMR, configuration, Turbopack vs Webpack |
| `turborepo` | Monorepo orchestration, caching, remote caching, --affected, pruned subsets |
| `v0-dev` | AI code generation, agentic intelligence, GitHub integration |
| `vercel-agent` | AI-powered code review, incident investigation, SDK installation, PR analysis |
| `vercel-api` | Vercel MCP Server and REST API — projects, deployments, env vars, domains, logs |
| `vercel-cli` | All CLI commands — deploy, env, dev, domains, cache management, MCP integration, marketplace |
| `vercel-firewall` | DDoS, WAF, rate limiting, bot filter, custom rules |
| `vercel-flags` | Feature flags, Flags Explorer, gradual rollouts, A/B testing, provider adapters |
| `vercel-functions` | Serverless, Edge, Fluid Compute, streaming, Cron Jobs, configuration |
| `vercel-queues` | Durable event streaming, topics, consumer groups, retries, delayed delivery |
| `vercel-sandbox` | Ephemeral Firecracker microVMs for running untrusted/AI-generated code safely |
| `vercel-services` | Multiple services in one project — monorepo backends + frontends on the same domain |
| `vercel-storage` | Blob, Edge Config, Neon Postgres, Upstash Redis, migration from sunset packages |
| `verification` | Full-story verification — infers user story, verifies end-to-end browser → API → data → response |
| `workflow` | Workflow DevKit — durable execution, DurableAgent, steps, Worlds, pause/resume |

### Agents (3 specialists)

| Agent | Expertise |
|-------|-----------|
| `deployment-expert` | CI/CD pipelines, deploy strategies, troubleshooting, environment variables |
| `performance-optimizer` | Core Web Vitals, rendering strategies, caching, asset optimization |
| `ai-architect` | AI application design, model selection, streaming architecture, MCP integration |

### Commands (5 commands)

| Command | Purpose |
|---------|---------|
| `/vercel-plugin:bootstrap` | Bootstrap project — linking, env provisioning, db setup |
| `/vercel-plugin:deploy` | Deploy to Vercel (preview or production) |
| `/vercel-plugin:env` | Manage environment variables |
| `/vercel-plugin:status` | Project status overview |
| `/vercel-plugin:marketplace` | Discover and install marketplace integrations |

### Hooks

Lifecycle hooks that run automatically during your session:

- **Session start context injection** — Injects `vercel.md` (ecosystem graph + conventions) into every session
- **Session start repo profiler** — Scans config files and dependencies to pre-prime skill matching for faster first tool call
- **Pre-tool-use skill injection** — Matches tool calls to skills and injects relevant guidance with dedup
- **Pre-write/edit validation** — Catches deprecated patterns before they're written (sunset packages, old API names, renamed files)

## Usage

After installing, skills and context are injected automatically. You can also invoke skills directly via slash commands:

```
/vercel-plugin:nextjs
/vercel-plugin:ai-sdk
/vercel-plugin:deploy prod
```

## Upstream Skill Sync

14 skills are synced from their upstream source repos on [skills.sh](https://skills.sh). Each synced skill uses an **overlay + upstream** model:

```
skills/<name>/
├── overlay.yaml          # Plugin metadata (priority, pathPatterns, validate, chainTo)
├── upstream/
│   ├── SKILL.md          # Pure upstream file (synced from source repo)
│   └── references/       # Upstream reference files
└── SKILL.md              # Build output: overlay + upstream body (auto-generated)
```

- `overlay.yaml` is ours — injection metadata that drives the hook system. Never overwritten by sync.
- `upstream/SKILL.md` is theirs — pulled from the source repo, never manually edited.
- `SKILL.md` is the build output — auto-generated by `bun run build:skills`.

### Synced Skills

| Skill | Upstream Repo |
|-------|--------------|
| `agent-browser` | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) |
| `ai-sdk` | [vercel/ai](https://github.com/vercel/ai) |
| `chat-sdk` | [vercel/chat](https://github.com/vercel/chat) |
| `next-cache-components` | [vercel-labs/next-skills](https://github.com/vercel-labs/next-skills) |
| `next-forge` | [vercel/next-forge](https://github.com/vercel/next-forge) |
| `next-upgrade` | [vercel-labs/next-skills](https://github.com/vercel-labs/next-skills) |
| `nextjs` | [vercel-labs/next-skills](https://github.com/vercel-labs/next-skills) |
| `react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) |
| `turborepo` | [vercel/turborepo](https://github.com/vercel/turborepo) |
| `vercel-cli` | [vercel/vercel](https://github.com/vercel/vercel) |
| `vercel-sandbox` | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) |
| `workflow` | [vercel/workflow](https://github.com/vercel/workflow) |

### Syncing an Upstream Skill

Drop the updated file into `upstream/` and rebuild:

```bash
# Update upstream content
cp /path/to/new/SKILL.md skills/ai-sdk/upstream/SKILL.md

# Rebuild (merges overlay + upstream → SKILL.md)
bun run build:skills
```

### CI Check

```bash
bun run build:skills:check
```

Exits non-zero if any `SKILL.md` is stale. Add to CI to catch drift.

## Architecture

```
vercel-plugin/
├── .plugin/plugin.json              # Plugin manifest
├── vercel.md                        # Ecosystem graph + conventions (injected via SessionStart hook)
├── skills/                          # 49 deep-dive skills
│   ├── agent-browser/
│   ├── agent-browser-verify/
│   ├── ai-elements/
│   ├── ai-gateway/
│   ├── ai-generation-persistence/
│   ├── ai-sdk/
│   ├── auth/
│   ├── bootstrap/
│   ├── chat-sdk/
│   ├── cms/
│   ├── cron-jobs/
│   ├── deployments-cicd/
│   ├── email/
│   ├── env-vars/
│   ├── geist/
│   ├── geistdocs/
│   ├── investigation-mode/
│   ├── json-render/
│   ├── marketplace/
│   ├── micro/
│   ├── ncc/
│   ├── next-cache-components/
│   ├── next-forge/
│   ├── next-upgrade/
│   ├── nextjs/
│   ├── observability/
│   ├── payments/
│   ├── react-best-practices/
│   ├── routing-middleware/
│   ├── runtime-cache/
│   ├── satori/
│   ├── shadcn/
│   ├── sign-in-with-vercel/
│   ├── swr/
│   ├── turbopack/
│   ├── turborepo/
│   ├── v0-dev/
│   ├── vercel-agent/
│   ├── vercel-api/
│   ├── vercel-cli/
│   ├── vercel-firewall/
│   ├── vercel-flags/
│   ├── vercel-functions/
│   ├── vercel-queues/
│   ├── vercel-sandbox/
│   ├── vercel-services/
│   ├── vercel-storage/
│   ├── verification/
│   └── workflow/
├── agents/                          # 3 specialist agents
├── commands/                        # 5 slash commands
└── hooks/                           # SessionStart injection, repo profiler, skill injection, deprecation guard
    └── src/                         # TypeScript source (compiled to .mjs via tsup)
```

## Ecosystem Coverage (March 2026)

- Next.js 16 (App Router, Cache Components, Proxy, View Transitions)
- AI SDK v6 (Agents, MCP, DevTools, Reranking, Image Editing)
- AI Elements (pre-built React components for AI interfaces)
- Chat SDK (multi-platform chat bots — Slack, Telegram, Teams, Discord)
- Workflow DevKit (DurableAgent, Worlds, open source)
- AI Gateway (100+ models, provider routing, cost tracking)
- Vercel Functions (Fluid Compute, streaming, Cron Jobs)
- Storage (Blob, Edge Config, Neon Postgres, Upstash Redis)
- Routing Middleware (request interception, Edge/Node.js/Bun runtimes)
- Runtime Cache API (per-region KV cache, tag-based invalidation)
- Vercel Flags (feature flags, Flags Explorer, gradual rollouts, A/B testing)
- Vercel Queues (durable event streaming, topics, consumer groups, retries)
- Vercel Agent (AI code review, incident investigation)
- Vercel Sandbox (Firecracker microVMs for untrusted code)
- Sign in with Vercel (OAuth 2.0/OIDC identity provider)
- Auth integrations (Clerk, Descope, Auth0)
- CMS integrations (Sanity, Contentful, DatoCMS, Storyblok, Builder.io)
- Email (Resend with React Email templates)
- Payments (Stripe via Vercel Marketplace)
- shadcn/ui (CLI, component installation, custom registries, theming)
- Turborepo (--affected, remote caching, Rust core)
- Turbopack (default bundler in Next.js 16)
- Microfrontends (multi-app composition, independent deploys)
- OG Image Generation (@vercel/og, dynamic social images at the edge)
- v0 (agentic intelligence, GitHub integration)
- Vercel Firewall (DDoS, WAF, Bot Filter)
- Vercel CLI (cache management, MCP integration, marketplace discovery)
- Vercel Observability (Analytics, Speed Insights, Drains)
- Vercel Marketplace (one-click integrations, unified billing)
- Agent Browser (browser automation for dev server verification and testing)

## Reporting Issues

If something doesn't work right, a skill gives bad advice, or injection doesn't fire when it should — file an issue on [GitHub](https://github.com/vercel/vercel-plugin/issues). Include:

- What you were building
- What the plugin injected (or didn't) — enable debug logs with `VERCEL_PLUGIN_LOG_LEVEL=debug`
- What was wrong about it
