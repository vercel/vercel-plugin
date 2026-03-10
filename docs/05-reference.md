# Reference

> **Audience**: All — developers, skill authors, maintainers. This section is the canonical lookup for every configurable surface in the Vercel Plugin.

---

## Table of Contents

1. [Hook Registry](#hook-registry)
2. [SyncHookJSONOutput Type Shape](#synchookjsonoutput-type-shape)
3. [Environment Variables](#environment-variables)
4. [SKILL.md Frontmatter Reference](#skillmd-frontmatter-reference)
5. [YAML Parser Edge Cases](#yaml-parser-edge-cases)
6. [Skill Catalog](#skill-catalog)
7. [Budget & Limit Constants](#budget--limit-constants)
8. [Cross-References](#cross-references)

---

## Hook Registry

Every hook registered in `hooks/hooks.json`. All hooks run via `node "${CLAUDE_PLUGIN_ROOT}/hooks/<file>.mjs"`.

| Event | Hook File | Matcher | Timeout | Description |
|-------|-----------|---------|---------|-------------|
| SessionStart | `session-start-seen-skills.mjs` | `startup\|resume\|clear\|compact` | — | Initializes `VERCEL_PLUGIN_SEEN_SKILLS=""` in the env file for dedup tracking |
| SessionStart | `session-start-profiler.mjs` | `startup\|resume\|clear\|compact` | — | Scans project config files + package deps → sets `VERCEL_PLUGIN_LIKELY_SKILLS` (+5 priority boost); detects greenfield mode |
| SessionStart | `inject-claude-md.mjs` | `startup\|resume\|clear\|compact` | — | Injects `vercel.md` ecosystem guide (~52KB) as additionalContext |
| PreToolUse | `pretooluse-skill-inject.mjs` | `Read\|Edit\|Write\|Bash` | 5s | **Main injection engine.** Pattern match → rank → dedup → budget enforcement (max 3 skills, 18KB) |
| PreToolUse | `pretooluse-subagent-spawn-observe.mjs` | `Agent` | 5s | **Observer.** Captures pending subagent spawn metadata to JSONL file |
| UserPromptSubmit | `user-prompt-submit-skill-inject.mjs` | *(all prompts)* | 5s | Prompt signal scoring engine — phrases, allOf, anyOf, noneOf → inject up to 2 skills within 8KB |
| PostToolUse | `posttooluse-shadcn-font-fix.mjs` | `Bash` | 5s | Fixes shadcn font loading issues by patching font import statements |
| PostToolUse | `posttooluse-verification-observe.mjs` | `Bash` | 5s | **Observer.** Classifies bash commands into verification boundaries (uiRender, clientRequest, serverHandler, environment) |
| PostToolUse | `posttooluse-validate.mjs` | `Write\|Edit` | 5s | Runs skill-defined validation rules on written/edited files; reports errors and warnings |
| SubagentStart | `subagent-start-bootstrap.mjs` | `.+` | 5s | Budget-aware context injection for subagents — scales by agent type (Explore ~1KB, Plan ~3KB, GP ~8KB) |
| SubagentStop | `subagent-stop-sync.mjs` | `.+` | 5s | **Observer.** Records subagent lifecycle metadata to JSONL ledger |
| SessionEnd | `session-end-cleanup.mjs` | *(always)* | — | Best-effort cleanup of all session-scoped temp files (dedup claims, profile cache, pending launches, ledger) |

### Shared Library Modules

These are imported by entry-point hooks, not registered in `hooks.json`:

| Module | Source | Purpose |
|--------|--------|---------|
| `hook-env.mts` | `hooks/src/hook-env.mts` | Shared runtime helpers: env file parsing, plugin root resolution, dedup claim operations (atomic O_EXCL), audit logging |
| `patterns.mts` | `hooks/src/patterns.mts` | Glob→regex conversion, path/bash/import matching with match reasons, ranking engine, dedup state merging |
| `prompt-patterns.mts` | `hooks/src/prompt-patterns.mts` | Prompt text normalization (contraction expansion), signal compilation, scoring, lexical fallback |
| `prompt-analysis.mts` | `hooks/src/prompt-analysis.mts` | Dry-run prompt analysis reports for debugging prompt matching |
| `skill-map-frontmatter.mts` | `hooks/src/skill-map-frontmatter.mts` | Inline YAML parser, frontmatter extraction, `buildSkillMap()`, `validateSkillMap()` |
| `logger.mts` | `hooks/src/logger.mts` | Structured JSON logging to stderr (off/summary/debug/trace levels) |
| `vercel-config.mts` | `hooks/src/vercel-config.mts` | Reads `vercel.json` keys → maps to skill routing adjustments (±10 priority) |
| `lexical-index.mts` | `hooks/src/lexical-index.mts` | MiniSearch-based lexical fallback index for fuzzy skill matching |
| `subagent-state.mts` | `hooks/src/subagent-state.mts` | File-locked JSONL operations for pending launches and agent-scoped dedup claims |
| `shared-contractions.mts` | `hooks/src/shared-contractions.mts` | Contraction expansion map shared across prompt normalizers |
| `stemmer.mts` | `hooks/src/stemmer.mts` | Lightweight word stemmer for lexical index tokenization |

---

## SyncHookJSONOutput Type Shape

All hooks output JSON conforming to the `SyncHookJSONOutput` type from `@anthropic-ai/claude-agent-sdk`. The shape varies by hook event:

```typescript
// Imported from @anthropic-ai/claude-agent-sdk
type SyncHookJSONOutput = {
  hookSpecificOutput?: {
    hookEventName: string;           // Must match the hook's event (e.g., "PreToolUse")
    additionalContext?: string;       // Markdown injected into Claude's context
    // Event-specific fields (see below)
  };
  envUpdate?: Record<string, string>; // Updates to CLAUDE_ENV_FILE
};
```

### Per-Event Output Shapes

**PreToolUse** (`pretooluse-skill-inject`):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "<!-- banner -->\n\n<skill content>\n<!-- skillInjection: {...} -->"
  }
}
```

**UserPromptSubmit** (`user-prompt-submit-skill-inject`):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<!-- banner -->\n\n<skill content>\n<!-- promptInjection: {...} -->"
  }
}
```

**PostToolUse** (`posttooluse-validate`):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "## Validation Results\n<violations>\n<!-- postValidation: {...} -->"
  }
}
```

**SubagentStart** (`subagent-start-bootstrap`):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": "<context scaled by agent type>"
  }
}
```

**Observer hooks** return empty output (no context injection):
```json
{}
```

### Metadata Comments

Injection hooks embed a hidden HTML comment in the additionalContext with structured metadata:

```
<!-- skillInjection: {"skills":["ai-sdk","nextjs"],"budget":18000,"used":12400} -->
<!-- promptInjection: {"skills":["workflow"],"score":8,"budget":8000} -->
<!-- postValidation: {"skill":"ai-sdk","errorCount":1,"warnCount":0} -->
```

These comments are invisible to the user but machine-parseable for debugging and testing.

---

## Environment Variables

All environment variables that influence plugin behavior. Set these in your shell or via `CLAUDE_ENV_FILE`.

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `VERCEL_PLUGIN_LOG_LEVEL` | `off` | `off` \| `summary` \| `debug` \| `trace` | Controls hook logging verbosity to stderr. `summary` shows per-invocation one-liners. `debug` adds match details. `trace` adds full input/output dumps |
| `VERCEL_PLUGIN_DEBUG` | — | `1` or unset | Legacy toggle: `1` maps to `debug` log level. Prefer `VERCEL_PLUGIN_LOG_LEVEL` |
| `VERCEL_PLUGIN_HOOK_DEBUG` | — | `1` or unset | Legacy toggle: `1` maps to `debug` log level. Prefer `VERCEL_PLUGIN_LOG_LEVEL` |
| `VERCEL_PLUGIN_SEEN_SKILLS` | `""` | comma-delimited string | Already-injected skills for this session. Initialized by `session-start-seen-skills`. Updated by injection hooks. Used for dedup |
| `VERCEL_PLUGIN_HOOK_DEDUP` | — | `off` or unset | Set to `off` to disable all deduplication. Skills may be injected multiple times. Useful for testing |
| `VERCEL_PLUGIN_LIKELY_SKILLS` | — | comma-delimited string | Skills identified by the profiler at session start. These receive a **+5 priority boost** during ranking |
| `VERCEL_PLUGIN_GREENFIELD` | — | `true` or unset | Set by profiler when project has no source files (only dot-directories). Triggers greenfield execution mode |
| `VERCEL_PLUGIN_INJECTION_BUDGET` | `18000` | integer (bytes) | Maximum total byte size of skill content injected per PreToolUse invocation |
| `VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET` | `8000` | integer (bytes) | Maximum total byte size of skill content injected per UserPromptSubmit invocation |
| `VERCEL_PLUGIN_REVIEW_THRESHOLD` | `3` | integer | Number of `.tsx` file edits before `react-best-practices` skill is automatically injected |
| `VERCEL_PLUGIN_TSX_EDIT_COUNT` | `0` | integer | Current count of `.tsx` edits in this session. Tracked by PreToolUse hook |
| `VERCEL_PLUGIN_AUDIT_LOG_FILE` | — | file path or `off` | Path to append structured audit log entries. Set to `off` to disable. Unset = no audit logging |

### Environment Variable Decision Tree

```
Is the plugin not injecting skills you expect?
├─ Check VERCEL_PLUGIN_LOG_LEVEL=debug for match details
├─ Check VERCEL_PLUGIN_SEEN_SKILLS — is the skill already claimed?
│  └─ Set VERCEL_PLUGIN_HOOK_DEDUP=off to test without dedup
├─ Check VERCEL_PLUGIN_LIKELY_SKILLS — is profiler detecting your stack?
└─ Check VERCEL_PLUGIN_INJECTION_BUDGET — is budget too small?

Is the plugin injecting too many skills?
├─ Lower VERCEL_PLUGIN_INJECTION_BUDGET (default 18000)
├─ Lower VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET (default 8000)
└─ Increase skill minScore thresholds in SKILL.md frontmatter

Is TSX review triggering too early/late?
└─ Adjust VERCEL_PLUGIN_REVIEW_THRESHOLD (default 3)
```

---

## SKILL.md Frontmatter Reference

Every skill lives in `skills/<name>/SKILL.md`. The file has YAML frontmatter (between `---` delimiters) followed by a markdown body.

### Complete Field Reference

```yaml
---
# Required fields
name: skill-slug                    # Unique identifier, must match directory name
description: "One-line description" # What this skill does (shown in catalogs)

# Optional top-level fields
summary: "Brief fallback text"      # Injected when full body exceeds budget
                                    # (typically 1-2 sentences)

# Metadata block (all fields optional)
metadata:
  priority: 6                       # Base injection priority (range: 2-9)
                                    #   2-3: Low priority (browser, marketplace)
                                    #   4-5: Standard (libraries, utilities)
                                    #   6-7: High (core Vercel features)
                                    #   8-9: Critical (AI SDK, functions, workflow)

  # Pattern matching — at least one pattern type should be defined
  pathPatterns:                     # File glob patterns (matched against tool target paths)
    - "vercel.json"                 #   Standard globs: *, **, ?, [abc]
    - "app/**/route.ts"             #   Compiled to regex at build time
    - "*.config.{js,ts,mjs}"        #   Brace expansion supported

  bashPatterns:                     # Regex patterns (matched against bash commands)
    - "\\bvercel\\s+deploy\\b"      #   Full regex syntax
    - "npx\\s+turbo"                #   Escaped for YAML string context

  importPatterns:                   # Package name patterns (matched against import/require)
    - "ai"                          #   Bare package names
    - "@vercel/blob"                #   Scoped packages
    - "next/.*"                     #   Regex subpath patterns

  # Prompt signal scoring (for UserPromptSubmit hook)
  promptSignals:
    phrases:                        # Exact substring matches (case-insensitive)
      - "cron job"                  #   Each match: +6 points
      - "scheduled task"

    allOf:                          # Groups where ALL terms must appear
      - ["deploy", "preview"]       #   Each satisfied group: +4 points
      - ["rollback", "production"]

    anyOf:                          # Optional boosters
      - "schedule"                  #   Each match: +1 point
      - "timer"                     #   Capped at +2 total from anyOf

    noneOf:                         # Hard suppressors
      - "unrelated term"            #   Any match: score → -Infinity (skill excluded)

    minScore: 6                     # Threshold to trigger injection (default: 6)

  # Post-write validation rules
  validate:
    - pattern: "require\\("         # Regex matched against written file content
      message: "Use ESM imports"    # Error/warning message shown to Claude
      severity: "error"             # "error" (must fix) or "warn" (suggestion)
      skipIfFileContains: "\"use server\"" # Optional: skip rule if file matches this regex

  # Retrieval metadata (for search/discovery tooling)
  retrieval:
    aliases:                        # Alternative names for this skill
      - "vercel-cron"
      - "scheduled-tasks"
    relatedSkills:                  # Skills commonly used together
      - "vercel-functions"
      - "env-vars"
---

# Skill Title

Markdown body goes here. This is the content injected into Claude's
context as additionalContext when the skill matches.
```

### Field Details

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique skill identifier. Must match the directory name under `skills/` |
| `description` | string | Yes | One-line description for catalogs and tooling |
| `summary` | string | No | Short fallback text injected when full body exceeds budget |
| `metadata.priority` | integer | No | Base injection priority. Range 2–9. Default varies by build. Higher = injected first |
| `metadata.pathPatterns` | string[] | No | Glob patterns matched against file paths in Read/Edit/Write tools |
| `metadata.bashPatterns` | string[] | No | Regex patterns matched against Bash tool commands |
| `metadata.importPatterns` | string[] | No | Package name patterns matched against import/require statements |
| `metadata.promptSignals` | object | No | Scoring rules for UserPromptSubmit matching (see below) |
| `metadata.promptSignals.phrases` | string[] | No | Exact substring matches. +6 points each |
| `metadata.promptSignals.allOf` | string[][] | No | AND-groups. +4 points per satisfied group |
| `metadata.promptSignals.anyOf` | string[] | No | Optional boosters. +1 each, capped at +2 |
| `metadata.promptSignals.noneOf` | string[] | No | Hard suppressors. Any match → score = -Infinity |
| `metadata.promptSignals.minScore` | integer | No | Minimum score to trigger injection. Default: 6 |
| `metadata.validate` | object[] | No | Post-write validation rules |
| `metadata.validate[].pattern` | string | Yes* | Regex matched against file content |
| `metadata.validate[].message` | string | Yes* | Error/warning message |
| `metadata.validate[].severity` | string | Yes* | `"error"` or `"warn"` |
| `metadata.validate[].skipIfFileContains` | string | No | Skip rule if file matches this regex |
| `metadata.retrieval` | object | No | Discovery metadata for search tooling |
| `metadata.retrieval.aliases` | string[] | No | Alternative names for the skill |
| `metadata.retrieval.relatedSkills` | string[] | No | Commonly co-used skills |

---

## YAML Parser Edge Cases

The plugin uses a custom inline `parseSimpleYaml` parser in `skill-map-frontmatter.mjs`, **not** the `js-yaml` library. This means some YAML constructs behave differently:

| Input | Expected (js-yaml) | Actual (parseSimpleYaml) |
|-------|---------------------|--------------------------|
| Bare `null` | JavaScript `null` | String `"null"` |
| Bare `true` | Boolean `true` | String `"true"` |
| Bare `false` | Boolean `false` | String `"false"` |
| Unclosed `[` array | Parse error | Treated as scalar string |
| Tab indentation | Usually accepted | **Explicit error** |

**Why?** The custom parser prioritizes safety and predictability for frontmatter parsing. Treating bare keywords as strings avoids accidental type coercion in skill metadata.

---

## Skill Catalog

All 45 skills, sorted by priority (highest first). Each skill lives in `skills/<name>/SKILL.md`.

| Skill | Priority | Description | Trigger Types |
|-------|----------|-------------|---------------|
| `workflow` | 9 | Vercel Workflow DevKit (WDK) — durable workflows, pause/resume, retries, step-based execution | path, bash, import, prompt |
| `ai-sdk` | 8 | Vercel AI SDK — chat, text generation, structured output, tool calling, agents, MCP, streaming | path, bash, import, prompt |
| `bootstrap` | 8 | Project bootstrapping orchestrator — linking, env provisioning, first-run setup | path, bash, import |
| `chat-sdk` | 8 | Vercel Chat SDK — multi-platform chat bots (Slack, Telegram, Teams, Discord, etc.) | path, bash, import, prompt |
| `investigation-mode` | 8 | Orchestrated debugging coordinator — logs → workflow → browser → deploy triage | path, bash, prompt |
| `vercel-functions` | 8 | Serverless/Edge Functions, Fluid Compute, streaming, Cron Jobs, runtime config | path, bash |
| `ai-gateway` | 7 | AI Gateway — model routing, provider failover, cost tracking, unified API | bash, import |
| `env-vars` | 7 | Environment variables — `.env` files, `vercel env`, OIDC tokens | path, bash |
| `vercel-api` | 7 | Vercel MCP and REST API — projects, deployments, domains, logs | path, bash |
| `vercel-storage` | 7 | Storage — Blob, Edge Config, Neon Postgres, Upstash Redis | path, bash, import |
| `verification` | 7 | Full-story verification — browser + server + data flow + env | bash, prompt |
| `auth` | 6 | Authentication — Clerk, Descope, Auth0 with Next.js | path, bash |
| `ai-generation-persistence` | 6 | AI generation persistence — unique IDs, DB/Blob storage, addressable URLs, cost tracking | path, import, prompt |
| `cron-jobs` | 6 | Cron Jobs configuration and best practices | path |
| `deployments-cicd` | 6 | Deployments and CI/CD — deploy, promote, rollback, `--prebuilt`, workflow files | path, bash |
| `next-forge` | 6 | next-forge monorepo SaaS starter (Turborepo, Clerk, Prisma/Neon, Stripe) | path, bash, import, prompt |
| `observability` | 6 | Observability — Drains, Web Analytics, Speed Insights, OpenTelemetry | path, bash, prompt |
| `routing-middleware` | 6 | Routing Middleware — request interception, rewrites, redirects, personalization | path, bash |
| `runtime-cache` | 6 | Runtime Cache API — ephemeral per-region key-value cache with tag invalidation | path, bash |
| `shadcn` | 6 | shadcn/ui — CLI, component installation, composition, custom registries, theming | path, bash |
| `sign-in-with-vercel` | 6 | Sign in with Vercel — OAuth 2.0/OIDC identity provider | path |
| `vercel-flags` | 6 | Feature flags — dashboard, Flags Explorer, gradual rollouts, A/B testing | path, bash, import |
| `ai-elements` | 5 | AI Elements — pre-built React components for AI interfaces (chat UIs, tool calls) | path, bash, import, prompt |
| `nextjs` | 5 | Next.js App Router — routing, Server Components, Server Actions, middleware | path, bash, prompt |
| `payments` | 5 | Stripe payments — Marketplace setup, checkout sessions, webhooks, subscriptions | path, bash |
| `turborepo` | 5 | Turborepo — monorepo builds, task caching, remote caching, `--affected` | path, bash |
| `v0-dev` | 5 | v0 by Vercel — AI code generation, UI from prompts, v0 CLI and SDK | bash, import, prompt |
| `vercel-firewall` | 5 | Firewall and security — DDoS, WAF, rate limiting, bot filtering, OWASP | path, bash, prompt |
| `vercel-queues` | 5 | Queues (public beta) — durable event streaming, topics, consumer groups | path, bash, import |
| `cms` | 4 | Headless CMS — Sanity, Contentful, DatoCMS, Storyblok, Builder.io | path, bash |
| `edge-runtime` | 4 | Edge Runtime — lightweight JS runtime for Edge Functions and Middleware | path, bash, import, prompt |
| `email` | 4 | Email — Resend with React Email templates | path, bash |
| `geist` | 4 | Geist typography — Sans, Mono, Pixel font configuration | path, bash, import |
| `json-render` | 4 | AI chat response rendering — UIMessage parts, tool calls, streaming states | path |
| `micro` | 4 | micro — async HTTP microservices framework | bash, import |
| `ncc` | 4 | @vercel/ncc — compile Node.js modules into a single file | bash, import |
| `react-best-practices` | 4 | React best-practices reviewer — hooks, a11y, performance, TypeScript patterns | path, import |
| `satori` | 4 | Satori — HTML/CSS to SVG for dynamic OG images | path, bash, import |
| `swr` | 4 | SWR — client-side data fetching, caching, revalidation, mutations | path, bash, import, prompt |
| `turbopack` | 4 | Turbopack — Next.js bundler, HMR, build debugging | path, bash |
| `vercel-agent` | 4 | Vercel Agent — AI code review, incident investigation, SDK installation | path, bash |
| `vercel-cli` | 4 | Vercel CLI — deploy, env, link, logs, domains | path, bash, prompt |
| `vercel-sandbox` | 4 | Sandbox — ephemeral Firecracker microVMs for untrusted code | bash, import, prompt |
| `agent-browser` | 3 | Browser automation CLI for AI agents | path, bash |
| `marketplace` | 3 | Marketplace — discovering, installing, and building integrations | path, bash |
| `agent-browser-verify` | 2 | Automated browser verification for dev servers | bash, prompt |

### Trigger Type Legend

| Trigger | Hook | Matching Method |
|---------|------|-----------------|
| **path** | PreToolUse | File glob patterns matched against Read/Edit/Write tool targets |
| **bash** | PreToolUse | Regex patterns matched against Bash tool commands |
| **import** | PreToolUse | Package patterns matched against import/require statements in file content |
| **prompt** | UserPromptSubmit | Phrase/allOf/anyOf/noneOf scoring against user prompt text |

---

## Budget & Limit Constants

| Constant | Default | Configurable Via | Description |
|----------|---------|------------------|-------------|
| PreToolUse byte budget | 18,000 bytes | `VERCEL_PLUGIN_INJECTION_BUDGET` | Max total skill content per PreToolUse invocation |
| PreToolUse skill cap | 3 skills | — | Max number of skills injected per PreToolUse |
| UserPromptSubmit byte budget | 8,000 bytes | `VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET` | Max total skill content per UserPromptSubmit |
| UserPromptSubmit skill cap | 2 skills | — | Max skills injected per UserPromptSubmit |
| SubagentStart (Explore) | ~1,000 bytes | — | Skill names + profile summary only |
| SubagentStart (Plan) | ~3,000 bytes | — | Summaries + deployment constraints |
| SubagentStart (general-purpose) | ~8,000 bytes | — | Full skill bodies with summary fallback |
| TSX review threshold | 3 edits | `VERCEL_PLUGIN_REVIEW_THRESHOLD` | `.tsx` edits before injecting `react-best-practices` |
| Profiler boost | +5 priority | — | Added to skills listed in `VERCEL_PLUGIN_LIKELY_SKILLS` |
| vercel.json routing | ±10 priority | — | Added/subtracted based on vercel.json key→skill mappings |
| Prompt phrase score | +6 | — | Per matching phrase in `promptSignals.phrases` |
| Prompt allOf score | +4 | — | Per satisfied group in `promptSignals.allOf` |
| Prompt anyOf score | +1 (cap +2) | — | Per matching term in `promptSignals.anyOf` |
| Default minScore | 6 | Per-skill `promptSignals.minScore` | Threshold for prompt-based injection |
| Hook timeout | 5 seconds | — | Maximum execution time for all timed hooks |

---

## Cross-References

- **Section 1**: [Architecture Overview](./01-architecture-overview.md) — system diagram, core concepts, hook lifecycle, glossary
- **Section 2**: [Injection Pipeline Deep-Dive](./02-injection-pipeline.md) — pattern matching, ranking, budget enforcement, prompt signal scoring
- **Section 3**: [Skill Authoring Guide](./03-skill-authoring.md) — creating, testing, and validating new skills
- **Section 4**: [Operations & Debugging](./04-operations-debugging.md) — environment variables, log levels, `doctor`/`explain` CLI, dedup troubleshooting
