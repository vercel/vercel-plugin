# Evaluation models

Use evaluation models to assess shared application state against typed questions. They return structured boolean probabilities, choices, or scores instead of free-form text.

## Choose the evaluation surface

| Existing project | Use |
| --- | --- |
| JavaScript or TypeScript using AI SDK 7 or later | `experimental_evaluate` from `ai` |
| New non-AI-SDK client | Gateway's vendor-neutral `POST /v1/evaluate` |
| Existing TypeSafe client | Keep `@typesafe-ai/sdk` and change its API key and `baseURL` |

Evaluation is not supported through the OpenAI-compatible, Anthropic-compatible, or Cohere-compatible endpoints. Use one of the three surfaces above instead.

Choose a model from the current [Evaluation model list](https://vercel.com/ai-gateway/models?capabilities=evaluation). Do not assume a text-generation model supports evaluation. Use the [Evaluation quickstart](https://vercel.com/docs/ai-gateway/getting-started/evaluation) for the AI SDK first-run workflow, the [Evaluation modality guide](https://vercel.com/docs/ai-gateway/modalities/evaluation) for AI SDK and HTTP request shapes, and the [TypeSafe API guide](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) when migrating a TypeSafe client.

## AI SDK

Load the `ai-sdk` skill and read the installed `ai` package docs before writing code.

```ts
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
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

When using an explicit Gateway provider instance, use `gateway.evaluationModel(<model-id>)`. A plain evaluation model string routes through AI Gateway without installing `@ai-sdk/gateway`.

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
