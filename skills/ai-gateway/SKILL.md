---
name: ai-gateway
description: Vercel AI Gateway guidance for setup, model discovery, authentication, routing, fallbacks, BYOK, budgets, spend reporting, observability, compatible APIs, and coding-agent configuration. Use when adding AI Gateway to an app, migrating provider calls, choosing models or providers, debugging gateway requests, or running `vercel ai-gateway` commands.
summary: Set up and operate Vercel AI Gateway with current models, correct authentication, routing, spend controls, and verification.
metadata:
  priority: 7
  docs:
    - "https://vercel.com/docs/ai-gateway"
    - "https://vercel.com/docs/ai-gateway/getting-started"
    - "https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway"
  sitemap: "https://vercel.com/docs/sitemap.md"
  pathPatterns: []
  importPatterns:
    - 'ai'
    - '@ai-sdk/gateway'
  bashPatterns:
    - '\bvercel\s+ai-gateway\b'
    - '\bvercel\s+env\s+pull\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@ai-sdk/gateway\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@ai-sdk/gateway\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@ai-sdk/gateway\b'
    - '\byarn\s+add\s+[^\n]*@ai-sdk/gateway\b'
  promptSignals:
    phrases:
      - "ai gateway"
      - "vercel ai gateway"
      - "ai-gateway"
      - "ai-gateway.vercel.sh"
    allOf:
      - [model, routing]
      - [provider, failover]
      - [gateway, budget]
      - [gateway, logs]
      - [gateway, oidc]
      - [coding, gateway]
    anyOf:
      - "provider ordering"
      - "model fallback"
      - "byok"
      - "spend tracking"
      - "gateway key"
      - "credit balance"
      - "safety identifier"
      - "reasoning effort"
      - "tool calling"
      - "structured outputs"
    noneOf:
      - "cloudflare ai gateway"
      - "aws api gateway"
    minScore: 6
validate:
  -
    pattern: '\bclaude-(sonnet|opus|haiku)-\d+-\d+\b'
    message: 'Claude model version uses a hyphen where the AI Gateway slug uses a dot. Fetch /v1/models and use the returned provider/model ID.'
    severity: error
  -
    pattern: gateway\(['"][^'"/]+['"]\)
    message: 'AI Gateway model string is missing its provider prefix. Fetch /v1/models and use a provider/model ID.'
    severity: error
  -
    pattern: (OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY)
    message: 'Provider key detected. AI Gateway request authentication uses AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN; provider keys belong only in an intentional BYOK configuration.'
    severity: recommended
    skipIfFileContains: '[Bb][Yy][Oo][Kk]|providerOptions\s*:\s*\{[^}]*gateway'
  -
    pattern: gateway\s*:\s*\{[^}]*cacheControl
    message: "AI Gateway does not cache whole responses through cacheControl. Use caching: 'auto' for provider prompt caching and verify the current caching docs."
    severity: error
  -
    pattern: ANTHROPIC_BASE_URL\s*=\s*["']?https://ai-gateway\.vercel\.sh
    message: 'Claude Code through AI Gateway needs ANTHROPIC_API_KEY set to an empty value and the gateway key in ANTHROPIC_AUTH_TOKEN. A non-empty ANTHROPIC_API_KEY is used instead of the gateway token.'
    severity: recommended
    skipIfFileContains: 'ANTHROPIC_AUTH_TOKEN'
chainTo:
  -
    pattern: 'from\s+[''"]ai[''"]|require\([''"]ai[''"]\)|\b(generateText|streamText|ToolLoopAgent)\b'
    targetSkill: ai-sdk
    message: 'AI SDK code detected. Load the AI SDK skill and read the installed package docs before writing or changing SDK code.'
retrieval:
  aliases:
    - model router
    - ai proxy
    - provider failover
    - llm gateway
    - gateway credits
  intents:
    - add Vercel AI Gateway to an application
    - route AI models across providers
    - configure provider or model fallbacks
    - authenticate AI Gateway requests
    - track AI model costs and set budgets
    - debug AI Gateway requests and routing
    - connect coding agents to AI Gateway
    - find a model by modality, capability, price, or data retention
    - check AI Gateway credit balance or generation cost
    - configure reasoning or extended thinking across providers and API formats
    - add tool calling or function calling across API formats
    - get structured JSON output matching a schema
    - send images or PDFs to a model
  entities:
    - AI Gateway
    - AI Gateway Credits
    - providerOptions.gateway
    - AI_GATEWAY_API_KEY
    - VERCEL_OIDC_TOKEN
    - model routing
    - provider failover
    - BYOK
    - spend reporting
    - safetyIdentifier
    - Usage & Billing API
---

# Vercel AI Gateway

AI Gateway exposes models from multiple providers through shared authentication, model IDs, routing, billing, and observability. Model availability, SDK APIs, CLI commands, prices, and product capabilities change frequently. Verify them from current sources before changing code.

## Start with current sources

Before implementing:

1. Inspect the project's language, package manager, installed AI SDK version, and existing provider integration.
2. Read the relevant Vercel page under <https://vercel.com/docs/ai-gateway>. Use the page's `.md` form when a tool needs Markdown.
3. Fetch the complete live model list. Do not construct model variants by analogy:

   ```bash
   curl -fsSL https://ai-gateway.vercel.sh/v1/models
   ```

4. If the code uses the `ai` package, load the `ai-sdk` skill when available. Read version-matched docs under `node_modules/ai/docs/` and source under `node_modules/ai/src/`. If the skill is not installed, use those bundled files directly.
5. Run `vercel ai-gateway <command> --help` before documenting or scripting CLI flags.

The live model endpoint and installed package take precedence over model names or SDK syntax remembered from training data.

## Vercel CLI inventory

The `vercel ai-gateway` command manages gateway resources for the current team. Agents often discover only `coding-agents setup`; the rest of the CLI covers the jobs that previously required dashboard work:

| Command | What it does |
| --- | --- |
| `api-keys create/list/inspect/remove` | Create and manage AI Gateway API keys, with budgets, spend alerts, expiry, and restriction exemptions |
| `budgets set/list/inspect/remove` | Set metered spend limits for the team, a project, a user, or an API key |
| `budgets defaults set/list/remove` | Set per-scope default limits covering projects, keys, or members without a custom budget |
| `models list` / `models endpoints <model>` | List the model catalog and one model's provider endpoints from the CLI |
| `rules add/list/edit/remove` | Manage routing rules; the CLI marks rules beta, so check `--help` before relying on them. REST CRUD exists under `/v1/ai-gateway/rules` |
| `coding-agents setup` | Configure supported coding agents; see [references/coding-agents.md](references/coding-agents.md) |
| `leaderboard` | Explore public, anonymized usage leaderboards; rarely needed for implementation work |

Use the CLI for credential and spend management when the user is working from a terminal or in CI. Check `vercel ai-gateway <command> --help` for current flags before scripting; do not copy a flag list from this skill into generated code.

## Route the request to the right guide

| User's job | Read |
| --- | --- |
| First request, credentials, compatible SDKs, or migration | [references/setup.md](references/setup.md) |
| Provider selection, model fallbacks, caching, BYOK, or timeouts | [references/routing.md](references/routing.md) |
| Credits, budgets, reporting, Logs, or request debugging | [references/spend-observability.md](references/spend-observability.md) |
| Claude Code, Codex, OpenCode, Pi, or another coding agent | [references/coding-agents.md](references/coding-agents.md) |

Read each relevant reference before editing. A task can require more than one.

## Choose the integration surface

| Existing project | Default path |
| --- | --- |
| JavaScript or TypeScript using AI SDK | Use a plain `provider/model` string with `generateText`, `streamText`, `ToolLoopAgent`, or the relevant modality API |
| Python using AI SDK for Python | Use `ai.get_model('provider/model')` and the current Python SDK docs |
| Existing OpenAI SDK | Keep the SDK and point `baseURL` or `base_url` to `https://ai-gateway.vercel.sh/v1` |
| Existing Anthropic SDK | Keep the SDK and point `baseURL` or `base_url` to `https://ai-gateway.vercel.sh` |
| Provider-neutral HTTP | Use an AI Gateway compatible endpoint, such as Chat Completions or OpenResponses |
| Existing direct-provider AI SDK integration | Replace the provider instance with a live AI Gateway `provider/model` string, then remove provider credentials only after verifying the gateway path |
| Coding agent | Use `vercel ai-gateway coding-agents setup`; inspect its help before claiming agent support |

AI Gateway also supports OpenAI Responses, Anthropic Messages, OpenResponses, Cohere Rerank, embeddings, image and video generation, speech, transcription, and realtime sessions. Modality pages under <https://vercel.com/docs/ai-gateway/modalities> cover each request shape, including background jobs for long-running video generation. Read the relevant modality or API page instead of translating one request shape from memory.

## Minimal AI SDK request

The current AI SDK requires Node.js 22 or later. Confirm the installed package's `engines` field before enforcing a version in an existing project.

```ts
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.6-sol',
  prompt: 'Explain the project in one paragraph.',
});

console.log(text);
```

The model is a current example, not a permanent default. Fetch `/v1/models` and choose a model that fits the requested modality, capabilities, price, context window, data-retention policy, and team access.

Plain model strings route through AI Gateway. Add `@ai-sdk/gateway` only when the task needs its exported provider, types, model discovery, generation lookup, or spend-report helpers.

## Authentication decision

- Use an **AI Gateway API key** for local scripts, CI, external servers, and non-Vercel deployments. Store it in `AI_GATEWAY_API_KEY` and never print or commit it.
- Use **Vercel OIDC** for Vercel deployments and linked local projects. Vercel deployments receive `VERCEL_OIDC_TOKEN`; local development uses `vercel link` and `vercel env pull`.
- **BYOK provider credentials do not replace AI Gateway request authentication.** They decide how AI Gateway authenticates to a model provider.
- A plain Node.js script does not automatically load `.env.local`. Export variables in the shell or load that file explicitly. Framework behavior may differ.

Do not ask the user to paste a secret into chat, source code, a committed config file, or a command that will enter shell history unless the repository has an established secure mechanism.

## Implementation workflow

1. Establish the user's job, runtime, deployment target, current provider, and required capabilities.
2. Select authentication from the rules above. Preserve a working existing method unless the user asked to migrate it.
3. Fetch live model metadata and choose a compatible model. State why it fits.
4. Read the matching SDK, API, modality, routing, or coding-agent docs.
5. Make the smallest end-to-end change. Reuse the current project structure and error handling.
6. Handle only errors the application can act on. Common gateway outcomes include authentication failure, insufficient credits, budget exhaustion, rate limiting, and provider capacity failure.
7. Run the project's formatter, type checker, and focused tests.
8. When the task authorizes a live request, run one and inspect the returned model, text or media, usage, and provider metadata.
9. Verify the request in AI Gateway Logs when dashboard access is available. Logs can take about 90 seconds to ingest.

Only spend credits, create keys, change budgets, change routing rules, or write coding-agent config when the user requested or approved that outward-facing action. Prefer dry runs and interactive previews when available.

## Routing invariants

- Model IDs use the exact `provider/model` strings returned by `/v1/models`.
- `order` controls provider preference, `only` restricts providers, and `sort` ranks providers by a supported metric.
- `models` lists fallback models after the primary model.
- `caching: 'auto'` manages provider prompt-cache markers. It is not an HTTP response cache.
- `providerTimeouts` applies to BYOK provider attempts and measures time until the provider starts responding.
- A reasoning entry in `providerOptions` overrides the AI SDK top-level `reasoning` value entirely; the two never merge.
- `user` and `tags` attach reporting dimensions. They do not create per-user rate limits.
- Request-scoped provider credentials belong under `providerOptions.gateway.byok` and must remain secret.

Read [references/routing.md](references/routing.md) before adding any of these fields.

## Verification checklist

- [ ] The model ID exists in the full live model response.
- [ ] The selected API or SDK supports the requested modality and feature.
- [ ] Authentication works in the actual runtime, including `.env.local` loading where relevant.
- [ ] The example prints or returns a result instead of discarding the response.
- [ ] The project type checker and focused tests pass.
- [ ] A live request was made only when authorized, and its cost was understood.
- [ ] Provider routing or fallback behavior is visible in response metadata or Logs.
- [ ] No secret appears in source, logs, diffs, or the final response.
- [ ] The final report distinguishes code verification from live and dashboard verification.

## Current documentation

- Getting started: <https://vercel.com/docs/ai-gateway/getting-started>
- Models and providers: <https://vercel.com/docs/ai-gateway/models-and-providers>
- SDKs and APIs: <https://vercel.com/docs/ai-gateway/sdks-and-apis>
- Authentication and BYOK: <https://vercel.com/docs/ai-gateway/authentication-and-byok>
- Observability and spend: <https://vercel.com/docs/ai-gateway/observability-and-spend>
- Modalities: <https://vercel.com/docs/ai-gateway/modalities>
- REST API reference: <https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api>
- FAQ: <https://vercel.com/docs/ai-gateway/faq>
- Coding agents: <https://vercel.com/docs/ai-gateway/coding-agents>
- AI SDK provider: <https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway>
