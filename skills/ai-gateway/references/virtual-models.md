# Virtual Models

A Virtual Model is a team-scoped `vmc/<slug>` that resolves to a base model plus reusable routing, behavior, compliance, observability, and provider-specific configuration. Use one stable model ID and update its server-side configuration without redeploying each caller.

Docs: <https://vercel.com/docs/ai-gateway/models-and-providers/virtual-models>

## When to use one

Use a Virtual Model when:

- multiple applications or agents should share one model policy;
- a coding agent accepts a model ID but cannot send `providerOptions`;
- provider order, restrictions, fallbacks, service tier, caching, timeouts, compliance, or tags must be centrally managed;
- provider-specific options should apply to every request through the slug; or
- the underlying model or routing should change without editing callers.

Keep per-request `providerOptions` when policy genuinely varies by request and the client can send them. A Virtual Model is configuration, not a second inference request.

## Create and inspect

Use the dashboard or the current CLI. Check help before scripting flags:

```bash
vercel ai-gateway virtual-models --help
vercel ai-gateway virtual-models create
vercel ai-gateway virtual-models inspect coding-agent
vercel ai-gateway models list --virtual
```

The CLI supports create, list, inspect, edit, remove, and restore. The slug is immutable after creation. Changes apply to new requests within a few minutes.

The Virtual Model's **Provider Options** field is a provider-keyed JSON map, for example:

```json
{
  "anthropic": {
    "effort": "high"
  }
}
```

Keys must be known provider slugs, and each nested option must be valid for that provider.

Do not confuse that field with Gateway routing controls. Provider order, `only`, model fallbacks, sorting, service tier, caching, timeouts, capabilities, compliance, and tags are separate Virtual Model settings. In an AI SDK request, those routing controls normally live under `providerOptions.gateway`.

## Call the Virtual Model

Use the `vmc/` prefix anywhere AI Gateway accepts a model ID:

```ts
import { streamText } from 'ai';

const result = streamText({
  model: 'vmc/coding-agent',
  prompt: 'Review this change.',
  providerOptions: {
    gateway: {
      user: 'user-123',
    },
  },
});
```

The request may still supply settings the Virtual Model leaves unset. Saved settings resolve as follows:

- Provider order, `only`, fallbacks, fast mode, sort, service tier, caching, timeouts, inference region, required capabilities, and tags win when the Virtual Model sets them.
- Provider-specific options merge option by option; the Virtual Model wins collisions and request values fill unset options.
- Compliance settings only tighten. Neither side can turn off a restriction enabled by the other.
- A setting left unset by the Virtual Model remains request-configurable.
- A `vmc/<slug>` can appear in a request fallback list; its settings apply only to that fallback attempt.

Read the current docs before relying on `@default` or cleared settings; only selected fields support the tri-state behavior.

## Coding-agent pattern

Coding agents frequently expose a model picker or model config but no way to send AI SDK `providerOptions`. In that case:

1. Connect the agent with `vercel ai-gateway setup`.
2. Create a Virtual Model containing the shared routing and provider configuration.
3. Select or configure `vmc/<slug>` as the agent's model. Use the agent's current AI Gateway page for exact config syntax. If its generated shortlist omits team Virtual Models, add the ID manually where the agent permits custom models.
4. Verify in AI Gateway Logs that the slug resolved to the expected base model and provider.

Do not promise that every agent discovers team Virtual Models automatically. Model discovery and custom-model support vary by agent. The Virtual Model solves server-side configuration; it does not change the client's model-picker capabilities.

## Operational cautions

- Only team Owners and Members can manage Virtual Models, but any team member can call one.
- Archived or removed slugs stop serving requests. Know the callers before changing lifecycle state.
- Virtual Model tags replace request tags when configured, so avoid unintentionally dropping caller attribution.
- Required capabilities replace the request's capability list rather than merging with it.
- Repointing a slug can change price, latency, retention, and model behavior for every caller. Verify Logs and cost after edits.
