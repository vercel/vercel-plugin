---
name: vercel-tracing
description: Set up OpenTelemetry instrumentation for Vercel Tracing and query the resulting spans. Use when adding or fixing `@vercel/otel`, wiring a framework's server startup hook (Next.js, SvelteKit, and others), adding custom spans, propagating trace context between services, configuring always-on tracing sampling, searching or inspecting spans with `vercel traces`, or debugging failed or slow server requests.
summary: Instrument server code with @vercel/otel, then debug and optimize requests with vercel traces
metadata:
  priority: 8
  docs:
    - "https://vercel.com/docs/tracing"
    - "https://vercel.com/docs/tracing/always-on-tracing"
    - "https://vercel.com/docs/tracing/session-tracing"
    - "https://vercel.com/docs/cli/traces"
    - "https://vercel.com/docs/tracing/instrumentation"
  sitemap: "https://vercel.com/sitemap/docs.xml"
  pathPatterns: []
  bashPatterns:
    - '\b(?:vercel|vc)\s+traces\b'
    - '\b(?:vercel|vc)\s+curl\b[^\n]*--trace\b'
  importPatterns:
    - '@vercel/otel'
    - '@opentelemetry/api'
  promptSignals:
    phrases:
      - "vc traces"
      - "@vercel/otel"
      - "registerotel"
      - "instrumentation hook"
      - "opentelemetry"
      - "open telemetry"
      - "enable tracing"
      - "set up tracing"
      - "add tracing"
      - "distributed tracing"
      - "always-on tracing"
      - "session tracing"
      - "trace sampling"
      - "sampling rule"
      - "context propagation"
      - "traceparent"
      - "custom span"
      - "measure how long"
      - "ttfb"
      - "time to first byte"
      - "high latency"
      - "reduce latency"
      - "performance regression"
      - "failed requests"
      - "production errors"
    allOf:
      - [vercel, tracing]
      - [vercel, traces]
      - [vercel, spans]
      - [vercel, instrument]
      - [otel, instrument]
      - [sentry, otel]
      - [sveltekit, otel]
      - [always, tracing]
      - [traces, disconnected]
      - [api, slow]
      - [endpoint, slow]
      - [route, slow]
      - [function, slow]
      - [page, slow]
      - [request, slow]
      - [query, slow]
      - [database, slow]
      - [loader, slow]
      - [action, slow]
      - [server, slow]
      - [app, slow]
      - [take, seconds]
      - [p95, latency]
      - [slow, since, deploy]
      - [slower, since, deploy]
      - [sluggish, deploy]
      - [performance, degraded]
      - [performance, api]
      - [performance, endpoint]
      - [performance, route]
      - [performance, server]
      - [performance, function]
      - [speed up, api]
      - [speed up, route]
    noneOf:
      - "the build"
      - "my build"
      - "slow build"
      - "build time"
      - "build takes"
      - "to build"
      - "vercel deploy"
      - "deploy is slow"
      - "deploys are slow"
      - "deployments are slow"
      - "deploy takes"
      - "ci pipeline"
      - "github actions"
      - "test suite"
      - "dev server"
      - "hmr"
      - "hot reload"
      - "re-render"
      - "re-renders"
      - "spinner"
      - "animation"
      - "scroll"
      - "scrolling"
      - "interaction"
      - "file tracing"
      - "bundle size"
      - "lcp"
      - "core web vitals"
      - "lighthouse"
    minScore: 4
retrieval:
  aliases:
    - Vercel Tracing
    - always-on tracing
    - vc traces
    - Vercel OpenTelemetry
  intents:
    - set up OpenTelemetry for a Vercel project
    - wire @vercel/otel into a framework's server startup hook
    - add custom spans around application operations
    - connect disconnected traces across services
    - configure trace sampling
    - verify instrumentation by inspecting a collected trace
    - debug failed requests or production errors using traces
    - make a slow API route or server function faster
  entities:
    - "@vercel/otel"
    - "@opentelemetry/api"
    - vercel traces search
    - vercel traces inspect
    - vercel traces config
    - vercel traces create
    - vercel curl --trace
  examples:
    - add OpenTelemetry to my app deployed on Vercel
    - set up @vercel/otel in my SvelteKit app
    - propagate trace context to my backend API
    - debug production errors in my Vercel app
    - this endpoint is slow, make it faster
---

# Vercel Tracing

Use Vercel Tracing to instrument server code with OpenTelemetry and inspect spans from deployed traffic. The workflow is **register `@vercel/otel` from the framework's server startup hook → deploy and exercise a server route → search and inspect the trace with `vercel traces`**. Use the same traces to debug failed requests and measure slow operations. Read only the references needed for the current task.

Tracing only covers requests that run server code: dynamic routes, API routes, functions, and on-demand rendering. Static and prerendered pages and CDN cache hits run no application code, so traces cannot explain or speed them up; optimize those with caching, bundle size, and Core Web Vitals work instead.

## Reference index

| Reference | Read when |
| --- | --- |
| [Collection](references/collection.md) | Deciding which spans need application setup, or choosing always-on tracing, request capture, or a browser session |
| [Instrumentation](references/instrumentation.md) | Discovering a framework's startup hook, wiring and verifying SDK setup, or using Sentry |
| [Next.js](references/nextjs.md) | Setting up Next.js instrumentation or enabling verbose spans |
| [SvelteKit](references/sveltekit.md) | Enabling server tracing and the instrumentation hook on SvelteKit 2 or 3 |
| [Custom spans](references/custom-spans.md) | Measuring an application operation and recording failures |
| [Context propagation](references/context-propagation.md) | Connecting traces across services: outbound URL matching, non-fetch clients and queues, incoming requests |
| [Configuration](references/configuration.md) | Inspecting or changing always-on tracing sampling rules |
| [Capture](references/capture.md) | Reproducing a request or tracing a browser flow |
| [Search](references/search.md) | Finding slow or failed spans, choosing filters, or parsing results |
| [Inspection](references/inspection.md) | Retrieving a request trace and choosing timeline, tree, or waterfall |
| [Performance](references/performance.md) | Making a route, API, function, or server-rendered page faster: wrapping operations in custom spans, reading exact durations, comparing before and after |
| [Troubleshooting](references/troubleshooting.md) | Investigating empty results, failed lookups, missing spans, or truncated attributes |

## Setup workflow

1. Check existing setup: framework and adapter versions, any registered OpenTelemetry provider or Sentry v8+, and framework tracing flags. Extend an existing provider; never register a second one.
2. Decide what needs application setup. Infrastructure and outbound-fetch spans are automatic; framework and custom spans need `@vercel/otel`. See [collection](references/collection.md).
3. Install `@vercel/otel` and `@opentelemetry/api`, then register the SDK once from the framework's verified server startup hook. On Next.js, that is `register()` in `instrumentation.ts`:

   ```ts
   import { registerOTel } from '@vercel/otel';

   export function register() {
     registerOTel({ serviceName: 'checkout' });
   }
   ```

   For other frameworks, follow [SvelteKit](references/sveltekit.md) or [another framework](references/instrumentation.md#integrate-another-framework); see [Next.js](references/nextjs.md) for verbose spans and prerendering. Next.js and SvelteKit join the incoming request trace automatically; other frameworks may need [incoming-context extraction](references/context-propagation.md#incoming-requests). Add [custom spans](references/custom-spans.md) and [context propagation](references/context-propagation.md) where needed.
4. Build, deploy to preview or production, exercise a server-executed route, and [inspect its trace](references/inspection.md). Confirm span names and parent relationships with `inspect`, and `service.name` with search JSON. A local exporter check does not prove Vercel collection.

## Investigation workflow

Investigate errors and improve application performance with traces. Measure before optimizing: don't claim a speedup until deployed spans confirm it.

When the cause looks obvious in the code, such as sequential awaits, still measure. Add spans around the suspected operations in the same change as the fix, or in a baseline deploy first when one is possible. Report the expected gain as an estimate until deployed traces confirm it, and name the spans the user should compare. Code reading finds candidates; it does not show which one dominates on Vercel, where database location, cold starts, and external APIs change the cost.

1. Confirm the slow or failing route runs server code on each request; a static, prerendered, or cached response has no application spans. Verify preview or production deployment, collection mode, and traffic. Check application OpenTelemetry setup for framework and custom spans and sampling rules for always-on tracing. Reuse completed setup.
2. Find slow or failed requests for the affected project, route, environment, and time window, or capture a reproduction.
3. Wrap each suspected operation (database queries, external calls, cache reads, rendering, CPU-heavy work) in a custom span with `startActiveSpan`, deploy, and read exact durations from traces. Save these as the baseline.
4. Inspect traces to locate failed operations, the slowest span on the critical path, sequential waits, and unmeasured gaps between a parent and its children; relate them to application code. Add spans to any gap and measure again.
5. Change the measured cause, keeping its span. After deploying, compare that span and the whole request across equivalent requests under similar load and collection settings. Report before and after timings, sample counts, errors, and remaining uncertainty.

A limited span search is not a complete latency distribution. Use browser profiling alongside traces for rendering or interaction bottlenecks.

## CLI scope

Confirm that `vercel traces --help` lists the subcommand needed. `vc` and `vercel` are equivalent.

The CLI runs with `--non-interactive` by default when it detects an agent. In that mode `search` and `config` print JSON, `search --columns` is rejected, production capture needs `--yes`, and `config rm` returns the command for the user to run instead of prompting.

Search covers all projects in the selected team, even from a linked directory. Use `--scope` for the team and `--project` for one application's search. `inspect` and `config` remain project-scoped; after a team search, use the result's project for retrieval.

Do not change sampling merely to investigate an issue. Empty sampled results do not prove a request never happened; distinguish authentication or API failures from successful empty searches.
