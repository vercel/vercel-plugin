# Evaluation models

Use evaluation models to assess shared application state against typed questions. They return structured boolean probabilities, choices, or scores instead of free-form text. AI Gateway docs now call them decision models; `experimental_evaluate` and `gateway.evaluationModel()` remain as deprecated aliases.

## Choose the evaluation surface

| Existing project | Use |
| --- | --- |
| JavaScript or TypeScript using AI SDK 7 or later | `experimental_decide` from `ai` 7.0.128+; earlier AI SDK 7 releases use `experimental_evaluate` |
| Existing OpenAI SDK using the Decisions API | Keep `decisions.create` and point `baseURL` to `https://ai-gateway.vercel.sh/v1` (`POST /v1/decisions`) |
| New non-AI-SDK client | Gateway's vendor-neutral `POST /v1/evaluate` |
| Existing TypeSafe client | Keep `@typesafe-ai/sdk` and change its API key and `baseURL` |

Evaluation is not supported through Chat Completions, Responses, or the Anthropic-compatible or Cohere-compatible endpoints. Use one of the four surfaces above instead.

Choose a model from the current [Decision model list](https://vercel.com/ai-gateway/models?capabilities=decision). Do not assume a text-generation model supports evaluation. Use the [Decision quickstart](https://vercel.com/docs/ai-gateway/getting-started/decision) for the AI SDK first-run workflow, the [Decision modality guide](https://vercel.com/docs/ai-gateway/modalities/decision) for AI SDK and HTTP request shapes, and the [TypeSafe API guide](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) when migrating a TypeSafe client.

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

When using an explicit Gateway provider instance, use `gateway.decisionModel(<model-id>)` (`@ai-sdk/gateway` 4.0.104+, which ships with `ai` 7.0.128+; earlier releases use the deprecated `gateway.evaluationModel(<model-id>)`). A plain evaluation model string routes through AI Gateway without installing `@ai-sdk/gateway`.

## HTTP API

For a client that does not use AI SDK, send Gateway's evaluation shape to `POST https://ai-gateway.vercel.sh/v1/evaluate`:

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

The TypeSafe-compatible request body also accepts AI Gateway controls under `providerOptions.gateway`. Use the generic `/v1/evaluate` endpoint for new HTTP integrations; use `/typesafe` when preserving an existing TypeSafe client is the goal.

On any evaluation surface, use [Decision Fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/decision-fallbacks) to rerun a successful but uncertain evaluation with another model: a conditional entry in `providerOptions.gateway.models`, such as a `confidenceBelow` threshold on a Choice or Score question. A triggered fallback bills both stages.

## Question and state rules

- Gateway's AI SDK and `/v1/evaluate` surfaces use `boolean`; the TypeSafe-compatible surface uses `noul` and translates it internally.
- `boolean` or `noul` returns a probability from 0 to 1. Optional `criteria` can define the true and false cases.
- `choice` selects one key from a named `criteria` record and returns probabilities for every option.
- `score` uses an ordered `criteria` array of at least two labels and returns an interpolated score plus rung probabilities.
- One request can ask multiple questions of different types against the same state.
- Gateway `state` can be a string, object, or array. The TypeSafe contract also permits null and preserves its broader optional instruction and criteria shapes.

Use stable question keys because each key in `questions` becomes the corresponding key in `answers`. Treat probabilities as model outputs, not certainty; define explicit criteria and validate thresholds against representative data before automating consequential actions.

## Usage and verification

Evaluation responses include token usage and are billed at the selected model's rates. Some evaluation models price input tokens only, so check the live model page instead of assuming text-model pricing.

After implementation:

1. Run the formatter, type checker, and focused tests.
2. When authorized, make one live evaluation through the selected surface and inspect its answers and usage.
3. If using TypeSafe compatibility, verify the response retains TypeSafe naming and required confidence or legend fields.
4. Confirm the request, API format, routing, and cost in AI Gateway Logs.
