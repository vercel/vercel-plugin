# Monitoring & Debugging

## Diagnostic Ladder

For production issues, start broad and narrow with bounded commands:

1. Identify project and scope.
2. List recent deployments: `vercel list <project> --scope <team> --status READY --format json`.
3. Inspect the relevant deployment: `vercel inspect <deployment-url>`.
4. Check logs for a bounded window: `vercel logs --deployment <deployment-url> --since 1h --limit 100 --json`.
5. If metrics are available, inspect schema first, then query a relevant metric with a bounded time window and group-by.
6. If logs or metrics are unavailable, report the permission, subscription, retention, or no-data limitation and use deployments, activity, or inspect output as fallback evidence.

## Build Failure Ladder

For deployment build failures, start from deployment evidence before source
control exploration:

1. Inspect deployment metadata: project, team/scope, branch, commit, target,
   status, timestamp, and aliases.
2. Inspect build logs with `vercel inspect <deployment-url> --logs`.
3. Capture install command, package manager version, build command,
   monorepo/Turbo scope, restored build cache ID, and the first fatal error.
4. Reduce the first fatal error before chasing warnings.
5. If source is implicated, inspect only the app/package files, lockfile, build
   config, and files named in the trace.
6. Compare with a nearby successful deployment of the same project: commit,
   cache ID, install command, package manager version, build command, package
   scope, and source provenance.
7. Separate proven root cause from likely trigger.

For branch-specific failures, "other branches pass" does not by itself disprove
the root cause. Compare cache IDs, install graphs, lockfile/package diffs, build
command, package scope, and source provenance before explaining why one branch
fails.

Use confidence language in conclusions:

- Logs prove `<root cause>`.
- Branch comparison shows `<facts>`.
- Likely trigger is `<hypothesis>`.
- Not yet proven is `<remaining uncertainty>`.
- Validate by `<specific redeploy/test/check>`.

Useful discovery commands:

```bash
vercel logs --help
vercel metrics --help
vercel metrics schema --format=json
vercel metrics schema <metric-or-prefix> --format=json
vercel activity --help
vercel activity types --format json --scope <team>
vercel usage --help
vercel httpstat /api/health --deployment <deployment-url>
```

## Logs

`vercel logs` reads runtime log entries by default; `vercel logs requests` reads CDN request records (status, method, cache result, path) and excludes background function executions. Each run returns a bounded result and exits: by default the latest 100 records from the last 30 minutes, newest first.

```bash
vercel logs                                                         # recent runtime logs for the linked project
vercel logs --deployment <deployment-url>                           # one deployment
vercel logs --environment production --query 'level:error'          # production errors
vercel logs --query 'level:(error OR warning) AND timeout' --since 2h
vercel logs --query 'requestId:"<request-id>"' --json               # what one request logged
vercel logs requests --query 'httpStatus >= 500 AND httpStatus < 600' --since 1h
vercel logs requests --query 'requestPath:*checkout* AND cacheResult:MISS'
vercel logs --next <cursor>                                         # continue a previous query
```

Filter with `--query` (KQL-inspired: `field:value`, `field:(a OR b)`, `field != value`, `field:*text*`, `AND`/`OR`/`NOT`, and numeric comparisons for requests). `vercel logs runtime --help` and `vercel logs requests --help` list the common fields. The `--level`, `--source`, `--status-code`, `--request-id`, and `--search` flags were removed; express them as query fields. `--branch` and `--expand` were dropped without a replacement; full messages are shown by default. Select a deployment with `--deployment`, not a positional argument. Without `--deployment` or `--environment`, logs cover every environment of the project. Only team-owned projects are supported. Older CLI versions use different flags; check `vercel logs --help` first.

Set `--since` and `--until` to the affected window.

With `--json` (implied by `--non-interactive` and in agents), output is JSON Lines: one `{"type":"log"|"request","data":{...}}` line per record, optional `warning` lines, and a final `summary` line with `recordsReturned`, `timeRange`, `pagination: { hasMore, next }`, and `excludedIntervals`. Read fields under `.data`, for example `jq 'select(.type == "log") | .data.message'`. Before concluding that something did not happen, check `pagination.hasMore` and `excludedIntervals`. To read more, pass `pagination.next` to `--next` rather than raising `--limit` or widening the window; the cursor keeps the original target, filter, and window, and only `--limit` can change.

CDN request history beyond the plan's free window, and filters on fields that need Observability Plus or a Priority project, fail with an access error that names the requirement. Report that as an entitlement limit, not as missing traffic.

## Metrics

Inspect schema before querying unfamiliar metrics. Use bounded time windows and group limits when grouping results.

```bash
vercel metrics schema                                                    # list available metrics
vercel metrics schema vercel.function_invocation                         # inspect a metric prefix
vercel metrics vercel.function_invocation.count --since 1h               # query linked project
vercel metrics vercel.function_invocation.count -f "http_status ge 500" --group-by error_code --since 1h --format=json
vercel metrics vercel.function_invocation.request_duration_ms -a avg --group-by route --since 1h
vercel metrics --all vercel.function_invocation.count --group-by project_id --since 24h
```

## Inspecting Deployments

```bash
vercel inspect <url>               # deployment details
vercel inspect <url> --wait        # wait for completion
vercel inspect <url> --logs        # show build logs
```

If a redeploy is meant to validate a build-cache or branch-specific hypothesis,
inspect or wait until the new deployment reaches `Ready` or `Error`; do not stop
at `Building` unless the user only asked to start the deployment.

## `vercel curl` — Access Preview Deployments

**Use `vercel curl` to access preview deploys.** It handles deployment protection automatically — no need to disable protection or manage bypass secrets.

```bash
vercel curl /api/health --deployment $PREVIEW_URL
vercel curl /api/data --deployment $PREVIEW_URL -- -X POST -d '{"key":"value"}'
```

**Do not disable deployment protection.** Use `vercel curl` instead.

## Finding Regressions

`vercel bisect` performs a binary search across deployments to find which one introduced a problem:

```bash
vercel bisect --good <url> --bad <url> --path /api/users
vercel bisect --run ./test-script.sh    # automated testing
```

## Cache

```bash
vercel cache purge --type cdn --yes      # purge CDN cache
vercel cache invalidate --tag mytag --yes # invalidate by cache tag
```

See `references/project-infra.md` for destructive cache deletion and other project infrastructure commands.
