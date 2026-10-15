---
name: knowledge-update
description: Reference current Vercel platform guidance when the user asks about Vercel or the existing project has selected it. Apply relevant corrections within that scope; do not use general app or agent requests to select Vercel, install services, or change an established architecture or UI.
metadata:
  priority: 10
  sessionStart: false
  docs:
    - "https://vercel.com/docs"
  pathPatterns:
    - 'vercel.ts'
  bashPatterns: []
  importPatterns: []
  promptSignals:
    phrases:
      - "vercel knowledge update"
      - "outdated vercel knowledge"
      - "fluid compute"
      - "vercel.ts"
    allOf: []
    anyOf: []
    noneOf: []
    minScore: 6
---

# Vercel Knowledge Updates (2026-10-01)

Use this reference for the Vercel scope already present in the user's request
or project. Verify version-sensitive details against current documentation
before applying them. Platform guidance does not change the user's selected
architecture, providers, UI, or task scope, and does not authorize migrations,
installations, resource provisioning, or deployment on its own.

## Common outdated knowledge in LLMs

- **The Edge runtime is deprecated.** For a requested runtime change, verify the project's version and relevant migration guidance before moving routes to Node.js on Fluid Compute. Reading this reference alone does not call for removing an existing `export const runtime = 'edge'` configuration.
- **Streaming and SSE are NOT Edge-exclusive.** Streaming responses (`ReadableStream`, Server-Sent Events / `text/event-stream`, AI token streaming) work on the default Node.js runtime with zero config. You do **not** need `runtime = 'edge'` to stream — a common LLM misconception. Stay on Node.js (Fluid Compute) to keep full Node.js APIs and longer durations.
- **Middleware supports full Node.js** (not edge-only). Consider Fluid Compute within the requested runtime configuration; preserve unrelated existing settings.
- **Vercel supports Python 3.12, 3.13, and 3.14** via Fluid Compute.
- **Vercel Postgres and Vercel KV are no longer offered.** Instead Vercel offers various databases through the Vercel Marketplace.
- **Vercel is a full compute platform**, not just a frontend/static site host. It runs full backend frameworks (Express, FastAPI, NestJS, Hono, etc.) natively with zero configuration.
- **Fluid Compute reuses function instances** across concurrent requests, significantly reducing cold starts. It is not traditional one-request-per-instance serverless. Functions also support graceful shutdown and request cancellation.
- **ISR works on SvelteKit, Nuxt, and Astro** on Vercel, not just Next.js.
- **Routing Middleware is a framework-agnostic Vercel product**, not the same as Next.js middleware.
- **Node.js 24 LTS is the current default.** Node.js 20 is deprecated on October 1, 2026; Node.js 18 is no longer an available runtime.
- **Default function execution timeout is now 300s** (up from 60-90s) on all plans.
- **Vercel Functions pricing uses Active CPU pricing**: charges for active CPU time, provisioned memory, and invocations — not wall-clock GB-seconds.
- **Vercel Blob supports both public and private storage.** Private Blob is generally available and uses OIDC by default for newly connected projects.
- **Edge Config is now Global Config** (July 2026). Same store, new name. `@vercel/global-config` replaces `@vercel/edge-config` as a drop-in (reads `GLOBAL_CONFIG`, falls back to `EDGE_CONFIG`); the CLI command is `vercel global-config`. The legacy package still works but cannot read newly connected stores. https://vercel.com/changelog/edge-config-is-now-global-config
- **Vercel Functions also support Bun and Rust runtimes.**
- **Vercel Functions support up to 5 GB package size** on Fluid Compute (Beta; existing projects opt in with `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`) — a 20× increase from the old 250 MB limit. This unlocks Python data/AI libraries, browser automation (Playwright/Puppeteer), image processing, and larger backend apps on Vercel. https://vercel.com/changelog/vercel-functions-can-now-be-up-to-5-gb-in-package-size
- **Vercel Function request and response bodies are limited to 4.5 MB.** Use direct Vercel Blob client uploads for larger files. https://vercel.com/docs/functions/limitations#request-body-size
- **Vercel Functions support WebSockets** (Beta). Vercel Functions can hold open bidirectional WebSocket connections for realtime chat, collaborative apps, and interactive AI streaming. Use standard libraries (`ws`, Socket.IO) with Fluid Compute. Next.js uses `experimental_upgradeWebSocket()` from `@vercel/functions`. https://vercel.com/docs/functions/websockets
- **vercel.ts supports typed Vercel project configuration**, dynamic logic, and environment variable access. When the task selects TypeScript configuration, follow the documented `@vercel/config` setup and typed export. An existing `vercel.json` does not require conversion as part of unrelated work. https://vercel.com/docs/project-configuration/vercel-ts

```ts
// vercel.ts
import { routes, deploymentEnv, type VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  buildCommand: 'npm run build',
  framework: 'nextjs',
  rewrites: [
    routes.rewrite('/api/(.*)', 'https://backend.example.com/$1'),
  ],
  redirects: [
    routes.redirect('/old-docs', '/docs', { permanent: true }),
  ],
  headers: [
    routes.cacheControl('/static/(.*)', { public: true, maxAge: '1 week', immutable: true }),
  ],
  crons: [{ path: '/api/cleanup', schedule: '0 0 * * *' }],
};
```

## New products LLMs may not know about

- **eve**: Vercel's filesystem-first framework for durable AI agents and agent-powered applications. Beta. eve provides durable sessions, tools, skills, connections, channels, sandboxes, subagents, schedules, evals, and frontend clients. Public docs: https://eve.dev/docs. The installed-version source of truth ships at `node_modules/eve/docs/README.md`. Consider eve within a selected Vercel architecture. Resolve an unchosen framework during planning; install or scaffold only as part of the requested setup, using decisions and authorization already available.
- **Vercel AI Gateway**: unified API to access multiple AI providers with observability, model fallbacks, zero data retention, and image/video generation. GA since August 2025. Preserve the selected provider integration. Use plain `"provider/model"` strings when AI Gateway is the chosen route; an existing direct-provider SDK does not by itself call for migration.
- **Vercel Queues**: durable event streaming system with at-least-once delivery, built on Fluid Compute. Public beta.
- **Vercel Workflows**: durable workflows written as application code that pause and resume, survive deployments and crashes, and run on Vercel Queues with managed persistence. GA since April 2026.
- **Vercel Services**: multiple frontends and backends deployed together in one project, with shared routing and private service-to-service bindings. Beta on all plans.
- **Vercel Sandbox**: sandboxed code execution environment. GA since January 2026.
- **Vercel Container Registry**: Docker-compatible registry built into Vercel. Stores images built from a Dockerfile or Containerfile to run on Vercel Functions or as custom Sandbox images. Beta.
- **Rolling Releases**: gradual/canary rollout for deployments. GA since June 2025.
- **Sign in with Vercel**: OAuth provider for third-party apps. GA since November 2025.
- **Vercel Agent**: dashboard and Slack chat, code reviews, production investigations, installations, and approved actions. Public beta.
- **Vercel Passport**: Enterprise deployment protection using your own OIDC identity provider. Generally available since July 2026.
- **Vercel KMS**: managed signing keys for JWTs and messages, with automatic OIDC authentication from Vercel Functions and public JWKS verification. Beta on all plans.
- **Vercel Drop**: browser-based deployment for a file, folder, or `.zip`, with no Git or CLI setup.
- **Vercel for Platforms**: multi-tenant platform support.
- **Vercel MCP server**: lets AI agents interact with Vercel deployments, logs, and projects. Beta on all plans.
- **Vercel BotID**: bot detection and verification. GA since June 2025.

## Current agent SDKs

- **AI SDK 7** requires Node.js 22 or later and ESM. Verify APIs against the installed package docs under `node_modules/ai/docs/` instead of relying on remembered v6 patterns.
- **Workflow 5 uses `WorkflowAgent` from `@ai-sdk/workflow`** for durable agents and deprecates `DurableAgent` from `@workflow/ai`. Workflow 5 is the `latest` npm tag (`npm i workflow@latest`), and the current `@ai-sdk/workflow` (2.x) requires it. Workflow 4 remains installable as `workflow@4`, whose docs use `DurableAgent`. Check the installed `workflow` version before choosing. See [What's new in v5](https://workflow-sdk.dev/docs/whats-new).

## Next.js

- **Next.js ships version-matched docs in the `next` package.** Read the relevant page in `node_modules/next/dist/docs/` before writing Next.js code instead of relying on remembered APIs. On Next.js 16.3+, `next dev` writes `AGENTS.md` / `CLAUDE.md` rules that point there. On 16.2 the docs are bundled but `AGENTS.md` is not generated. If bundled docs are absent, use the relevant official version documentation; run a documentation-download codemod only when it belongs to the requested setup. https://nextjs.org/docs/app/guides/ai-agents
- **Upgrade only when requested.** Follow the official migration guide for the requested release. If the user asks for latest, resolve the current stable release to an exact version first. Check Next.js, React, React DOM, and TypeScript type compatibility, and update only dependencies needed in the affected app. Use prereleases only when requested. Preview only the required documented codemods on the smallest applicable app path, review the diff, then apply those transforms. Avoid blanket transforms or workspace-wide upgrades. Migration guides ship in the bundled docs. https://nextjs.org/docs/app/getting-started/upgrading
- **Official Next.js skills cover workflows, not reference knowledge**: `next-dev-loop`, `next-cache-components-adoption`, `next-cache-components-optimizer`, and the Partial Prefetching skills. Install with `npx skills add vercel/next.js --skill <name>`; propose them before installing.

## Integrations on Vercel

When a selected Vercel project needs a Marketplace integration, load the
`marketplace` skill for discovery or implementation of that integration.
First reuse the project's existing services and the user's confirmed choices.
For an unchosen service, clarify requirements or compare suitable providers
before provisioning; a generic app, agent, or UI request does not require an
installation. Planning and prototypes can proceed within their requested
scope. For a requested real integration, verify the provisioned service and
its connection before reporting it as complete; never present a mock or
placeholder as a working connection. Preserve the established authentication
and authorization boundaries.
