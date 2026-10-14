# Advanced Commands

## `vercel api` — Fallback for Missing CLI Commands

**Use `vercel api` when a CLI command doesn't exist for what you need.** Full access to the Vercel REST API with automatic authentication.

Use first-class CLI commands before `vercel api` whenever they expose the data or mutation you need.

Use `vercel api` when:

- The first-class CLI command does not exist.
- The first-class command omits fields needed for the answer.
- JSON output is needed for filtering or aggregation.
- Endpoint discovery is needed through `vercel api list`.

Keep calls narrow and shape large responses before presenting them. Add `--raw` when a downstream parser should receive only the JSON response payload. Use `--raw-field` instead of typed `--field` when the API expects a string value that looks like a boolean or number.

```bash
vercel api /v2/user                                    # GET current user
vercel api /v9/projects --scope my-team                # list projects
vercel api /v10/projects -X POST -F name=my-project    # create project
vercel api /v6/deployments --paginate                  # paginate all results
vercel api list                                        # list available endpoints
vercel api list --format json                          # list endpoints as JSON
vercel api "/v6/deployments?projectId=<project-id>&limit=10" --scope <team>
vercel api "/v6/deployments?limit=10" --raw            # JSON payload
vercel api /v9/projects/<project>/env/<env-id> -X PATCH --raw-field value=false --scope <team>
```

Use `vercel api list` to discover available endpoints. `vercel api ls` is also accepted as an alias.

Do not parse `vercel api --generate=curl` output as JSON; it emits a curl command.

DELETE requests prompt for confirmation; in non-interactive/agent mode they are refused unless `--dangerously-skip-permissions` is passed. Use that flag only for deletions the user explicitly approved.

## `vercel traces` — Captured Request Traces

Fetch traces captured for a Vercel project. `inspect` is the default subcommand.

```bash
vercel traces inspect req_1234567890                                   # markdown summary
vercel traces req_1234567890                                           # equivalent (inspect is default)
vercel traces inspect req_1234567890 --json                            # raw trace JSON to stdout
vercel traces inspect req_1234567890 --scope my-team --project my-app  # specific team/project
vercel traces inspect req_1234567890 --open                            # open in Vercel Dashboard
vercel traces inspect req_1234567890 --open --view waterfall           # specific dashboard view (timeline, tree, waterfall)
```

`--view` is only valid alongside `--open`.

`vercel traces search` searches spans across the team, or one project with `--project`, newest first, from the last hour by default:

```bash
vercel traces search --environment production --status error --since 1h
vercel traces search --query 'span.duration > 2000' --json
vercel traces search --next <cursor> --json                         # continue from the summary's pagination.next
```

With `--json`, each span is a `{"type":"span","data":{...}}` line, and the output ends with a `summary` line (`recordsReturned`, `timeRange`, `pagination: { hasMore, next }`, `excludedIntervals`). Read spans under `.data`, for example `jq 'select(.type == "span") | .data.span.name'`. When more spans match, continue with `--next` instead of raising `--limit`; the cursor keeps the team, project, filters, and window, so only `--limit` can change. A request ID from search results or logs does not guarantee that `vercel traces inspect` can retrieve the trace; reuse the same `--scope` and `--project`.

## Other Commands

- `vercel webhooks` — manage webhooks (create, ls, rm)
- `vercel mcp` — set up MCP integration for AI agents
- `vercel telemetry` — manage telemetry settings
- `vercel upgrade` — upgrade the CLI
