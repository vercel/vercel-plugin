# Vercel Ecosystem — Relational Knowledge Graph

> This document is the master reference for understanding the entire Vercel ecosystem.
> It maps every product, library, CLI, API, and service — how they relate, when to use each,
> and which bundled skills provide deeper guidance.

---

## Legend

- **[PRODUCT]** — A Vercel product or service
- **→ depends on** — Runtime or build-time dependency
- **↔ integrates with** — Bidirectional integration
- **⇢ alternative to** — Can substitute for
- **⊃ contains** — Parent/child relationship
- **⤳ skill:** — Link to a bundled skill for detailed guidance
- **📖 docs:** — Link to official documentation

---

## 1. Core Platform

```
VERCEL PLATFORM                            📖 docs: https://vercel.com/docs
├── Deployment Engine (CI/CD, Preview URLs, Production)
│   → Git Provider (GitHub, GitLab, Bitbucket)
│   → Build System (Turbopack or framework-native)
│   ↔ Vercel CLI
│   ↔ Vercel REST API / @vercel/sdk
│   ⤳ skill: vercel-cli
│
├── Edge Network (Global CDN, ~300ms propagation)
│   ⊃ Edge Functions (V8 isolates, Web Standard APIs)
│   ⊃ Serverless Functions (Node.js, Python, Go, Ruby)
│   ⊃ Fluid Compute (unified execution model)
│   ⊃ Routing Middleware (request interception before cache, any framework)
│   ⊃ Runtime Cache (per-region key-value, tag-based invalidation)
│   ⊃ Cron Jobs (scheduled function invocation → see § Functions decision matrix)
│   ⤳ skill: vercel-functions
│   ⤳ skill: routing-middleware
│   ⤳ skill: runtime-cache
│
├── Domains & DNS
│   → Deployment Engine
│   ↔ Vercel Firewall
│   ⤳ skill: vercel-cli  (vercel domains, vercel dns, vercel certs)
│
├── Environment Variables
│   → Deployment Engine
│   ↔ Vercel CLI (vercel env)
│   ↔ Marketplace Integrations (auto-provisioned)
│
├── Secure Compute (isolated infrastructure for compliance workloads)
│   → Deployment Engine (opt-in per project)
│   ↔ Vercel Functions (dedicated execution environment)
│   ↔ Vercel Firewall (network-level isolation)
│
├── OIDC Federation (deploy without long-lived tokens)
│   → Deployment Engine (CI/CD token exchange)
│   ↔ Teams & Access Control (identity-based auth)
│   ↔ GitHub Actions, GitLab CI (short-lived OIDC tokens)
│
├── Preview Comments (collaborate on preview deployments)
│   → Deployment Engine (preview URLs)
│   ↔ Vercel Toolbar (embedded comment UI)
│   ↔ Teams & Access Control (team-scoped threads)
│
├── Vercel Toolbar (developer toolbar for preview deployments)
│   → Deployment Engine (preview URLs)
│   ↔ Preview Comments (inline annotation)
│   ↔ Vercel Analytics (performance overlay)
│   ↔ Edge Config (feature flag toggles)
│
├── Vercel Templates (starter kits and example repos)
│   → Deployment Engine (one-click deploy)
│   ↔ Vercel Marketplace (pre-configured integrations)
│   ↔ Next.js, AI SDK, v0 (framework starters)
│
├── Vercel Queues (durable event streaming)
│   ⊃ Topics, consumer groups, delayed delivery
│   ⊃ At-least-once delivery, 3-AZ durability
│   → Vercel Functions (consumers run as functions)
│   ↔ Workflow DevKit (Queues powers WDK under the hood)
│   ⤳ skill: vercel-queues
│
├── Vercel Flags (feature flags platform)
│   ⊃ Unified dashboard, Flags Explorer
│   ⊃ Gradual rollouts, A/B testing
│   ⊃ Provider adapters (LaunchDarkly, Statsig, Hypertune)
│   ↔ Edge Config (flag storage at the edge)
│   ↔ Vercel Toolbar (flag toggles in preview)
│   ⤳ skill: vercel-flags
│
└── Teams & Access Control
    ↔ Vercel REST API
    ↔ Vercel Dashboard
```

---

## 2. Frameworks

```
NEXT.JS (v16+)                           ⤳ skill: nextjs  📖 docs: https://nextjs.org/docs
├── App Router (file-system routing)
│   ⊃ Server Components (default, zero client JS)
│   ⊃ Client Components ('use client')
│   ⊃ Server Actions / Server Functions ('use server')
│   ⊃ Route Handlers (API endpoints)
│   ⊃ Middleware → renamed to Proxy in v16
│   ⊃ Cache Components ('use cache')
│   ⊃ Layouts, Loading, Error boundaries
│   ⊃ Parallel & Intercepting Routes
│   ⊃ Dynamic Segments ([id], [...slug], [[...slug]])
│
├── Rendering Strategies
│   ⊃ SSR (Server-Side Rendering)
│   ⊃ SSG (Static Site Generation)
│   ⊃ ISR (Incremental Static Regeneration)
│   ⊃ PPR (Partial Prerendering) → evolving to Cache Components
│   ⊃ Streaming (React Suspense boundaries)
│
├── Build System
│   → Turbopack (default bundler in v16)
│   → Webpack (legacy, still supported)
│
├── Key Integrations
│   ↔ Vercel AI SDK (chat UIs, streaming, tool calling)
│   ↔ Vercel Analytics / Speed Insights           ⤳ skill: observability
│   ↔ Vercel Image Optimization (next/image)      ⤳ skill: nextjs
│   ↔ Vercel Font Optimization (next/font)
│   ↔ Vercel Functions (automatic from route handlers / server actions)
│
└── Deployment
    → Vercel Platform (optimized, zero-config)
    ↔ Vercel CLI (vercel dev, vercel build)

OTHER SUPPORTED FRAMEWORKS
├── Astro          ↔ Vercel Adapter
├── SvelteKit      ↔ Vercel Adapter
├── Nuxt           ↔ Vercel Adapter
├── Remix          ↔ Vercel Adapter
├── Angular        ↔ Vercel Adapter
├── Solid          ↔ Vercel Adapter
└── Static HTML/JS → Direct deploy
```

---

## 3. AI Products

```
AI SDK (v6, TypeScript)                    ⤳ skill: ai-sdk  📖 docs: https://sdk.vercel.ai/docs
├── Core
│   ⊃ generateText / streamText
│   ⊃ generateObject / streamObject (structured output)
│   ⊃ generateImage / editImage
│   ⊃ embed / embedMany (vector embeddings)
│   ⊃ rerank (relevance reordering)
│   ⊃ Language Model Middleware (RAG, guardrails)
│   ⊃ Tool Calling (inputSchema/outputSchema, MCP-aligned)
│   ⊃ Dynamic Tools (runtime-defined, MCP integration)
│   ⊃ Agent class (agentic loop, stopWhen, prepareStep)
│   ⊃ Subagents
│   ⊃ Tool Execution Approval
│   ⊃ DevTools (npx @ai-sdk/devtools)
│
├── UI Layer (@ai-sdk/react, @ai-sdk/svelte, @ai-sdk/vue)
│   ⊃ useChat (chat interface hook)
│   ⊃ useCompletion (text completion hook)
│   ⊃ useObject (structured streaming hook)
│   ⊃ UIMessage / ModelMessage types
│
├── MCP Integration (@ai-sdk/mcp)
│   ⊃ MCP Client (connect to any MCP server)
│   ⊃ OAuth authentication for remote MCP servers
│   ⊃ Resources, Prompts, Elicitation
│   ⊃ mcp-to-ai-sdk CLI (static tool generation for security)
│
├── Providers (Global Provider System: "provider/model")
│   ⊃ @ai-sdk/openai (GPT-5.x, o-series)
│   ⊃ @ai-sdk/anthropic (Claude 4.x)
│   ⊃ @ai-sdk/google (Gemini)
│   ⊃ @ai-sdk/amazon-bedrock
│   ⊃ @ai-sdk/azure
│   ⊃ @ai-sdk/mistral
│   ⊃ @ai-sdk/cohere
│   ⊃ @ai-sdk/xai (Grok)
│   ⊃ @ai-sdk/deepseek
│   ⊃ @ai-sdk/gateway (Vercel AI Gateway routing)
│   └── ... 20+ providers
│
├── Streaming Protocol
│   ⊃ SSE-based (Server-Sent Events)
│   → Vercel Functions (streaming support)
│   ↔ Next.js Route Handlers / Server Actions
│
└── Key Patterns
    ↔ Next.js (chat apps, AI features in web apps)
    ↔ Workflow DevKit (durable agents)
    ↔ AI Gateway (model routing, cost tracking)
    ↔ v0 (AI-generated UI components)

AI GATEWAY                                 ⤳ skill: ai-gateway  📖 docs: https://vercel.com/docs/ai-gateway
├── Unified API ("creator/model-name" format)
│   → @ai-sdk/gateway package
│   ↔ AI SDK (automatic when using model strings)
│
├── Features
│   ⊃ Provider Routing (order, only, fallback models)
│   ⊃ Automatic Retries & Failover
│   ⊃ Cost Tracking & Usage Attribution (tags, user tracking)
│   ⊃ <20ms routing latency
│   ⊃ Bring Your Own Key (0% markup)
│   ⊃ Built-in Observability
│
├── Supported Providers
│   ⊃ OpenAI, Anthropic, Google, Meta, xAI, Mistral
│   ⊃ DeepSeek, Amazon Bedrock, Cohere, Perplexity, Alibaba
│   └── 100+ models total
│
└── Multimodal
    ⊃ Text, Image, Video generation
    ↔ AI SDK (unified interface)

WORKFLOW DEVKIT (WDK)                      ⤳ skill: workflow  📖 docs: https://vercel.com/docs/workflow
├── Core Concepts
│   ⊃ 'use workflow' directive
│   ⊃ 'use step' directive
│   ⊃ Durable execution (survives deploys, crashes)
│   ⊃ Deterministic replay
│   ⊃ Pause/resume (minutes to months)
│
├── Worlds (Execution Environments)
│   ⊃ Local World (JSON files on disk)
│   ⊃ Vercel World (managed, zero-config on Vercel)
│   ⊃ Self-hosted (Postgres, Redis, custom)
│
├── AI Integration
│   ⊃ DurableAgent (@workflow/ai/agent)
│   → AI SDK Agent class (wrapped with durability)
│   → AI SDK tool calling (each tool = retryable step)
│
├── Key Properties
│   ⊃ Open source, no vendor lock-in
│   ⊃ TypeScript-native (async/await, no YAML)
│   ⊃ Observable (step-level visibility)
│   ⊃ Retryable (automatic retry on failure)
│
└── Integrations
    ↔ AI SDK 6 (DurableAgent)
    ↔ Vercel Functions (automatic step isolation)
    ↔ Next.js (API routes as workflow endpoints)

v0 (AI Development Agent)                  ⤳ skill: v0-dev  📖 docs: https://v0.dev/docs
├── Capabilities
│   ⊃ Natural language → production React/Next.js code
│   ⊃ Visual input (Figma, screenshots, sketches)
│   ⊃ Multi-framework output (React, Vue, Svelte, HTML)
│   ⊃ Agentic intelligence (research, plan, debug, iterate)
│
├── Integration Features
│   ⊃ GitHub Integration (branches, PRs, deploy on merge)
│   ⊃ One-click Vercel deployment
│   ⊃ Environment variable import from Vercel
│   ⊃ shadcn/ui + Tailwind CSS defaults
│
└── Ecosystem Position
    → Next.js (primary output framework)
    → Vercel Platform (deployment target)
    ↔ AI SDK (AI features in generated apps)
    ↔ Vercel Marketplace (integrations in generated apps)

VERCEL AGENT                               ⤳ skill: vercel-agent  📖 docs: https://vercel.com/docs/workflow/agent
├── Capabilities
│   ⊃ Automated code review (PR analysis, security, logic errors)
│   ⊃ Incident investigation (anomaly debugging)
│   ⊃ SDK installation assistance
│   ⊃ Vercel Sandbox (secure patch validation)   ⤳ skill: vercel-sandbox
│
└── Integrations
    ↔ GitHub (PR triggers, @vercel mentions)
    ↔ Vercel Sandbox (isolated code execution)
    ↔ AI SDK (underlying AI capabilities)
```

---

## 4. Build Tools

```
TURBOREPO                                  ⤳ skill: turborepo  📖 docs: https://turbo.build/repo/docs
├── Purpose: Monorepo build orchestration
│   ⊃ Task caching (local + remote)
│   ⊃ Parallel execution (all cores)
│   ⊃ Incremental builds (content-aware hashing)
│   ⊃ --affected flag (changed packages only)
│   ⊃ Pruned subsets (deploy only what's needed)
│   ⊃ Rust-powered core
│
├── Remote Caching
│   → Vercel Account (free tier available)
│   ↔ CI/CD pipelines (shared cache across machines)
│
├── Conformance (code quality + best-practice checks for monorepos)
│   ⊃ Automated rule enforcement (ESLint, TypeScript, import boundaries)
│   ↔ Turborepo (runs as part of task pipeline)
│   ↔ Vercel Platform (enforced on deploy)
│   ⤳ skill: turborepo  (Conformance is configured within Turborepo)
│
└── Integrations
    ↔ Next.js (monorepo with multiple Next.js apps)
    ↔ Vercel Platform (auto-detected, optimized builds)
    ↔ Turbopack (per-app bundling)

TURBOPACK                                  ⤳ skill: turbopack  📖 docs: https://turbo.build/pack/docs
├── Purpose: JavaScript/TypeScript bundler
│   ⊃ Instant HMR (doesn't degrade with app size)
│   ⊃ Multi-environment builds (Browser, Server, Edge, SSR, RSC)
│   ⊃ TypeScript, JSX, CSS, CSS Modules, WebAssembly
│   ⊃ React Server Components (native support)
│
├── Status: Default bundler in Next.js 16
│   → Next.js (top-level turbopack config)
│   ⇢ alternative to: Webpack
│
└── Architecture
    ⊃ Rust-powered
    ⊃ Incremental computation engine
    ⊃ Lives in the Next.js monorepo
```

---

## 5. Storage & Data

```
VERCEL BLOB (active, first-party)          ⤳ skill: vercel-storage  📖 docs: https://vercel.com/docs/storage/vercel-blob
├── Purpose: File storage for unstructured data
│   ⊃ Client uploads (up to 5 TB)
│   ⊃ Conditional gets with ETags
│   ⊃ @vercel/blob package
│
└── Use When: Media files, user uploads, large assets

VERCEL EDGE CONFIG (active, first-party)   ⤳ skill: vercel-storage  📖 docs: https://vercel.com/docs/storage/edge-config
├── Purpose: Global low-latency key-value for config
│   ⊃ Feature flags
│   ⊃ A/B testing configuration
│   ⊃ Dynamic routing rules
│   ⊃ @vercel/edge-config package (supports Next.js 16 cacheComponents)
│
└── Use When: Config that must be read at the edge instantly

MARKETPLACE STORAGE (partner-provided)     ⤳ skill: vercel-storage
├── Neon Postgres (replaces @vercel/postgres)
│   ⊃ @neondatabase/serverless
│   ⊃ Branching, auto-scaling
│   ⇢ alternative to: @vercel/postgres (sunset)
│
├── Upstash Redis (replaces @vercel/kv)
│   ⊃ @upstash/redis
│   ⊃ Same Vercel billing integration
│   ⇢ alternative to: @vercel/kv (sunset)
│
└── Other: MongoDB, PlanetScale, Supabase, etc.
    ↔ Vercel Marketplace (one-click install, auto env vars)
```

**IMPORTANT**: `@vercel/postgres` and `@vercel/kv` are **sunset**. Use Neon and Upstash respectively.

---

## 6. Security

```
VERCEL FIREWALL                            ⤳ skill: vercel-firewall  📖 docs: https://vercel.com/docs/security/vercel-firewall
├── DDoS Protection (automatic, all plans)
│   ⊃ Layer 3/4 mitigation
│   ⊃ Layer 7 protection
│   ⊃ 40x faster with stream processing
│
├── Web Application Firewall (WAF)
│   ⊃ Custom rules engine (path, user-agent, IP, geo, JA4)
│   ⊃ Framework-aware rules (no regex needed)
│   ⊃ Managed rulesets (OWASP Top 10, Enterprise)
│   ⊃ Rate limiting
│   ⊃ Bot Filter (public beta, all plans)
│   ⊃ Attack Challenge Mode
│   ⊃ Persistent Actions (block repeat offenders)
│   ⊃ Firewall API (programmatic control)
│   ⊃ 300ms global propagation
│
└── Integrations
    ↔ Edge Network (embedded in request lifecycle)
    ↔ Vercel Observability (linked logs)
    ↔ Vercel REST API (Firewall API)

SIGN IN WITH VERCEL                        ⤳ skill: sign-in-with-vercel  📖 docs: https://vercel.com/docs/security/sign-in-with-vercel
├── OAuth 2.0 / OIDC Identity Provider
│   ⊃ Authorization Code flow
│   ⊃ ID tokens with user profile claims
│   ⊃ Access tokens for Vercel API calls
│
└── Integrations
    ↔ Teams & Access Control (team-scoped auth)
    ↔ Vercel REST API (token exchange)
    ↔ Next.js (auth route handlers)
```

---

## 7. Observability

```
VERCEL OBSERVABILITY                        ⤳ skill: observability  📖 docs: https://vercel.com/docs/analytics
├── Web Analytics
│   ⊃ First-party, privacy-friendly
│   ⊃ Custom events (Pro/Enterprise)
│   ⊃ UTM parameters (Analytics Plus)
│   ↔ Next.js (@vercel/analytics)
│
├── Speed Insights
│   ⊃ Real user performance data
│   ⊃ Core Web Vitals
│   ↔ Next.js (@vercel/speed-insights)
│
├── Monitoring & Logs
│   ⊃ Real-time infrastructure logs
│   ⊃ Function runtime logs
│   ⊃ Custom queries and visualizations
│
├── Vercel Drains (export observability data)
│   ⊃ OpenTelemetry-compatible traces
│   ⊃ Web analytics events
│   ⊃ Speed Insights metrics
│   → Datadog, Honeycomb, Grafana Tempo, New Relic
│
└── Integrations
    ↔ Vercel Firewall (security event logs)
    ↔ Vercel Functions (automatic tracing)
    ↔ Next.js (automatic instrumentation)
```

---

## 8. CLI & API

```
VERCEL CLI (vercel / vc)                   ⤳ skill: vercel-cli  📖 docs: https://vercel.com/docs/cli
├── Deployment
│   ⊃ vercel / vercel deploy (preview deployment)
│   ⊃ vercel --prod (production deployment)
│   ⊃ vercel build (local build)
│   ⊃ vercel deploy --prebuilt (deploy build output only)
│   ⊃ vercel promote / vercel rollback
│
├── Development
│   ⊃ vercel dev (local dev server)
│   ⊃ vercel link (connect to Vercel project)
│   ⊃ vercel pull (pull env vars and project settings)
│
├── Environment Variables
│   ⊃ vercel env ls / add / rm / pull
│   ⊃ Branch-scoped variables
│   ⊃ Sensitive variables (write-only)
│
├── Marketplace Integrations
│   ⊃ vercel integration add (install integration)
│   ⊃ vercel integration list (list installed)
│   ⊃ vercel integration open (open dashboard)
│   ⊃ vercel integration remove (uninstall)
│
├── Other
│   ⊃ vercel logs (view function logs)
│   ⊃ vercel inspect (deployment details)
│   ⊃ vercel domains (manage domains)
│   ⊃ vercel certs (SSL certificates)
│   ⊃ vercel dns (DNS records)
│   ⊃ vercel teams (team management)
│
└── CI/CD Integration
    ⊃ VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID
    ↔ Any CI provider (GitHub Actions, Azure DevOps, etc.)

VERCEL MCP SERVER (Official)                ⤳ skill: vercel-api  📖 docs: https://vercel.com/docs/mcp
├── URL: https://mcp.vercel.com
│   ⊃ Streamable HTTP transport
│   ⊃ OAuth 2.1 authentication (automatic)
│   ⊃ Read-only in initial release (Beta)
│
├── MCP Tools
│   ⊃ Search & navigate Vercel / Next.js / AI SDK docs
│   ⊃ List & inspect projects and deployments
│   ⊃ Query build logs and function invocation logs
│   ⊃ List domains and environment variables
│   ⊃ View team members and settings
│
├── Supported AI Clients
│   ⊃ Claude Code (`claude mcp add --transport http vercel https://mcp.vercel.com`)
│   ⊃ Cursor, VS Code (reviewed and approved clients)
│
└── Relationship to REST API
    → Uses Vercel REST API under the hood
    ↔ AI SDK MCP Client (@ai-sdk/mcp)

VERCEL REST API / @vercel/sdk               ⤳ skill: vercel-api  📖 docs: https://vercel.com/docs/rest-api
├── Endpoint Categories
│   ⊃ /v1/deployments — Create, list, inspect, cancel
│   ⊃ /v1/projects — CRUD, environment variables, domains
│   ⊃ /v1/teams — Members, billing, settings
│   ⊃ /v1/domains — Register, configure, transfer
│   ⊃ /v1/dns — Record management
│   ⊃ /v1/certs — SSL certificate management
│   ⊃ /v1/secrets — Secret management
│   ⊃ /v1/integrations — Marketplace integration management
│   ⊃ /v1/edge-config — Edge Config management
│   ⊃ /v1/firewall — WAF rule management
│
├── SDK (@vercel/sdk)
│   ⊃ TypeScript SDK for all API endpoints
│   ⊃ vercel.deployments, vercel.projects, etc.
│
└── Authentication
    ⊃ Bearer Token (personal or team)
    ⊃ OAuth (for integrations)
```

---

## 9. Marketplace

```
VERCEL MARKETPLACE                          ⤳ skill: marketplace  📖 docs: https://vercel.com/marketplace
├── Categories
│   ⊃ Databases (Neon, MongoDB, Supabase, PlanetScale)
│   ⊃ CMS (Sanity, Contentful, Storyblok)
│   ⊃ Auth (Clerk, Auth0)
│   ⊃ Payments (Stripe)
│   ⊃ Feature Flags (LaunchDarkly, Statsig)
│   ⊃ AI Agents (CodeRabbit, Corridor, Sourcery, Parallel)
│   ⊃ Storage (Upstash Redis, Cloudinary)
│   ⊃ Monitoring (Datadog, Sentry)
│
├── Features
│   ⊃ Unified billing
│   ⊃ One-click install
│   ⊃ Auto-provisioned environment variables
│   ⊃ CLI management (vercel integration add/list/open/remove)
│
└── Integration
    ↔ Vercel CLI (agent-friendly discovery)
    ↔ Vercel REST API (programmatic management)
    ↔ Environment Variables (auto-injected)
```

---

## 10. Decision Matrix — When to Use What

### Rendering Strategy
| Need | Use | Why |
|------|-----|-----|
| Static content, rarely changes | SSG (`generateStaticParams`) | Fastest, cached at edge |
| Static with periodic updates | ISR (`revalidate`) | Fresh enough, still fast |
| Per-request dynamic data | SSR (Server Components) | Always fresh, streamed |
| Mix of static shell + dynamic parts | Cache Components (`'use cache'`) | Best of both worlds |
| Real-time interactive UI | Client Components | Full browser API access |

### Data Mutations
| Need | Use | Why |
|------|-----|-----|
| Form submissions, in-app mutations | Server Actions | Integrated with caching, progressive enhancement |
| Public API, webhooks, large uploads | Route Handlers | REST semantics, streaming support |
| Scheduled tasks | Cron Jobs + Serverless Functions | Reliable scheduling |

### AI Features
| Need | Use | Why |
|------|-----|-----|
| Chat interface | AI SDK `useChat` + `streamText` | Streaming UI, provider-agnostic |
| Structured data extraction | AI SDK `generateObject` | Type-safe, schema-validated |
| Multi-step agent | AI SDK `Agent` class | Loop control, tool calling |
| Production agent (must not lose state) | Workflow DevKit `DurableAgent` | Survives crashes, observable |
| Model routing / failover | AI Gateway | Provider routing, cost tracking |
| Connect to external tools | AI SDK MCP Client | Standard protocol, OAuth |
| Agent needs live Vercel state | Vercel MCP Server | Read projects, deployments, logs via MCP |
| UI generation from prompts | v0 | Visual output, GitHub integration |

### Storage
| Need | Use | Why |
|------|-----|-----|
| File uploads, media | Vercel Blob | First-party, up to 5TB |
| Feature flags, A/B config | Edge Config | Ultra-low latency at edge |
| Relational database | Neon (via Marketplace) | Serverless Postgres, branching |
| Key-value cache | Upstash Redis (via Marketplace) | Serverless Redis, same billing |

### Build & Monorepo
| Need | Use | Why |
|------|-----|-----|
| Single Next.js app | Turbopack (default) | Fastest HMR, built-in |
| Monorepo with multiple apps/packages | Turborepo | Caching, parallelism, affected |
| Code quality enforcement in monorepo | Conformance | Automated best-practice checks |
| Non-Next.js framework | Framework-native bundler | Vercel adapters handle deploy |

### Security
| Need | Use | Why |
|------|-----|-----|
| DDoS protection | Vercel Firewall (automatic) | Always on, all plans |
| Custom traffic rules | WAF rules engine | Framework-aware, 300ms propagation |
| Bot blocking | Bot Filter | One-click, public beta |
| Rate limiting | WAF rate limiting | Per-endpoint control |
| OWASP protection | Managed rulesets (Enterprise) | Industry-standard rules |
| Compliance isolation (SOC2, HIPAA) | Secure Compute | Dedicated infrastructure, no shared tenancy |
| Tokenless CI/CD deployments | OIDC Federation | Short-lived tokens, no secrets to rotate |

### Functions
| Need | Use | Why |
|------|-----|-----|
| Standard server logic | Serverless Functions (Node.js) | Full Node.js, up to 14min (paid) |
| Ultra-low latency, simple logic | Edge Functions | <1ms cold start, global |
| Long-running with I/O waits | Fluid Compute | Shared instances, waitUntil |
| AI streaming responses | Streaming Functions | SSE, zero config |
| Scheduled execution | Cron Jobs | vercel.json schedule config |

### Disambiguation: Interception Compute

These three mechanisms all intercept or handle requests before your application logic runs.
Choose based on **where** the interception happens and **what** you need to do.

| Mechanism | Layer | Runtime | Use When | Avoid When |
|-----------|-------|---------|----------|------------|
| **Routing Middleware** (`middleware.ts` / platform-level) | Edge Network, before cache | V8 isolates (Web Standard APIs) | Auth checks, geo-redirects, A/B routing, header rewriting — any framework | You need Node.js APIs, heavy computation, or database access |
| **`proxy.ts`** (Next.js 16+) | Application layer, replaces `middleware.ts` | Node.js | Same use cases as Routing Middleware but you need `node:*` modules, ORM calls, or full Node.js compat | You're not on Next.js 16+; prefer Routing Middleware for non-Next.js frameworks |
| **Edge Functions** | Edge Network, handles the full request | V8 isolates (Web Standard APIs) | Ultra-low-latency API endpoints, simple compute at the edge, streaming responses | You need Node.js runtime, long execution times, or large dependencies |

> **Key distinction**: Routing Middleware and `proxy.ts` are *interceptors* — they rewrite, redirect, or annotate requests before the handler runs. Edge Functions *are* the handler — they produce the response. If you previously used Next.js `middleware.ts` and are upgrading to Next.js 16, rename to `proxy.ts` (see § Migration Awareness).

⤳ skill: routing-middleware — Platform-level request interception
⤳ skill: vercel-functions — Edge Functions and Serverless Functions
⤳ skill: nextjs — `proxy.ts` in Next.js 16

### Disambiguation: Caching Layers

Three distinct caching systems serve different purposes. They can be used independently or layered together.

| Mechanism | Scope | Invalidation | Use When | Avoid When |
|-----------|-------|-------------|----------|------------|
| **Next.js Cache** (`'use cache'`, `revalidate`, `revalidatePath/Tag`) | Per-route or per-component, framework-managed | Time-based (`revalidate: N`), on-demand (`revalidateTag()`, `revalidatePath()`) | Caching rendered pages, component trees, or data fetches within a Next.js app | You need caching outside Next.js, or need to cache arbitrary key-value data |
| **Runtime Cache** (Vercel platform, per-region KV) | Per-region key-value store, any framework | Tag-based (`purgeByTag()`), key-based (`delete()`) | Caching expensive computations, API responses, or shared data across functions — works with any framework on Vercel | You only need page-level caching (use Next.js Cache instead); you need global consistency (Runtime Cache is per-region) |
| **CDN Cache + Purge-by-Tag** (Edge Network, `Cache-Control` + `Cache-Tag` headers) | Global CDN edge, HTTP-level | `Cache-Control` TTL, on-demand purge via Vercel API (`POST /v1/edge-config/purge`) | Static assets, ISR pages, any HTTP response you want cached globally at the edge | Dynamic per-user content, responses that must never be stale |

> **Layering pattern**: A typical Next.js app uses all three — Next.js Cache for component/route-level freshness, Runtime Cache for shared cross-request data (e.g., product catalog), and CDN Cache for static assets and ISR pages. Each layer has its own invalidation strategy; tag-based invalidation can cascade across layers when configured.

⤳ skill: runtime-cache — Per-region key-value caching with tag-based invalidation
⤳ skill: nextjs — `'use cache'`, `revalidatePath`, `revalidateTag`

---

## 11. Common Cross-Product Workflows

### 1. Build an AI Chatbot
```
Next.js (App Router) → AI SDK (useChat + streamText) → AI Gateway (model routing)
                     → Vercel Functions (streaming) → Vercel Platform (deploy)
```

### 2. Build a Durable AI Agent
```
Next.js (API Route) → Workflow DevKit (DurableAgent) → AI SDK (tool calling)
                    → Neon Postgres (state) → Vercel Functions (step execution)
```

### 3. Full-Stack SaaS App
```
Next.js (App Router) → Neon Postgres (data) → Clerk (auth, via Marketplace)
                     → Stripe (payments, via Marketplace) → Vercel Blob (uploads)
                     → Edge Config (feature flags) → Vercel Analytics
```

### 4. Monorepo with Multiple Apps
```
Turborepo (orchestration) → Next.js App A → Vercel Platform (deploy)
                          → Next.js App B → Vercel Platform (deploy)
                          → Shared packages → Turbopack (bundling)
                          → Remote Cache → Vercel (shared across CI)
```

### 5. Deploy with Custom CI
```
Git Push → CI Pipeline → vercel build → vercel deploy --prebuilt
        → VERCEL_TOKEN auth → Preview URL → vercel promote (production)
```

---

## 12. Migration Awareness

| Deprecated | Replacement | Migration Path |
|-----------|-------------|----------------|
| `@vercel/postgres` | `@neondatabase/serverless` | Use `@neondatabase/vercel-postgres-compat` for drop-in |
| `@vercel/kv` | `@upstash/redis` | Same billing, direct replacement |
| `middleware.ts` (Next.js 16) | `proxy.ts` | Rename file, Node.js runtime only |
| `experimental.turbopack` | `turbopack` (top-level) | Move config in next.config |
| Sync Request APIs (Next.js 16) | Async Request APIs | `await cookies()`, `await headers()`, etc. |
| PPR (Next.js 15 canary) | Cache Components | Follow Vercel migration guide |
| AI SDK 5 | AI SDK 6 | Run `npx @ai-sdk/codemod v6` |
| `parameters` (AI SDK tools) | `inputSchema` | Aligned with MCP spec |
| `result` (AI SDK tools) | `output` | Aligned with MCP spec |

---

## Conventions

### Next.js 16

- Default to Server Components. Only add `'use client'` when you need interactivity or browser APIs.
- Push `'use client'` boundaries as far down the component tree as possible.
- Use Server Actions (`'use server'`) for data mutations, not Route Handlers (unless building a public API).
- All request APIs are async in Next.js 16: `await cookies()`, `await headers()`, `await params`, `await searchParams`.
- Use `proxy.ts` instead of `middleware.ts` (Next.js 16 rename). Proxy runs on Node.js runtime only.
- Turbopack config is top-level in `next.config.ts`, not under `experimental.turbopack`.
- Use Cache Components (`'use cache'`) instead of PPR for mixing static and dynamic content.
- Prefer `next/image` for images and `next/font` for fonts — both optimize automatically on Vercel.
- `@vercel/postgres` and `@vercel/kv` are sunset — use `@neondatabase/serverless` and `@upstash/redis`.

### AI SDK v6

- Use `inputSchema` (not `parameters`) and `output`/`outputSchema` (not `result`) for tool definitions — aligned with MCP spec.
- Always stream for user-facing AI: use `streamText` + `useChat`, not `generateText`.
- Use the `Agent` class for multi-step reasoning instead of manual tool-calling loops.
- Use `DurableAgent` from `@workflow/ai/agent` for production agents that must survive crashes.
- Reference models as `"provider/model"` (e.g., `"openai/gpt-5-mini"`) to use AI Gateway automatically.
- Use `@ai-sdk/mcp` (stable, not experimental) for MCP server connections.
- Use `mcp-to-ai-sdk` CLI to generate static tool definitions from MCP servers for security.
- Use AI SDK DevTools (`npx @ai-sdk/devtools`) during development for debugging.

### Vercel Platform

- Never hardcode secrets — use environment variables via `vercel env` or Marketplace auto-provisioning.
- Add `.env*.local` to `.gitignore` — these files contain pulled secrets.
- Use Fluid Compute for long-running functions — extends max duration to 800s on paid plans.
- Use `waitUntil` (or `after` in Next.js) for background work after sending a response.
- Configure cron jobs in `vercel.json` and verify with `CRON_SECRET` header.
- Use `vercel deploy --prebuilt` in CI for fastest deploys (separate build from deploy).
- For monorepos, use Turborepo with remote caching and `--affected` for efficient CI.
