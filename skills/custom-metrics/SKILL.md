---
name: custom-metrics
description: Emit and query Vercel Custom Metrics. Use when instrumenting application or business measurements in Vercel Functions, using metric() from @vercel/functions, choosing metric names and attributes, or querying emitted values with vc metrics.
summary: Emit numeric measurements from Functions and query them with vc metrics
metadata:
  priority: 9
  docs:
    - "https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package"
    - "https://vercel.com/docs/cli/metrics"
    - "https://vercel.com/docs/observability/observability-plus"
  sitemap: "https://vercel.com/sitemap/docs.xml"
  pathPatterns: []
  bashPatterns:
    - '\b(?:vercel|vc)\s+metrics\s+(?!schema(?:\s|$)|vercel\.)[A-Za-z_][A-Za-z0-9_./-]*\b'
    - '\b(?:vercel|vc)\s+metrics\s+schema\s+(?!vercel\.)[A-Za-z_][A-Za-z0-9_./-]*\b'
  importPatterns: []
  promptSignals:
    phrases:
      - "custom metric"
      - "custom metrics"
      - "emit a metric"
      - "emit metrics"
      - "report a metric"
      - "report metrics"
      - "application metrics"
      - "business metrics"
      - "@vercel/functions metric"
    allOf:
      - [emit, metric]
      - [report, metric]
      - [instrument, metric]
      - [vercel, metric]
    anyOf:
      - "observability"
      - "instrumentation"
      - "duration"
      - "counter"
      - "percentile"
    noneOf:
      - "font metrics"
      - "core web vitals"
    minScore: 6
retrieval:
  aliases:
    - Vercel application metrics
    - Vercel business metrics
    - function metrics
    - vc metrics
  intents:
    - emit a custom metric
    - instrument a Vercel Function
    - query a custom metric
    - measure application behavior
  entities:
    - metric
    - "@vercel/functions"
    - Vercel Custom Metrics
    - vc metrics
    - Observability Plus
  examples:
    - emit checkout duration as a custom metric
    - add a business counter to this Vercel Function
    - query my custom metric with vc metrics
    - group an application metric by outcome
---

# Vercel Custom Metrics

Use Custom Metrics for numeric application and business measurements emitted by server-side code running in a Vercel Function. The workflow is **emit a numeric sample with `metric()` → invoke the deployed function → discover and query the metric with `vc metrics` or Observability**.

## Emit a metric

Install or upgrade `@vercel/functions`, then import `metric` from its root entry point:

```bash
pnpm add @vercel/functions
```

```ts
import { metric } from '@vercel/functions';

export async function POST() {
  const startedAt = performance.now();

  try {
    await createOrder();
    metric('orders.created', 1, { outcome: 'success' });
    return Response.json({ ok: true });
  } catch (error) {
    metric('orders.created', 1, { outcome: 'error' });
    throw error;
  } finally {
    metric('orders.duration_ms', performance.now() - startedAt);
  }
}
```

The signature is:

```ts
metric(name: string, value: number, tags?: Record<string, string>): void
```

- `name` identifies one stable measurement, such as `orders.created` or `orders.duration_ms`.
- `value` is the numeric sample. Emit `1` for an increment that will be summed; emit the observed value for a duration, size, or score.
- `tags` are optional string attributes. After ingestion, discovered tag keys appear as dimensions for filtering and grouping.
- `metric()` is synchronous and returns `void`; do not `await` it.
- The helper is a no-op when the runtime does not expose Custom Metrics support. Verify instrumentation through a deployed Vercel Function invocation, not local execution alone.

## Model metrics for useful queries

- Prefer stable, dotted names with a unit suffix where useful: `checkout.completed`, `checkout.duration_ms`, `queue.batch_size`.
- Do not use the reserved `vercel.` prefix for application-defined names.
- Keep variable data in tags instead of metric names. Use `checkout.completed` with `{ plan: 'pro' }`, not `checkout.completed.pro`.
- Keep tag cardinality bounded. Good tags are `outcome`, `plan`, `provider`, or a normalized route. Do not attach user IDs, request IDs, email addresses, raw URLs, or other unique or sensitive values.
- Emit one sample at the point where the outcome is known. For retryable or at-least-once work, decide whether attempts or successful logical operations are the intended measurement and name the metric accordingly.

Choose the query aggregation to match what was emitted:

| Measurement | Emit | Query |
| --- | --- | --- |
| Occurrence or increment | `metric('checkout.completed', 1)` | `sum` or `persecond` |
| Duration or size | `metric('checkout.duration_ms', duration)` | `avg`, `p75`, `p95`, `max` |
| Sampled level | `metric('queue.batch_size', size)` | `avg`, `min`, `max`, percentiles |

## Discover and query the metric

Run the deployed code at least once, then use the linked project and correct team scope:

```bash
vc metrics schema
vc metrics schema orders.duration_ms

vc metrics orders.created -a sum --group-by outcome --since 24h
vc metrics orders.duration_ms -a p95 --since 1h
vc metrics orders.duration_ms -a p95 --group-by outcome --since 24h --format=json
```

`vc` and `vercel` are equivalent. Always inspect the exact metric first with `vc metrics schema <name>` because the schema reports the available aggregations and discovered tag dimensions. Use `-S <team>` and `-p <project>` when the current link or scope is ambiguous; use `--all` only for a deliberate team-wide query.

Custom Metrics querying requires Observability Plus and availability for the selected team. If a metric is missing:

1. Confirm the function was deployed to Vercel and the instrumented path actually ran.
2. Confirm `@vercel/functions` exports `metric`; upgrade it if necessary.
3. Check `vc whoami`, the selected team, and the linked project.
4. Allow for ingestion delay, then rerun `vc metrics schema`.
5. Confirm Observability Plus and Custom Metrics are enabled for the team.

## Use the right signal

- Use **Custom Metrics** for numeric values you want to aggregate, trend, and filter.
- Use **Web Analytics custom events** for user interaction and conversion events in Web Analytics.
- Use **OpenTelemetry spans** for traces, operation timing, and request causality.
- Use **logs** for detailed diagnostic context and individual records.

Do not encode detailed event payloads into metric tags. Pair a low-cardinality metric with structured logs or traces when investigation needs per-request detail.
