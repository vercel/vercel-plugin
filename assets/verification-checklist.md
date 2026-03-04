# Verification Checklist — Version-Sensitive Claims

> Every version-sensitive claim in this plugin is listed below with its source URL and a
> last-verified date. Re-verify periodically (monthly or after major Vercel releases).
> When verifying, update the **Last Verified** date and note any discrepancies.

---

## How to Re-Verify

1. Open each **Source URL** and confirm the claim still matches official documentation.
2. Update the **Last Verified** column with today's date.
3. If a claim has changed, update both the relevant file(s) and this checklist.
4. Run `grep -c '⤳ skill:' assets/vercel-ecosystem-graph.md` and `ls skills/*/SKILL.md | wc -l` to confirm structural integrity.

---

## Next.js 16

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 1 | Next.js 16 uses React 19.2 and App Router as default | `skills/nextjs/SKILL.md`, `assets/vercel-ecosystem-graph.md` | https://nextjs.org/blog | 2026-03-03 |
| 2 | `middleware.ts` renamed to `proxy.ts` in v16; runs on Node.js runtime (not Edge) | `skills/nextjs/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 64, Migration table) | https://nextjs.org/docs/app/api-reference/file-conventions/proxy | 2026-03-03 |
| 3 | Cache Components (`'use cache'`) replace PPR from Next.js 15 canaries | `skills/nextjs/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 65, 74, 491, 594) | https://nextjs.org/docs/app/api-reference/directives/use-cache | 2026-03-03 |
| 4 | Turbopack is the default bundler in Next.js 16 | `skills/nextjs/SKILL.md`, `skills/turbopack/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 78, 259) | https://nextjs.org/blog | 2026-03-03 |
| 5 | Async Request APIs: `cookies()`, `headers()`, `params`, `searchParams` are all async | `skills/nextjs/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 593) | https://nextjs.org/docs/messages/sync-dynamic-apis | 2026-03-03 |
| 6 | Turbopack config is top-level (moved from `experimental.turbopack`) | `skills/turbopack/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 592) | https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack | 2026-03-03 |

## AI SDK v6

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 7 | AI SDK v6 is current major version | `skills/ai-sdk/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 107) | https://sdk.vercel.ai/docs | 2026-03-03 |
| 8 | `Agent` class with `stopWhen`, `prepareStep` for agentic loops | `skills/ai-sdk/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 117) | https://sdk.vercel.ai/docs/ai-sdk-core/agents | 2026-03-03 |
| 9 | Tools use `inputSchema` (not `parameters`) and `output`/`outputSchema` (not `result`), aligned with MCP | `skills/ai-sdk/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 115, 596–597) | https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling | 2026-03-03 |
| 10 | DevTools available via `npx @ai-sdk/devtools` | `skills/ai-sdk/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 120) | https://sdk.vercel.ai/docs/ai-sdk-core/devtools | 2026-03-03 |
| 11 | MCP Integration via `@ai-sdk/mcp` with OAuth, Resources, Prompts, Elicitation | `skills/ai-sdk/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 128–132) | https://sdk.vercel.ai/docs/ai-sdk-core/mcp | 2026-03-03 |
| 12 | `mcp-to-ai-sdk` CLI for static tool generation | `assets/vercel-ecosystem-graph.md` (line 132) | https://sdk.vercel.ai/docs/ai-sdk-core/mcp | 2026-03-03 |
| 13 | Global Provider System: `"provider/model"` format in v6 | `skills/ai-sdk/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 134) | https://sdk.vercel.ai/docs/ai-sdk-core/settings | 2026-03-03 |
| 14 | Migration codemod: `npx @ai-sdk/codemod v6` | `assets/vercel-ecosystem-graph.md` (line 595) | https://sdk.vercel.ai/docs/migration | 2026-03-03 |
| 15 | Model identifiers: `gpt-5-mini`, `claude-sonnet-4-6`, `gemini-2.5-flash` | `skills/ai-sdk/SKILL.md` | Provider docs (OpenAI, Anthropic, Google) | 2026-03-03 |

## Workflow DevKit (WDK)

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 16 | `'use workflow'` and `'use step'` directives | `skills/workflow/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 182–183) | https://vercel.com/docs/workflow | 2026-03-03 |
| 17 | `DurableAgent` at `@workflow/ai/agent` wraps AI SDK Agent with durability | `skills/workflow/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 194–195) | https://vercel.com/docs/workflow | 2026-03-03 |
| 18 | Worlds: Local (JSON), Vercel (managed), Self-hosted (Postgres, Redis) | `skills/workflow/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 188–191) | https://vercel.com/docs/workflow | 2026-03-03 |
| 19 | Open source, no vendor lock-in | `assets/vercel-ecosystem-graph.md` (line 199) | https://github.com/vercel/workflow | 2026-03-03 |

## AI Gateway

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 20 | `@ai-sdk/gateway` package for AI Gateway routing | `skills/ai-gateway/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 144, 160) | https://vercel.com/docs/ai-gateway | 2026-03-03 |
| 21 | <20ms routing latency | `assets/vercel-ecosystem-graph.md` (line 167) | https://vercel.com/docs/ai-gateway | 2026-03-03 |
| 22 | Available since AI SDK 5.0.36+ | `skills/ai-gateway/SKILL.md` | https://vercel.com/docs/ai-gateway | 2026-03-03 |

## Vercel MCP Server

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 23 | Official MCP Server at `https://mcp.vercel.com` | `assets/vercel-ecosystem-graph.md` (line 411) | https://vercel.com/docs/mcp | 2026-03-03 |
| 24 | Streamable HTTP transport, OAuth 2.1, read-only (Beta) | `assets/vercel-ecosystem-graph.md` (lines 412–414) | https://vercel.com/docs/mcp | 2026-03-03 |
| 25 | Claude Code integration: `claude mcp add --transport http vercel https://mcp.vercel.com` | `assets/vercel-ecosystem-graph.md` (line 424) | https://vercel.com/docs/mcp | 2026-03-03 |

## Turbopack

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 26 | Instant HMR that doesn't degrade with app size | `skills/turbopack/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 254) | https://turbo.build/pack/docs | 2026-03-03 |
| 27 | Multi-environment builds (Browser, Server, Edge, SSR, RSC) | `assets/vercel-ecosystem-graph.md` (line 255) | https://turbo.build/pack/docs | 2026-03-03 |

## Storage — Sunset Packages

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 28 | `@vercel/postgres` is sunset → use `@neondatabase/serverless` | `skills/vercel-storage/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 292–293, 589) | https://vercel.com/docs/storage | 2026-03-03 |
| 29 | `@vercel/kv` is sunset → use `@upstash/redis` | `skills/vercel-storage/SKILL.md`, `assets/vercel-ecosystem-graph.md` (lines 297–298, 590) | https://vercel.com/docs/storage | 2026-03-03 |
| 30 | `@neondatabase/vercel-postgres-compat` available as drop-in replacement | `assets/vercel-ecosystem-graph.md` (line 589) | https://neon.tech/docs | 2026-03-03 |

## Edge Config

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 31 | `@vercel/edge-config` supports Next.js 16 cacheComponents | `assets/vercel-ecosystem-graph.md` (line 287) | https://vercel.com/docs/storage/edge-config | 2026-03-03 |

## Vercel Functions

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 32 | Serverless timeout: Hobby 10s, Pro 15s | `skills/vercel-functions/SKILL.md` | https://vercel.com/docs/functions/runtimes | 2026-03-03 |
| 33 | Fluid Compute timeout: Hobby 60s, Pro/Enterprise 800s | `skills/vercel-functions/SKILL.md` | https://vercel.com/docs/functions/fluid-compute | 2026-03-03 |
| 34 | Edge Functions cold start <1ms | `skills/vercel-functions/SKILL.md` | https://vercel.com/docs/functions/edge-functions | 2026-03-03 |

## Vercel Firewall

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 35 | 40x faster DDoS mitigation with stream processing | `assets/vercel-ecosystem-graph.md` (line 317) | https://vercel.com/docs/security/vercel-firewall | 2026-03-03 |
| 36 | Bot Filter in public beta, all plans | `assets/vercel-ecosystem-graph.md` (line 324) | https://vercel.com/docs/security/vercel-firewall | 2026-03-03 |
| 37 | 300ms global WAF propagation | `assets/vercel-ecosystem-graph.md` (line 328) | https://vercel.com/docs/security/vercel-firewall | 2026-03-03 |

## Vercel CLI

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 38 | `vercel integration` subcommands: `add`, `list`/`ls`, `open`, `remove` | `skills/vercel-cli/SKILL.md`, `assets/vercel-ecosystem-graph.md` | https://vercel.com/docs/cli | 2026-03-04 |
| 39 | Log Drains configured via Dashboard or REST API (not CLI) | `skills/observability/SKILL.md` | https://vercel.com/docs/drains | 2026-03-04 |

## v0

| # | Claim | Files | Source URL | Last Verified |
|---|-------|-------|------------|---------------|
| 40 | Agentic features (research, plan, debug, iterate) in 2026 | `skills/v0-dev/SKILL.md`, `assets/vercel-ecosystem-graph.md` (line 214) | https://v0.dev/docs | 2026-03-03 |
| 41 | Multi-framework output (React, Vue, Svelte, HTML) | `assets/vercel-ecosystem-graph.md` (line 213) | https://v0.dev/docs | 2026-03-03 |

---

## Structural Integrity Checks

**Source of truth**: `bun run scripts/validate.ts --format json`

The validator checks all cross-references, orphan skills, frontmatter, manifest completeness,
hooks validity, and coverage baseline. Do not embed hardcoded counts in this document — run
the validator for live results.

```bash
# Full validation (JSON report)
bun run scripts/validate.ts --format json

# Human-readable output
bun run scripts/validate.ts

# Quick manual spot-checks (use validator for authoritative results)
grep -o '⤳ skill: [a-z0-9-]*' assets/vercel-ecosystem-graph.md | sort -u
ls skills/
```

---

## Middleware Disambiguation Note

Claim #2 (`middleware.ts` renamed to `proxy.ts` in Next.js 16) is **Next.js-specific**.
The `routing-middleware` skill covers **Vercel platform-level** Routing Middleware, which
remains `middleware.ts` at project root and works with any framework. The skill includes
a disambiguation table covering all three "middleware" concepts:

| Concept | File | Scope |
|---------|------|-------|
| Vercel Routing Middleware | `middleware.ts` | Any framework, platform-level |
| Next.js 16 Proxy | `proxy.ts` | Next.js 16+ only |
| Edge Functions | Any function file | General-purpose edge compute |

See `skills/routing-middleware/SKILL.md` for full details.

---

## Graph-Only Nodes (no `⤳ skill:` link)

These graph nodes intentionally lack dedicated skills — they are managed through
existing skills (CLI, API) or are UI-only features with no code patterns.

| Graph Node | Section | Status | Rationale |
|------------|---------|--------|-----------|
| Domains & DNS | 1. Core Platform | **Intentional** | Configuration-only; managed via `vercel-cli` skill (`vercel domains`, `vercel dns`) and `vercel-api` skill (REST endpoints) |
| Environment Variables | 1. Core Platform | **Intentional** | Managed via `vercel-cli` skill (`vercel env`) and `vercel-api` skill; no standalone SDK |
| Secure Compute | 1. Core Platform | **Intentional** | Enterprise opt-in feature; project-level toggle in Dashboard/API, no SDK or distinct code patterns |
| OIDC Federation | 1. Core Platform | **Intentional** | CI/CD configuration feature; covered by CI provider docs + `vercel-cli` token setup |
| Preview Comments | 1. Core Platform | **Intentional** | UI-only collaboration feature; no SDK or code integration required |
| Vercel Toolbar | 1. Core Platform | **Intentional** | Automatically injected on preview deployments; no code integration beyond `@vercel/toolbar` package (covered in `observability` and `vercel-flags` context) |
| Vercel Templates | 1. Core Platform | **Intentional** | Curated starter repos; one-click deploy, no SDK or code patterns to teach |
| Teams & Access Control | 1. Core Platform | **Intentional** | Dashboard/API feature; covered by `vercel-api` skill (team endpoints) |
| OG Image Generation | 2. Frameworks | **Future candidate** | `@vercel/og` package + `opengraph-image.tsx` file convention could be documented in `nextjs` skill (metadata file conventions section) |
| Other Supported Frameworks | 2. Frameworks | **Intentional** | Thin Vercel adapter layer for each; each framework has its own extensive docs — not practical as a single skill |
| Microfrontends | 4. Build Tools | **Future candidate** | Multi-app composition patterns could be cross-referenced from `turborepo` skill (monorepo multi-app section) |
