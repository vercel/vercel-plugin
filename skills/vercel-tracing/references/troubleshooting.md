# Missing or incomplete traces

Use this reference when search is empty, retrieval fails, or expected span details are missing.

## Search returns no spans

1. Confirm `vercel traces --help` lists `search`. Distinguish authentication or API errors and rejected KQL from successful empty results.
2. Check the selected team, project, environment, and query window. Search is team-wide unless `--project` is provided; retention may be shorter than accepted time bounds.
3. Verify [collection](collection.md) and traffic after it was enabled. For always-on tracing, check first-match rules, excluded paths, and the inbound sampling decision. For targeted capture, check that the request or session was captured.
4. Check deployed [instrumentation](instrumentation.md) for framework and custom spans. Incoming context and competing SDK providers can prevent collection; see [propagation](context-propagation.md).
5. Check the telemetry limits below and the [search limits](search.md#limits-the-cli-enforces): search hides internal-kind spans from `vercel.*` services, which still appear in `inspect`. Custom spans from Edge runtime functions do not appear in traces.

## Library or fetch spans are missing

- A library emits no spans after `registerOTel`: most need an opt-in; see [library spans](library-spans.md).
- Outbound fetch spans disappeared after adding `instrumentations` to `registerOTel`: the option replaces the default, so add `'auto'` back to the list.
- The build log reports `Detected OpenTelemetry dependency`, but no fetch spans appear: Vercel leaves fetch spans to the application when it finds `@vercel/otel`, `@opentelemetry/api`, or `@opentelemetry/sdk-trace-node`. Confirm that `registerOTel` runs in the deployed runtime, or remove the unused OpenTelemetry packages.

## Inspect returns the wrong trace

When `inspect <requestId>` shows `Endpoint: <unknown>`, only a few spans, or custom spans as roots, find the request's own trace: run `vercel traces search --request-id <id> --project <project> --json`, take the `.data.span.traceId` of the `GET <path>` span, and inspect that trace ID. Two causes:

- Startup spans share the request ID. Next.js emits `register instrumentation` and `prepare route module` as separate root traces.
- The app does not extract incoming context, so each custom span starts its own trace and the request's trace has none. Enable `tracing.server` on SvelteKit, or follow [context propagation](context-propagation.md#incoming-requests) for other frameworks.

## Trace lookup returns 404

A searchable ID does not guarantee `inspect` can retrieve it; the CLI prints `Trace not found (404)` and exits 1. Request-ID lookup needs a matching root span in the same project within 30 minutes after the request-ID timestamp. Retry with the span's trace ID (`.data.span.traceId` in search JSON), which skips that request-ID resolution. Verify the ID, team, and the result's project. A missing root can cause 404; do not automatically attribute it to retention.

## Oversized telemetry

`inspect` warns `Trace is incomplete because it exceeded the span limit.` when it returns a partial trace; treat its span tree and repeated-operation counts as incomplete. Spans over 1 MB compressed can have large attributes truncated; `<attribute_name>.truncated: true` identifies affected values. Spans still over 1 MB after truncation are dropped. Each traced request is limited to 10 MB compressed.

Inspect span attributes for truncation markers. Reduce large payload attributes in the instrumentation and deploy before reproducing; sampling changes do not fix oversized telemetry. See [attribute truncation](https://vercel.com/docs/tracing#attribute-truncation) and [trace limits](https://vercel.com/docs/tracing#limitations).

For current retention and pricing, consult [collection documentation](https://vercel.com/docs/tracing/always-on-tracing) rather than assuming the CLI's accepted window is retained.
