# vercel-plugin

A comprehensive [Open Plugin](https://github.com/vercel-labs/open-plugin) that turns any AI agent into a Vercel expert.

## What It Does

This plugin pre-loads AI agents with a **relational knowledge graph** of the entire Vercel ecosystem — every product, library, CLI, API, and service — showing how they relate, when to use each, and providing deep guidance through bundled skills.

## Components

### Ecosystem Graph (`vercel.md`)

A text-form relational graph covering:
- All Vercel products and their relationships
- Decision matrices for choosing the right tool
- Common cross-product workflows
- Migration awareness for sunset products

### Skills (21 skills)

| Skill | Covers |
|-------|--------|
| `ai-gateway` | Unified model API, provider routing, failover, cost tracking, 100+ models |
| `ai-sdk` | AI SDK v6 — text/object generation, streaming, tool calling, agents, MCP, providers, embeddings |
| `marketplace` | Integration discovery, installation, auto-provisioned env vars, unified billing |
| `nextjs` | App Router, Server Components, Server Actions, Cache Components, routing, rendering strategies |
| `observability` | Web Analytics, Speed Insights, runtime logs, Log Drains, OpenTelemetry, monitoring |
| `routing-middleware` | Request interception before cache, rewrites, redirects, personalization — Edge/Node.js/Bun runtimes |
| `runtime-cache` | Ephemeral per-region key-value cache, tag-based invalidation, shared across Functions/Middleware/Builds |
| `sign-in-with-vercel` | OAuth 2.0/OIDC identity provider, user authentication via Vercel accounts |
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
| `vercel-storage` | Blob, Edge Config, Neon Postgres, Upstash Redis, migration from sunset packages |
| `workflow` | Workflow DevKit — durable execution, DurableAgent, steps, Worlds, pause/resume |

### Agents (3 specialists)

| Agent | Expertise |
|-------|-----------|
| `deployment-expert` | CI/CD pipelines, deploy strategies, troubleshooting, environment variables |
| `performance-optimizer` | Core Web Vitals, rendering strategies, caching, asset optimization |
| `ai-architect` | AI application design, model selection, streaming architecture, MCP integration |

### Commands (4 commands)

| Command | Purpose |
|---------|---------|
| `/vercel-plugin:deploy` | Deploy to Vercel (preview or production) |
| `/vercel-plugin:env` | Manage environment variables |
| `/vercel-plugin:status` | Project status overview |
| `/vercel-plugin:marketplace` | Discover and install marketplace integrations |

### Hooks

- **SessionStart context injection** — Injects `vercel.md` (ecosystem graph + conventions) into every session via a `SessionStart` hook
- **Pre-write/edit validation** — Catches deprecated patterns before they're written (sunset packages, old API names, renamed files)

## Usage

```bash
# Load directly for development
claude --plugin-dir ./vercel-plugin

# Invoke skills
/vercel-plugin:nextjs
/vercel-plugin:ai-sdk
/vercel-plugin:deploy prod

# vercel.md is injected via SessionStart hook,
# giving the agent full Vercel context automatically.
```

## Architecture

```
vercel-plugin/
├── .plugin/plugin.json              # Plugin manifest
├── vercel.md                        # Ecosystem graph + conventions (injected via SessionStart hook)
├── skills/                          # 21 deep-dive skills
│   ├── ai-gateway/
│   ├── ai-sdk/
│   ├── marketplace/
│   ├── nextjs/
│   ├── observability/
│   ├── routing-middleware/
│   ├── runtime-cache/
│   ├── sign-in-with-vercel/
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
│   ├── vercel-storage/
│   └── workflow/
├── agents/                          # 3 specialist agents
├── commands/                        # 4 slash commands
├── vercel.md                        # Ecosystem graph + conventions (injected via SessionStart hook)
└── hooks/                           # SessionStart injection + deprecation guard
```

## Ecosystem Coverage (March 2026)

- Next.js 16 (App Router, Cache Components, Proxy, View Transitions)
- AI SDK v6 (Agents, MCP, DevTools, Reranking, Image Editing)
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
- Turborepo (--affected, remote caching, Rust core)
- Turbopack (default bundler in Next.js 16)
- Microfrontends (multi-app composition, independent deploys)
- OG Image Generation (@vercel/og, dynamic social images at the edge)
- v0 (agentic intelligence, GitHub integration)
- Vercel Firewall (DDoS, WAF, Bot Filter)
- Vercel CLI (cache management, MCP integration, marketplace discovery)
- Vercel Observability (Analytics, Speed Insights, Drains)
- Vercel Marketplace (one-click integrations, unified billing)
