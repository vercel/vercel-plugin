# Models, routing, caching, BYOK, and timeouts

Read current docs and fetch live model metadata before adding routing policy. These controls change request consequences and can affect cost, data handling, and availability.

## Model discovery

```bash
curl -fsSL https://ai-gateway.vercel.sh/v1/models
```

The public list includes model IDs, modalities, capabilities, context windows, and pricing. Use the full response. Filter it after fetching rather than truncating before inspection.

For provider endpoints serving one model:

```text
GET https://ai-gateway.vercel.sh/v1/models/{creator}/{model}/endpoints
```

The AI SDK provider also exposes current catalog helpers. Read the installed SDK docs for exact method names and types.

Choose based on:

- requested modality and API specification
- required capabilities, such as tools, reasoning, image input, or implicit caching
- context and output limits
- team plan and model access
- price and service tier
- Zero Data Retention (ZDR), no-training, HIPAA, and region requirements
- provider availability and measured performance

Never choose a permanent default only because its semantic version looks newest.

## Provider filtering, ordering, and sorting

```ts
providerOptions: {
  gateway: {
    order: ['bedrock', 'anthropic'],
    only: ['bedrock', 'anthropic'],
    sort: 'cost',
  },
},
```

- `order` tries providers in the listed order.
- `only` creates a hard provider allowlist.
- `sort` ranks eligible providers by `cost`, time to first token (`ttft`), or throughput (`tps`).

Use only supported provider identifiers from current model endpoint data. Provider availability varies by model.

Docs: <https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering>

## Model fallbacks

```ts
providerOptions: {
  gateway: {
    models: [
      'anthropic/claude-opus-5',
      'google/gemini-3.1-pro-preview',
    ],
  },
},
```

The primary `model` is attempted first. If all eligible providers for it fail, AI Gateway tries each entry in `models` in order. Provider policy such as `order` or `only` applies to each model.

Do not imply that fallback is limited to one provider error class. Inspect current provider metadata and Logs to verify which model and provider succeeded.

Docs: <https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks>

## Automatic prompt caching

```ts
providerOptions: {
  gateway: {
    caching: 'auto',
  },
},
```

`caching: 'auto'` adds provider prompt-cache markers for explicit-caching providers such as Anthropic and MiniMax. Providers such as OpenAI, Google, and DeepSeek can cache implicitly without request modification.

This is prompt caching. It does not cache a complete AI response, accept HTTP `Cache-Control` semantics, or guarantee a cache hit. Cache reads and writes appear in token usage.

Automatic caching has a write premium for explicit-caching providers and benefits multi-turn or repeated-prefix traffic. It can cost more for a true one-shot request.

Responses API requests can also use current cache anchor and lifetime fields. Read the documentation before adding them.

Docs: <https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching>

## Request-scoped BYOK

```ts
providerOptions: {
  gateway: {
    byok: {
      anthropic: [{ apiKey: process.env.ANTHROPIC_API_KEY }],
    },
  },
},
```

BYOK credentials authenticate AI Gateway to a provider. The request still needs an AI Gateway API key or OIDC token. Never log or return the provider credential.

A request may fall back from BYOK credentials to AI Gateway system credentials, depending on routing and credential availability. System-credential attempts use AI Gateway Credits. Read the BYOK page before promising credential precedence.

Dashboard-configured BYOK is team-scoped. Request-scoped BYOK places credentials in one request and should be used only when the application already handles the secret securely.

Docs: <https://vercel.com/docs/ai-gateway/authentication-and-byok/byok>

## Provider timeouts

Provider timeouts currently apply to BYOK provider attempts and measure time until the provider starts responding. Values are milliseconds from 1,000 through 789,000.

```ts
providerOptions: {
  gateway: {
    providerTimeouts: {
      byok: {
        anthropic: 10000,
        bedrock: 15000,
      },
    },
  },
},
```

Once the first token arrives, including a reasoning token, the timeout is cleared. Some providers may continue billing a timed-out request if stream cancellation is unsupported.

Docs: <https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts>

## Reporting dimensions

```ts
providerOptions: {
  gateway: {
    user: 'user-123',
    tags: ['feature:chat', 'env:production'],
  },
},
```

`user` and `tags` add Custom Reporting dimensions. They do not enforce application rate limits or budgets by themselves. Reporting writes and queries are billed separately, and the reporting endpoint is currently Pro/Enterprise.

Limits from current docs:

- up to 10 tags after deduplication
- each tag 1 to 64 characters
- user up to 256 characters

Docs: <https://vercel.com/docs/ai-gateway/observability-and-spend/custom-reporting>

## Compliance and routing policy

AI Gateway supports request-level and team-level controls for provider restrictions, no-training routing, ZDR, HIPAA, regional inference, and model allowlists. These controls differ in availability, plan requirements, and price.

Do not invent option names. Read the exact page for the requested policy:

- <https://vercel.com/docs/ai-gateway/security-and-compliance>
- <https://vercel.com/docs/ai-gateway/models-and-providers/routing-rules>

## Verification

After changing routing:

1. Run a permitted live request.
2. Read `providerMetadata.gateway` where the selected SDK exposes it.
3. Inspect the request in AI Gateway Logs.
4. Confirm each attempted provider/model, credential type, timeout, status, and final model.
5. Confirm cost, data-retention, and regional consequences match the user's intent.
