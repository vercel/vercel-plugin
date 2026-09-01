# Setup and compatible APIs

Use this reference for first requests, authentication setup, migration, and compatible clients.

## First request

1. Confirm a Vercel account and team are available.
2. For free AI Gateway Credits, the team needs a valid payment method. If the gateway returns `customer_verification_required`, use the action URL in the error.
3. Create an AI Gateway API key from the dashboard or CLI, or use OIDC for a Vercel deployment.
4. Export `AI_GATEWAY_API_KEY` in the shell or load it from an uncommitted environment file.
5. Fetch `/v1/models`, choose a current model, and make one request.
6. Print or return the result.
7. Open AI Gateway Logs and inspect the model, provider, usage, cost, status, and routing attempts. Allow about 90 seconds for ingestion.

Canonical tutorial: <https://vercel.com/docs/ai-gateway/getting-started>

## API key setup

Dashboard: <https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys>

```bash
export AI_GATEWAY_API_KEY="your_ai_gateway_api_key"
```

The key value is shown once. Never write it to committed source or print it in a response.

Use the CLI when the user asks for CLI management:

```bash
vercel ai-gateway api-keys create --name my-api-key
```

The CLI can bind a budget, spend alerts, and an expiry at creation, which beats re-editing the key later:

```bash
vercel ai-gateway api-keys create --budget 500 --alert-thresholds 75,100 --expiration 90d
```

`inspect` shows a key's budget, spend, BYOK spend, alerts, and expiry; `list` shows every key. Run `vercel ai-gateway api-keys create --help` before scripting because available quota, expiration, alert, and restriction-exemption flags change.

## OIDC setup

OIDC is preferred for Vercel deployments because the deployment receives `VERCEL_OIDC_TOKEN` automatically. For local development against a linked Vercel project:

```bash
vercel link
vercel env pull
```

The current OIDC documentation states that locally pulled tokens are valid for 12 hours. Re-run `vercel env pull` when the token expires.

Do not say that OIDC removes request authentication. The token authenticates the request to AI Gateway. BYOK credentials are separate provider credentials.

Docs: <https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc>

## AI SDK

Current AI SDK JavaScript releases require Node.js 22 or later. Verify the installed package rather than upgrading an established project without approval.

A plain `provider/model` string uses AI Gateway:

```ts
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.6-sol',
  prompt: 'Explain this codebase.',
});

console.log(text);
```

Load the `ai-sdk` skill and read `node_modules/ai/docs/` before writing SDK-specific code. Use `@ai-sdk/gateway` exports only when needed. Do not add a provider-specific package for a model called through AI Gateway.

## AI SDK for Python

Current AI SDK for Python releases require Python 3.12 or later. Install and follow its current docs:

```bash
uv add ai
```

```python
import asyncio
import ai


async def main() -> None:
    model = ai.get_model('openai/gpt-5.6-sol')
    messages = [ai.user_message('Explain this project.')]

    async with ai.stream(model, messages) as stream:
        async for event in stream:
            if isinstance(event, ai.events.TextDelta):
                print(event.chunk, end='', flush=True)


asyncio.run(main())
```

Docs: <https://vercel.com/docs/ai-gateway/sdks-and-apis/ai-sdk-python>

## Compatible clients

| Client or API | Base URL or endpoint |
| --- | --- |
| OpenAI Chat Completions and OpenAI Responses SDKs | `https://ai-gateway.vercel.sh/v1` |
| Anthropic Messages SDK | `https://ai-gateway.vercel.sh` |
| OpenResponses HTTP | `https://ai-gateway.vercel.sh/v1/responses` |
| Cohere Rerank | Follow the current Cohere Rerank page |

Keep the client's request shape and replace its base URL and request authentication. AI Gateway model IDs remain `provider/model` strings even when using an OpenAI or Anthropic SDK.

Docs: <https://vercel.com/docs/ai-gateway/sdks-and-apis>

## Migration

For an existing integration:

1. Inventory the SDK, model IDs, provider-specific request fields, provider credentials, streaming behavior, and error handling.
2. Choose the closest AI Gateway API shape. An existing OpenAI or Anthropic client can usually keep its SDK.
3. Change request authentication and the base URL.
4. Map model IDs to live AI Gateway slugs. Do not mechanically prepend a provider name.
5. Preserve provider-specific options that the selected API supports.
6. Remove direct-provider credentials only after the AI Gateway path passes a live request.
7. Verify usage, cost, and routing in Logs.

Migration guide: <https://vercel.com/docs/ai-gateway/getting-started/migrate-to-ai-gateway>

## Common first-request errors

| Status or type | Meaning | Action |
| --- | --- | --- |
| `401` | Missing, invalid, or revoked API key/OIDC token | Fix request authentication |
| `402 insufficient_funds` | No positive AI Gateway Credits balance | Add credits |
| `402 quota_for_entity_exceeded` | A team, project, API key, or user budget is exhausted | Wait for refresh or raise the budget |
| `403 customer_verification_required` | A valid payment method is required for free credits | Use the action URL in the error |
| `429` | Gateway or provider rate limit | Honor `retry-after` when present and retry with backoff; see the [rate limits page](https://vercel.com/docs/ai-gateway/rate-limits) |
| `503` | Provider capacity or gateway service unavailable | Retry if safe; inspect provider attempts before changing routing |
