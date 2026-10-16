# Inspect a trace

Use this reference after finding or capturing a representative request.

`vercel traces inspect` accepts either a trace ID or a request ID. A 32-character hexadecimal ID selects trace-ID lookup; any other ID selects request-ID lookup. Use a trace ID from `.data.span.traceId` in a JSON search result, or a request ID from logs, capture output, or `.data.span.attributes["vercel.request_id"]`. Prefer the trace ID; not every span has a request ID. After a team search, pass the result's project and the same team:

```bash
vercel traces inspect 0870e4ead46aafba39ccfbcb001835db --scope my-team --project my-app
vercel traces inspect qb46r-1790847620933-1145d2891a3e --scope my-team --project my-app --json
vercel traces inspect 0870e4ead46aafba39ccfbcb001835db --scope my-team --project my-app --open --view=tree
```

`inspect` is the default subcommand, so `vercel traces <id>` does the same. `vercel traces get` still works but prints a deprecation warning; older CLIs only have `get`, which may accept request IDs only. Check `vercel traces --help` and use whichever subcommand it lists.

Without `--project`, `inspect` uses the linked project. Without a link, pass `--scope` and `--project`.

## Output formats

- Default: a Markdown summary with the trace ID, request ID, endpoint, duration, span count, repeated operations (count, total, per-call time, and share of the root span), and a span tree with each span's duration, share, and start offset. Read this first; it often shows the slow or repeated operation directly.
- `--json`: the raw trace, with `traceId`, `rootSpanId`, and `spans[]`. Each span has `spanId`, `parentSpanId`, `name`, `attributes`, `status`, and `startTime` and `duration` as `[seconds, nanoseconds]` pairs. Progress lines go to stderr.
- `--open`: opens the dashboard. `--view` requires `--open`; `--open` cannot combine with `--json`.

`inspect` output omits span events, span kind, and resource attributes. Read `service.name` and recorded exceptions from [search](search.md#read-the-output) JSON (`.data.resource.attributes`, `.data.span.events`).

Expect platform spans next to application spans. Each outbound fetch appears twice: Vercel's `GET <host>/` span under the function span and the SDK's `fetch GET <url>` span under the active custom span. The SDK's export appears as `POST localhost/v1/traces`. The edge and function spans can share a name such as `GET /api/checkout`, so the repeated-operations table may count them as one repeated operation.

See [CLI retrieval](https://vercel.com/docs/cli/traces#inspect).

## Choose the view

| View | Investigate |
| --- | --- |
| `timeline` | Duration, overlap, and sequential waits |
| `tree` | Parent-child relationships and which operation called another |
| `waterfall` | Hierarchy and timing together |

Use timing to identify waits on the request's critical path; concurrent spans overlap, so adding all span durations overstates elapsed request time. Relate expensive or failed operations to application code before changing it. See [trace views](https://vercel.com/docs/tracing#switching-between-trace-views).

Save representative trace IDs and observed timings for comparison after deployment. Compare equivalent routes, inputs, environments, load, and collection settings; a few traces do not establish a complete latency distribution.

A searchable ID does not guarantee retrieval. Read [lookup troubleshooting](troubleshooting.md#trace-lookup-returns-404) when `inspect` returns `Trace not found (404)`.
