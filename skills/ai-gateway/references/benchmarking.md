# Benchmarking AI Gateway

Use this reference to design, run, or audit a latency, throughput, reliability, or cost comparison between AI Gateway and another route to the same model. The other route is the baseline: the project's current provider integration, or any other path the user names.

Read <https://vercel.com/docs/ai-gateway/benchmarking> first. It carries a dependency-free reference script. Verify every field name below against a live response before relying on it.

## Ground rules

- A benchmark changes one variable, the route. A run with an unresolved difference between routes measures that difference, not the route.
- The benchmark sends real requests and spends money on both routes. State the planned request count and a cost estimate, and get approval before sending anything.
- Do not call one route faster when the difference is within run-to-run variation, or when an analysis check below failed. Report the failed check instead.
- Never print API keys. Check for presence only.

## 1. Build the equivalence table before sending anything

Record each setting for both routes side by side. List every difference and the change that removes it, then stop for approval.

| Setting | Why it matters | Control on AI Gateway |
| --- | --- | --- |
| Model | Aliases and fast variants are different serving paths | Exact ID from `/v1/models`; match the baseline's provider model |
| Provider | Default routing picks a provider per request by recent uptime and latency; the baseline uses one | `providerOptions.gateway.only: ['<slug>']` for the like-for-like run |
| Region | Regional endpoints and regional model IDs differ from a provider's default in speed and price | `providerOptions.gateway.inferenceRegion: { scope: 'zone', geoRegion: 'us' }` when the baseline is regional; leave unset when it is not |
| Reasoning effort | Unset effort falls to a default that differs by provider and API format | Same explicit effort on both routes: `reasoning_effort` (Chat Completions), `reasoning` (AI SDK 7, Responses), `thinking` plus `output_config.effort` (Messages) |
| API format | Each format has its own reasoning and caching defaults | Same format on both routes; otherwise set every optional parameter explicitly |
| Credentials | Each provider account has its own rate limits, capacity, and prompt cache | Either Vercel's provider keys (the default) or the user's key through BYOK. Pick one, never mix within a run, and state it |
| Request parameters | Output length drives total time | Same messages, system prompt, tools, schema, maximum output tokens, temperature, and streaming |
| Prompt caching | Cache reads are faster and cheaper; repeating a prompt warms the cache mid-run | Cold (unique prefix per request) or warm (same prompts, warm-up discarded, cached tokens compared). `caching: 'auto'` when the baseline sets cache markers |
| Service tier and speed | Priority, flex, and fast tiers trade price for speed | Same `serviceTier` and `speed` on both routes |
| Client | Network distance, connection setup, and client queueing are outside both routes | Same machine, same process, same HTTP client settings, production region, same time window |
| SDK retries and timeouts | Silent retries hide failures and add time | Set retries to 0 on both routes, or count them; same timeout |
| Team settings | Zero Data Retention, a provider allowlist, or a team-wide region pin shrinks the provider pool | Benchmark on a team with production's settings |

`only` removes failover. Use it to isolate the route, then measure default routing in a separate run (see "Default routing run").

## 2. Preflight: one request per route

Before the full run, confirm:

- Both routes return HTTP 200 and a complete stream.
- AI Gateway names the intended provider in `provider_metadata.gateway.routing.finalProvider` (`providerMetadata.gateway.routing.finalProvider` in the AI SDK), with one provider attempt.
- When a region is pinned, the serving attempt's `inferenceEndpoint.geoRegion` matches it.
- Reasoning tokens and output tokens are in the same range on both routes. Some providers do not report reasoning tokens separately; compare output tokens and time to first text for those.

Fix the configuration and repeat until every check passes.

## 3. Protocol

- **Prompts:** at least five real prompts from the project, covering its typical input sizes. A one-line prompt hides prompt-size effects.
- **Warm-up:** discard the first three requests on each route. They pay for DNS, connection setup, and cold caches.
- **Interleave:** alternate routes request by request and randomize which goes first in each pair. Never run all of one route and then all of the other; that compares two time windows.
- **Concurrency:** the same on both routes. Start at 1, then repeat at production concurrency.
- **Sample size:** at least 30 measured requests per route per model for a median, at least 100 before reporting a 95th percentile.
- **Time windows:** repeat at another time of day. Provider load changes.
- **Streaming:** stream on both routes when production streams, and read the stream incrementally.

Record one row per request and save the rows as JSONL:

| Field | Definition |
| --- | --- |
| `startedAt`, route, prompt ID, round | Pairs requests and lines them up in time |
| `status`, error body | Failure counts |
| `headersMs` | Send to response headers |
| `firstTokenMs` | Send to the first streamed chunk carrying reasoning or text (`delta.reasoning`, `delta.reasoning_content`, or `delta.content` on Chat Completions) |
| `firstTextMs` | Send to the first chunk carrying answer text |
| `totalMs` | Send to end of stream |
| Input, output, reasoning, cached tokens | `usage.prompt_tokens`, `usage.completion_tokens`, `usage.completion_tokens_details.reasoning_tokens`, `usage.prompt_tokens_details.cached_tokens` on Chat Completions (send `stream_options: { include_usage: true }`) |
| Response ID | On AI Gateway this is the generation ID (`gen_...`) |

## 4. Enrich AI Gateway rows

AI Gateway records its own timing for every generation. For each AI Gateway row, call:

```bash
curl -s "https://ai-gateway.vercel.sh/v1/generation?id=$GENERATION_ID" \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY"
```

Usage is ingested asynchronously, so retry while the lookup returns 404. Record `provider_name`, `is_byok`, `latency` (time to first token as AI Gateway measured it, in milliseconds), `generation_time` (total, in milliseconds), `total_cost`, and the `native_tokens_*` counts.

Compute `outsideGatewayMs = firstTokenMs - latency` for each row. It is the time spent between the client and AI Gateway.

## 5. Analysis checks

Report the median and the 95th percentile per route, never the mean alone: one slow provider response can move an average by more than the difference under test. Pair each AI Gateway request with the baseline request for the same prompt and round, and report the median paired difference.

Run these checks in order and report each result. A failed check means the timing comparison is not valid yet.

| Check | How | A failure means |
| --- | --- | --- |
| Equal work | Median output, reasoning, and cached tokens within 20% across routes | Reasoning effort, caching, or output limits differ. Fix and rerun |
| Provider | Every AI Gateway row served by the intended provider with one attempt | Routing was not pinned, or a failover added the first attempt's time. List those rows |
| Time outside AI Gateway | `outsideGatewayMs` small and steady | Large and steady: the client is far from AI Gateway or opens a connection per request. Uneven: the client or its network stalls |
| Client stalls | Slow requests on both routes within the same few seconds | The client, not either route. Count how many rows of each route fell in the stall |
| Buffered stream | `firstTokenMs` well below `totalMs` on streamed requests | Equal values mean the client read the whole body before timing the first token |
| Cold start | No downward trend across the first measured rounds | The warm-up was too short. Discard more rounds |
| Outliers | Recompute medians without the five slowest rows per route | If the conclusion flips, a few provider responses drove it. Report both versions and the row IDs |
| Errors | Failures per route by status code | Compare success rates before latency. A route that fails fast can look faster |

For any single slow AI Gateway request, read its provider attempts: `routing.modelAttempts[].providerAttempts[]` in the response metadata carries each attempt's provider, credential type, success, and start and end times, and the Logs page shows the same per request.

As a reference point, `GET https://ai-gateway.vercel.sh/v1/models/<creator>/<model>/endpoints` returns each provider's `latency_last_1h` and `throughput_last_1h` (p50 and p95) from live AI Gateway traffic. Prompt size and reasoning effort shift a project's own numbers.

## 6. Default routing run

The pinned run isolates the route. Production traffic can use every provider that serves the model, so after the like-for-like result, remove `only` and rerun the protocol. Report it separately and include success rate: a request that fails on one provider and completes on another is a success here and a failure on a single-provider route. `sort: 'ttft'` prefers the fastest provider.

## 7. Auditing a benchmark that already ran

When the user brings results that show a gap, do not rerun first. Ask for the raw per-request rows, both routes' request settings, the generation IDs, the client's location, and the time window. Then:

1. Fill the equivalence table from the actual requests. Unequal reasoning effort, a regional endpoint on one side, and BYOK on one side are the most common differences.
2. Check sample size and ordering: a handful of requests per model, or one route run entirely before the other, cannot support a conclusion.
3. Run the analysis checks on the rows as given.
4. Name each confounder found, estimate its effect where the data allows, and propose the corrected run.

## 8. Report

Include, in this order:

1. The equivalence table with the final settings for both routes.
2. The results table: requests, errors, median and 95th percentile for time to first token, time to first text, and total time, plus median token counts and cost per request.
3. The result of each analysis check.
4. The limits of the test: sample size, time window, client location, single or multiple prompts.
5. The path to the raw JSONL.

If AI Gateway is slower after every setting matches and every check passes, collect the generation IDs of the slow requests, the time window, and the client region, and have the user send them through the dashboard's Support entry.

Docs: <https://vercel.com/docs/ai-gateway/benchmarking>, <https://vercel.com/docs/ai-gateway/observability-and-spend/usage>, and <https://vercel.com/docs/ai-gateway/models-and-providers/metrics>
