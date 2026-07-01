# vercel-plugin

## Getting Started

### Supported Tools

| Tool                                                          | Status      |
| ------------------------------------------------------------- | ----------- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Supported   |
| [Cursor](https://www.cursor.com)                              | Supported   |
| [OpenAI Codex](https://openai.com/index/codex/)               | Coming soon |

### Prerequisites

- One of the supported AI coding tools listed above
- Node.js 18+
- [Bun](https://bun.sh)

### Installation

```bash
npx plugins add vercel/vercel-plugin
```

That's it. The plugin installs Vercel context, skills, and a lightweight default hook profile.

## What It Does

This plugin gives AI agents a **relational knowledge graph** of the Vercel ecosystem plus a bundled skill library covering products, libraries, CLI, APIs, and workflows.

## How Do I Use This?

After installing, the plugin keeps automatic behavior lightweight. Session-start activation now only kicks in for empty directories and detected Vercel/Next.js projects, and Vercel skills are no longer auto-injected on every tool call or every prompt by default. The default post-tool path is now observer-only. The skills remain available for direct use, and the repo still keeps the injection engine for targeted or future opt-in workflows.

## Components

### Ecosystem Graph (`vercel.md`)

A text-form relational graph covering:

- All Vercel products and their relationships
- Decision matrices for choosing the right tool
- Common cross-product workflows
- Migration awareness for sunset products

### Skills (26 skills)

| Skill                   | Covers                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `ai-gateway`            | Unified model API, provider routing, failover, cost tracking, 100+ models                                 |
| `ai-sdk`                | AI SDK v6 — text/object generation, streaming, tool calling, agents, MCP, providers, embeddings           |
| `auth`                  | Authentication integrations — Clerk, Descope, Auth0 setup for Next.js with Marketplace provisioning       |
| `bootstrap`             | Project bootstrapping orchestrator — linking, env provisioning, db setup, first-run commands              |
| `chat-sdk`              | Multi-platform chat bots — Slack, Telegram, Teams, Discord, Google Chat, GitHub, Linear                   |
| `deployments-cicd`      | Deployment and CI/CD — deploy, promote, rollback, --prebuilt, CI workflow files                           |
| `env-vars`              | Environment variable management — .env files, vercel env commands, OIDC tokens                            |
| `knowledge-update`      | Knowledge update guidance for the plugin                                                                  |
| `marketplace`           | Integration discovery, installation, auto-provisioned env vars, unified billing                           |
| `next-cache-components` | Next.js 16 Cache Components — PPR, `use cache`, cacheLife, cacheTag, updateTag                            |
| `next-forge`            | Production SaaS monorepo starter — Turborepo, Clerk, Prisma/Neon, Stripe, shadcn/ui                       |
| `next-upgrade`          | Next.js version upgrades — codemods, migration guides, dependency updates                                 |
| `nextjs`                | App Router, Server Components, Server Actions, Cache Components, routing, rendering strategies            |
| `react-best-practices`  | React/Next.js performance optimization — 64 rules across 8 categories                                     |
| `routing-middleware`    | Request interception before cache, rewrites, redirects, personalization — Edge/Node.js/Bun runtimes       |
| `runtime-cache`         | Ephemeral per-region key-value cache, tag-based invalidation, shared across Functions/Middleware/Builds   |
| `shadcn`                | shadcn/ui — CLI, component installation, custom registries, theming, Tailwind CSS integration             |
| `turbopack`             | Next.js bundler, HMR, configuration, Turbopack vs Webpack                                                 |
| `vercel-agent`          | AI-powered code review, incident investigation, SDK installation, PR analysis                             |
| `cdn-caching`           | Diagnose cache hit rate, stale content, revalidation behavior, and ISR read/write cost across CDN/ISR/PPR |
| `vercel-cli`            | All CLI commands — deploy, env, dev, domains, cache management, MCP integration, marketplace              |
| `vercel-functions`      | Serverless, Edge, Fluid Compute, streaming, Cron Jobs, configuration                                      |
| `vercel-sandbox`        | Ephemeral Firecracker microVMs for running untrusted/AI-generated code safely                             |
| `vercel-storage`        | Blob, Edge Config, Neon Postgres, Upstash Redis, migration from sunset packages                           |
| `verification`          | Full-story verification — infers user story, verifies end-to-end browser → API → data → response          |
| `workflow`              | Workflow DevKit — durable execution, DurableAgent, steps, Worlds, pause/resume                            |

### Agents (3 specialists)

| Agent                   | Expertise                                                                       |
| ----------------------- | ------------------------------------------------------------------------------- |
| `deployment-expert`     | CI/CD pipelines, deploy strategies, troubleshooting, environment variables      |
| `performance-optimizer` | Core Web Vitals, rendering strategies, caching, asset optimization              |
| `ai-architect`          | AI application design, model selection, streaming architecture, MCP integration |

### Commands (5 commands)

| Command                      | Purpose                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `/vercel-plugin:bootstrap`   | Bootstrap project — linking, env provisioning, db setup |
| `/vercel-plugin:deploy`      | Deploy to Vercel (preview or production)                |
| `/vercel-plugin:env`         | Manage environment variables                            |
| `/vercel-plugin:status`      | Project status overview                                 |
| `/vercel-plugin:marketplace` | Discover and install marketplace integrations           |

### Hooks

Lifecycle hooks that run automatically during your session:

- **Session start context injection** — Injects a thin Vercel session context plus the knowledge-update guidance for empty directories and detected Vercel/Next.js projects
- **Session start repo profiler** — Scans config files and dependencies to set likely-skill hints, but only after that same activation check passes

## Usage

After installing, session context is injected automatically only for empty directories and detected Vercel/Next.js projects. Vercel skills are available on demand, and you can invoke them directly via slash commands:

```
/vercel-plugin:nextjs
/vercel-plugin:ai-sdk
/vercel-plugin:deploy prod
```

## Telemetry

Telemetry is on by default and can be disabled with `VERCEL_PLUGIN_TELEMETRY=off`.

What is collected:

- `dau:active_today`: sent at most once per UTC day when the plugin runs.
- `plugin:first_use`: sent once per local user profile the first time the plugin successfully reports telemetry.
- `plugin:version`: sent with telemetry batches so usage can be grouped by plugin version.

Each telemetry event contains only:

- `id`: a random event UUID.
- `event_time`: the event timestamp.
- `key`: one of the event names listed above.
- `value`: currently `"1"`.

The request also sends HTTP headers used by the telemetry bridge:

- `x-vercel-plugin-topic-id: dau`
- `x-vercel-plugin-session-id`: a random UUID generated for that telemetry request.
- `x-vercel-plugin-version`: the plugin version embedded at build time.

Prompt text, bash commands, tool-call contents, file paths, project names, account IDs, and skill-injection details are not collected.

How it is tracked:

- Events are sent to Vercel's public telemetry bridge at `https://telemetry.vercel.com/api/vercel-plugin/v1/events`.
- The bridge only forwards events from plugin versions `0.40.0` and newer.
- Local throttle files are stored under `~/.config/vercel-plugin/`:
  - `dau-stamp` prevents sending `dau:active_today` more than once per UTC day.
  - `first-use-stamp` prevents sending `plugin:first_use` more than once.
- Stamp files are written only after the telemetry bridge returns a successful response, so failed sends can retry later.
- `active-session.json` is refreshed on session start with the plugin version and expiry timestamp. It lets Vercel CLI telemetry identify commands run while a recent Vercel plugin session marker is present. It contains no prompt text, file paths, project names, account IDs, tool-call contents, or skill-injection details.

Behavior:

- Unset `VERCEL_PLUGIN_TELEMETRY`: telemetry is enabled.
- `VERCEL_PLUGIN_TELEMETRY=off`: disables all telemetry, including `dau:active_today` and `plugin:first_use`.

Where to set `VERCEL_PLUGIN_TELEMETRY`:

- macOS / Linux: add it to the shell profile for the environment that launches your agent, such as `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, or `~/.config/fish/config.fish`, then restart that terminal or app session.
- Windows: set it in the PowerShell environment that launches your agent, add it to your PowerShell profile (`$PROFILE`), or set it as a persistent user environment variable.

Examples:

```bash
export VERCEL_PLUGIN_TELEMETRY=off
```

```powershell
setx VERCEL_PLUGIN_TELEMETRY off
```

## Upstream Skill Sync

12 skills are synced from their upstream source repos on [skills.sh](https://skills.sh). Each synced skill uses an **overlay + upstream** model:

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

| Skill                   | Upstream Repo                                                             |
| ----------------------- | ------------------------------------------------------------------------- |
| `ai-sdk`                | [vercel/ai](https://github.com/vercel/ai)                                 |
| `chat-sdk`              | [vercel/chat](https://github.com/vercel/chat)                             |
| `next-cache-components` | [vercel-labs/next-skills](https://github.com/vercel-labs/next-skills)     |
| `next-forge`            | [vercel/next-forge](https://github.com/vercel/next-forge)                 |
| `next-upgrade`          | [vercel-labs/next-skills](https://github.com/vercel-labs/next-skills)     |
| `nextjs`                | [vercel-labs/next-skills](https://github.com/vercel-labs/next-skills)     |
| `react-best-practices`  | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)   |
| `vercel-cli`            | [vercel/vercel](https://github.com/vercel/vercel)                         |
| `vercel-sandbox`        | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) |
| `workflow`              | [vercel/workflow](https://github.com/vercel/workflow)                     |

### Syncing an Upstream Skill

Drop the updated file into `upstream/` and rebuild:

```bash
cp /path/to/new/SKILL.md skills/ai-sdk/upstream/SKILL.md
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
├── skills/                          # 25 skills
│   ├── ai-sdk/                      # Upstream-synced skill example:
│   │   ├── overlay.yaml             #   Plugin injection metadata
│   │   ├── upstream/                #   Pure upstream content
│   │   │   ├── SKILL.md
│   │   │   └── references/
│   │   ├── SKILL.md                 #   Build output (overlay + upstream)
│   │   └── references/              #   Copied from upstream at build time
│   ├── ai-elements/                 # Plugin-only skill example:
│   │   └── SKILL.md                 #   Entirely ours
│   └── ...
├── agents/                          # 3 specialist agents
├── commands/                        # 5 slash commands
├── scripts/
│   ├── build-skills.ts              # Rules engine: overlay + upstream → SKILL.md
│   ├── build-manifest.ts            # Generates skill-manifest.json from frontmatter
│   └── build-from-skills.ts         # Resolves {{include:skill:...}} in templates
└── hooks/                           # SessionStart injection, repo profiler, skill injection, deprecation guard
    └── src/                         # TypeScript source (compiled to .mjs via tsup)
```

## Build Pipeline

```bash
bun run build          # Runs all 4 stages in order
bun run build:skills   # Stage 1: Merge overlay + upstream → SKILL.md
bun run build:hooks    # Stage 2: Compile hook TypeScript → .mjs
bun run build:manifest # Stage 3: Generate skill-manifest.json
bun run build:from-skills # Stage 4: Resolve template includes
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
- shadcn/ui (CLI, component installation, custom registries, theming)
- Turborepo (--affected, remote caching, Rust core)
- Turbopack (default bundler in Next.js 16)
- v0 (agentic intelligence, GitHub integration)
- Vercel CLI (cache management, MCP integration, marketplace discovery)
- Vercel Observability (Analytics, Speed Insights, Drains)
- Vercel Marketplace (one-click integrations, unified billing)
- Agent Browser (browser automation for dev server verification and testing)

## Reporting Issues

If something doesn't work right, a skill gives bad advice, or injection doesn't fire when it should — file an issue on [GitHub](https://github.com/vercel/vercel-plugin/issues). Include:

- What you were building
- What the plugin injected (or didn't) — enable debug logs with `VERCEL_PLUGIN_LOG_LEVEL=debug`
- What was wrong about it
