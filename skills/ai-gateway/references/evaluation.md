# Evaluation models

Use evaluation models to assess shared application state against typed questions. They return structured boolean probabilities, choices, or scores instead of free-form text.

## Requirements

- Evaluation is available through AI SDK 7 or later only. It is not supported through the OpenAI-compatible, Anthropic-compatible, or Cohere-compatible endpoints.
- Load the `ai-sdk` skill and read the installed `ai` package docs before writing code.
- Choose a model from the current [Evaluation model list](https://vercel.com/ai-gateway/models?capabilities=evaluation). Do not assume a text-generation model supports evaluation.
- Use the [Evaluation quickstart](https://vercel.com/docs/ai-gateway/getting-started/evaluation) for the complete first-run workflow and the [Evaluation modality guide](https://vercel.com/docs/ai-gateway/modalities/evaluation) for current request shapes.

## Minimal request

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

## Question and state rules

- `boolean` returns a probability from 0 to 1. Optional `criteria` can define the true and false cases.
- `choice` selects one key from a named `criteria` record and returns probabilities for every option.
- `score` uses an ordered `criteria` array of at least two labels and returns an interpolated score plus rung probabilities.
- One request can ask multiple questions of different types against the same state.
- `state` can be a string, object, or array. Pass structured records or message history directly instead of serializing them first.

Use stable question keys because each key in `questions` becomes the corresponding key in `result.answers`. Treat probabilities as model outputs, not certainty; define explicit criteria and validate thresholds against representative data before automating consequential actions.

## Usage and verification

Evaluation responses include token usage and are billed at the selected model's rates. Some evaluation models price input tokens only, so check the live model page instead of assuming text-model pricing.

After implementation:

1. Run the formatter, type checker, and focused tests.
2. When authorized, make one live evaluation and inspect `result.answers` and `result.usage`.
3. Confirm the request and cost in AI Gateway Logs.
