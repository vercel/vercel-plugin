# Span search reference

Use this reference to find slow or failed spans across a team or project. Verify [collection](collection.md) for the spans and projects under investigation. Use `vercel traces search --help` or the [CLI reference](https://vercel.com/docs/cli/traces#search) for the full filter, field, and column list.

## Select the team and project

Search covers all projects in the selected team, even from a linked project directory. `--project` restricts search to one project. Pass `--scope <team>`, and ask the user which team if you don't know it: since CLI 64, agents ignore the team saved by `vercel switch`, and `vercel switch` itself is refused (`agent_cannot_switch`). `inspect` and `config` still operate on a single project.

## Find slow or failed requests

Use the affected project, environment, and time window:

```bash
vercel traces search --scope my-team --project my-app --environment production --status error --since 1h --json
vercel traces search --scope my-team --project my-app --environment production --query 'span.duration > 2000' --since 1h --json
vercel traces search --scope my-team --project my-app --environment production --query 'http.route:"/api/checkout"' --kind server --since 1h --json
```

Direct filters and `--query` combine with AND. KQL is field-based, not full-text, and the CLI does not normalize values:

- `span.duration` is in milliseconds.
- `span.status.code` uses `Error`, `Ok`, or `Unset`.
- `span.kind` uses OTLP values 0–5 (2 server, 3 client), which differ from the JavaScript SDK's enum values.
- Other field names search span attributes first, then resource attributes, for example `http.status_code >= 500`.

A rejected query is an error, not evidence of zero matching spans.

## Limits the CLI enforces

- Defaults are the last hour and 100 spans; `--limit` accepts 1–1000.
- `--since` must be within the last 30 days, and the window cannot exceed 30 days. Actual retention can be shorter.
- ISO timestamps need `Z` or an offset; dates mean midnight UTC.
- Results are newest first. Duration filters do not sort by duration.
- Search always excludes internal-kind spans (`span.kind` 1) from services whose names start with `vercel.`. Those spans can appear in `inspect` and the dashboard without appearing in search.

## Read the output

In non-interactive mode, the default when the CLI detects an agent, search prints JSON Lines even without `--json`, and `--columns` is rejected. Each span is a `{"type":"span","data":{...}}` line, and the output ends with a `summary` line holding `recordsReturned`, `timeRange`, `pagination: { hasMore, next }`, and `excludedIntervals`. Read spans under `.data`, for example `jq 'select(.type == "span") | .data.span.name'`:

- Trace ID: `.data.span.traceId`
- Span attributes: `.data.span.attributes`; events: `.data.span.events`; resource attributes: `.data.resource.attributes`
- Request ID: `.data.span.attributes["vercel.request_id"]`

CLI versions before 64 print bare `{ span, resource }` objects with no summary line or `--next`; check `vercel traces search --help`.

After a team search, [inspect](inspection.md) the result's trace ID with its project via `--project` and the same team via `--scope`.

Before concluding that a span does not exist, check the summary's `pagination.hasMore` and `excludedIntervals`. To read more, pass `pagination.next` to `--next` rather than raising `--limit` or widening the window. The cursor keeps the original project, filters, and window: repeat only `--scope` and optionally `--limit`, because the CLI rejects other search flags alongside `--next`. A summary with `recordsReturned: 0` is a successful search with no matches.

Use [inspection](inspection.md) for request retrieval and [troubleshooting](troubleshooting.md) for missing spans or lookup failures.
