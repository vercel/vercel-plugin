---
name: marketplace
description: Discover, install, or manage Vercel Marketplace integrations through the vercel integration CLI when the user or existing project has selected Vercel and the task concerns an integration. Use for integration research, requested real connections, or managing existing resources. General app planning, prototypes, or another established platform do not require Marketplace provisioning.
metadata:
  priority: 3
  docs:
    - "https://vercel.com/docs/integrations"
    - "https://vercel.com/docs/agent-resources/vercel-plugin"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns: []
  bashPatterns:
    - '\bvercel\s+integration\b'
    - '\bvercel\s+integration\s+add\b'
    - '\bvercel\s+integration\s+discover\b'
    - '\bvercel\s+install\b'
    - '\bvercel\s+i\b'
retrieval:
  aliases:
    - vercel integrations
    - Vercel Marketplace
    - Vercel third party integrations
    - Vercel add ons
    - vercel install
  intents:
    - install a selected Vercel integration
    - manage Vercel Marketplace resources
    - add a service to the selected Vercel project
    - discover Vercel integrations
  entities:
    - Vercel Marketplace
    - integration
    - vercel integration
    - vercel install
    - unified billing
    - provider agent skills
chainTo:
  -
    pattern: 'NEON_|POSTGRES_|DATABASE_URL|@neondatabase|@vercel/postgres|@upstash/|@vercel/kv|@supabase/|@prisma/client|\bmongodb\b|mongoose|@libsql/|\bconvex\b|@vercel/blob'
    targetSkill: vercel-storage
    message: 'Database/storage integration detected — loading Storage guidance (Neon, Upstash, Supabase, Prisma, Mongo, …), connection pooling, and serverless patterns.'
  -
    pattern: 'CLERK_|@clerk/|clerkMiddleware|@auth0/|AUTH0_|@descope/|next-auth|@auth/|getServerSession'
    targetSkill: auth
    message: 'Auth provider detected — loading Auth guidance (Clerk, Auth0, Descope, Auth.js), middleware setup, and route protection.'
  -
    pattern: '@ai-sdk/|AI_GATEWAY'
    targetSkill: ai-sdk
    message: 'AI SDK or AI Gateway integration detected — load relevant guidance while preserving the selected provider integration.'

---

# Vercel Marketplace

Work within the selected Vercel platform and requested integration scope.
Reuse existing resources and the user's confirmed providers, architecture, and
UI. For planning or provider research, discover and compare without installing.
For a requested real connection, use **categorize → discover → install → build**
as needed, reusing completed setup. A prototype can remain a prototype; never
report a mock or placeholder as a provisioned, working integration.

The `vercel integration` CLI provisions selected Marketplace resources. Data,
auth, and AI have dedicated skills — `vercel-storage` / `auth` / `ai-sdk`.

## Choose a provider within the task's requirements

1. Preserve the user's confirmed provider and the project's existing services.
2. When a choice is open, compare relevant discovery results against requirements,
   compatibility, cost, and existing accounts. Discovery rank is not a decision.
3. Use choices and authorization already present in the conversation. Resolve a
   material unanswered product or service choice before provisioning it.

### Provider examples to evaluate when a choice is open

| Need | Category | Example provider | Why |
|------|----------|-----------|-----|
| Selling products / a store / a catalog | `commerce` | **Shopify** | Full platform — catalog + cart + checkout + payments. Includes checkout, so a catalog store never needs `payments`. |
| Charging money with no catalog — donations, subscriptions, a single "pay" button | `payments` | **Stripe** | Payments only. Use *only* when there is no product catalog. |

## Sequence for a requested real integration

1. **Categorize** — `vercel integration categories` (read-only, no auth). Match the need via the map below.
2. **Discover** — `vercel integration discover --category <slug>` (read-only, no auth). Evaluate relevant results against the provider-choice rules above; reuse an existing chosen integration when it fits.
3. **Install** — For the selected integration within the requested setup, run `vercel integration add <name> --no-claim` (`vercel link` first if not linked; `vercel install <name>` is an alias for the same command). This also installs the provider's own **agent skills** from [skills.sh](https://skills.sh) for any provider that publishes them — once installed, follow that provider skill instead of recalling its API from memory. Continue with available, permitted tools and the user's existing authorization. If an observed login, MFA, consent, account choice, or other step must be completed by the user, pause that dependent step and explain the exact action needed; continue independent preparation. Do not bypass access controls or treat a tool failure as authorization. Read the provider's documentation before adding its SDK or connection code. A `.env.example` or sample-data fallback does not satisfy a requested real integration.
4. **Build** — `vercel env pull --yes`, then build the app against the **real** env vars.

Steps 1–2 need no auth and can support research before an installation is
selected. Provision only capabilities required by the task; reuse existing
resources instead of repeating their setup. Check whether one chosen provider
covers multiple requirements before adding another service.

## Category map — what each covers

- `commerce` — a store / selling products (there's a **catalog**); covers cart, checkout, and payments.
- `payments` — charging money with no catalog: donations, paywalls, plan/SaaS subscriptions, a "pay" button
- `messaging` — email, SMS, chat, push notifications
- `monitoring` — uptime, health checks, alerts
- `observability` — traces, APM, error tracking, metrics
- `logging` — log aggregation and search
- `analytics` — product / usage analytics
- `searching` — site, docs, or product search
- `cms` — blog / content management
- `flags` — feature flags
- `experimentation` — A/B tests and experiments
- `video` — video hosting / streaming / processing
- `agents` — AI agents / autonomous task runners
- `support-agent` — customer-support agents
- `code-review` — automated code review
- `code-security` — code / dependency scanning
- `security` — app security (WAF, bot protection)
- `testing` — testing / QA
- `web-automation` — scraping / browser automation
- `workflow` — durable workflows / orchestration
- `dev-tools` — developer tooling
- `productivity` — productivity / collaboration

**Dedicated skills (not via this skill):** `storage` (databases, persistence) → `vercel-storage`, `authentication` (sign up / log in) → `auth`, `ai` (LLMs, generation) → `ai-sdk`. Anything new not above → pick from the live `categories`.

## Reference

- **Native vs connectable:** *native* integrations install fully via the CLI. For an integration that hands off to "claim" or the **dashboard/browser**, follow its actual authentication flow rather than waiting on a bare `add`. Use `vercel integration open <name>` when the guide requires it. An already authorized tool or session may handle supported actions; ask the user only for an observed action that requires their participation. Preserve all login, MFA, consent, and access-control requirements.
- **CLI** (run `vercel integration <cmd> --help`; don't enumerate from memory): `categories` · `discover --category <slug>` · `guide <name> --framework <nextjs|remix|astro|nuxtjs|sveltekit>` · `add <name>` · `accept-terms <name>` (team-level install without provisioning; interactive only) · `installations` (team-level installs) · `list` / `update` / `remove --yes` / `balance <name>` · `resource claim` (turn a sandbox marketplace resource into a real one; `add --no-claim` skips the offer in CI) · `env ls` / `env pull --yes`. `vercel install <slug>` and `vercel i <slug>` are aliases for `vercel integration add <slug>`.
- **Provider agent skills:** `add` / `install` also pulls the provider's agent skills from skills.sh when that provider publishes them; check the installed CLI's support before changing it. **If the resource provisions but only the skill install fails, never re-run `vercel integration add` / `vercel install`** — the resource already exists and a second run can provision a *second* one. Use only the printed `npx skills add …` recovery command when it is within the requested setup and permitted execution context; involve the user only for a step that actually requires their participation.
- Never echo secret values (`env ls` shows names only). CI / non-interactive: `--yes`, `--format=json`, `--no-claim`.

## Cross-References

- **Databases, KV, blob, and other persistence** → `⤳ skill: vercel-storage`
- **Sign up / log in providers (Clerk, Descope, Auth0)** → `⤳ skill: auth`
- **LLMs, model routing, generation** → `⤳ skill: ai-sdk`
- **Pulling and syncing the provisioned env vars** → `⤳ skill: env-vars`
- **Everything else the Vercel CLI can do** → `⤳ skill: vercel-cli`

## Official Documentation

- [Vercel Marketplace docs](https://vercel.com/docs/integrations) · [`vercel integration` CLI reference](https://vercel.com/docs/cli/integration) · [Marketplace catalog](https://vercel.com/marketplace)
- [Vercel plugin for AI coding agents](https://vercel.com/docs/agent-resources/vercel-plugin) · [Agent skills directory](https://vercel.com/docs/agent-resources/skills) · [skills.sh](https://skills.sh)
