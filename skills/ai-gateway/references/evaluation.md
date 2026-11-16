# Decision models

Use decision models (previously called evaluation models) to assess shared application state against typed questions. They return structured boolean probabilities, choices, or scores instead of free-form text.

## Choose the evaluation surface

| Existing project | Use |
| --- | --- |
| JavaScript or TypeScript using AI SDK 7 | `experimental_decide` from `ai` 7.0.128+; earlier AI SDK 7 releases use the now-deprecated `experimental_evaluate` alias |
| New non-AI-SDK client, OpenAI SDK, or OpenAI Decisions API client | OpenAI-compatible `POST /v1/decisions` with base URL `https://ai-gateway.vercel.sh/v1` |
| Existing `/v1/evaluate` client | Deprecated `POST /v1/evaluate`; it keeps working, but migrate to `/v1/decisions` |
| Existing TypeSafe client | Keep `@typesafe-ai/sdk` and change its API key and `baseURL` |

Decisions are not supported through Chat Completions, Responses, or the Anthropic-compatible or Cohere-compatible endpoints. Use one of the surfaces above instead.

Choose a model from the current [Decision model list](https://vercel.com/ai-gateway/models?capabilities=decision). Do not assume a text-generation model supports decisions. Use the [Decision quickstart](https://vercel.com/docs/ai-gateway/getting-started/decision) for the AI SDK first-run workflow, the [Decision modality guide](https://vercel.com/docs/ai-gateway/modalities/decision) for AI SDK and HTTP request shapes, the [OpenAI-compatible Decisions API guide](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions) for OpenAI's request shape, and the [TypeSafe API guide](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) when migrating a TypeSafe client.

## AI SDK

Load the `ai-sdk` skill and read the installed `ai` package docs before writing code.

```ts
import { experimental_decide as decide } from 'ai';

const result = await decide({
  model: 'typesafe-ai/jev',
  state: 'The support agent issued a full refund to the customer.',
  questions: {
    refunded: {
      type: 'boolean',
      instructions: 'Was a refund issued?',
    },
  },
});

console.log(result.answers);
```

When using an explicit Gateway provider instance, use `gateway.decisionModel(<model-id>)` (`@ai-sdk/gateway` 4.0.104+, released with `ai` 7.0.128); earlier releases use `gateway.evaluationModel()`, which remains as a deprecated alias. A plain decision model string routes through AI Gateway without installing `@ai-sdk/gateway`.

## HTTP API

For a client that does not use AI SDK, post OpenAI's Decisions shape to `POST https://ai-gateway.vercel.sh/v1/decisions`, or point the OpenAI SDK at `https://ai-gateway.vercel.sh/v1`:

```bash
curl https://ai-gateway.vercel.sh/v1/decisions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "typesafe-ai/jev",
    "input": "The support agent issued a full refund.",
    "questions": [
      { "type": "predicate", "name": "refunded", "instructions": "Was a refund issued?" }
    ]
  }'
```

The response lists `answers` in question order, with `model`, `usage`, and `provider_metadata.gateway` routing and cost. The endpoint accepts AI Gateway controls under `providerOptions.gateway`.

`POST /v1/evaluate` is deprecated but keeps working for existing integrations, which send Gateway's evaluation shape:

```bash
curl https://ai-gateway.vercel.sh/v1/evaluate \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "typesafe-ai/jev",
    "state": "The support agent issued a full refund.",
    "questions": {
      "refunded": { "type": "boolean", "instructions": "Was a refund issued?" }
    }
  }'
```

The response contains `model`, `answers`, and camel-cased `usage`. The endpoint accepts AI Gateway controls under `providerOptions.gateway`, including `zeroDataRetention` and `only`. Dashboard-configured BYOK credentials are used automatically.

## TypeSafe compatibility

For an existing TypeSafe client, keep its request and response shapes and change only the credential and base URL:

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: 'https://ai-gateway.vercel.sh/typesafe',
});
```

The compatibility surface provides:

- `POST /typesafe/v1/systemone` for evaluation;
- `GET /typesafe/v1/models` for the evaluation model list; and
- TypeSafe's `noul`, choice, score, confidence, legend, snake-case usage, and error shapes.

The TypeSafe-compatible request body also accepts AI Gateway controls under `providerOptions.gateway`. Use the OpenAI-compatible `/v1/decisions` endpoint for new HTTP integrations; use `/typesafe` when preserving an existing TypeSafe client is the goal.

On any decision surface, use [Decision Fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/decision-fallbacks) to rerun a successful but uncertain decision with another model: a conditional entry in `providerOptions.gateway.models`, such as a `confidenceBelow` threshold on a Choice or Score question. A triggered fallback bills both stages.

## Question and state rules

- Gateway's AI SDK and `/v1/evaluate` surfaces use `boolean`; the TypeSafe-compatible surface uses `noul` and translates it internally.
- The OpenAI-compatible `/v1/decisions` surface uses OpenAI's shapes instead: `input` plus a `questions` array of `predicate`, `choice` (`choices`), and `score` (`levels`) entries with optional `name`. The rules below describe the other surfaces.
- `boolean` or `noul` returns a probability from 0 to 1. Optional `criteria` can define the true and false cases.
- `choice` selects one key from a named `criteria` record and returns probabilities for every option.
- `score` uses an ordered `criteria` array of at least two labels and returns an interpolated score plus rung probabilities.
- One request can ask multiple questions of different types against the same state.
- Gateway `state` can be a string, object, or array. The TypeSafe contract also permits null and preserves its broader optional instruction and criteria shapes.
- In AI SDK `ai` 7.0.133+, an array passed directly as `state` is an ordered list of parts (`{ type: 'text', text }`, `{ type: 'json', value }`), not JSON data; Gateway rejects `file` parts. Wrap a JSON array in an object (`state: { messages }`) or a `json` part (`state: [{ type: 'json', value: messages }]`).

Use stable question keys because each key in `questions` becomes the corresponding key in `answers`. Treat probabilities as model outputs, not certainty; define explicit criteria and validate thresholds against representative data before automating consequential actions.

## Usage and verification

Evaluation responses include token usage and are billed at the selected model's rates. Some evaluation models price input tokens only, so check the live model page instead of assuming text-model pricing.

After implementation:

1. Run the formatter, type checker, and focused tests.
2. When authorized, make one live evaluation through the selected surface and inspect its answers and usage.
3. If using TypeSafe compatibility, verify the response retains TypeSafe naming and required confidence or legend fields.
4. Confirm the request, API format, routing, and cost in AI Gateway Logs.
