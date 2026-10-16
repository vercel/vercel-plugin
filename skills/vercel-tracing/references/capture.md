# Targeted capture

Use this reference to reproduce a request or browser flow without changing always-on tracing rules. Verify [collection prerequisites](collection.md); framework and custom spans still need deployed instrumentation.

## Capture a request

Target the deployment explicitly, from a directory linked to the same project. `vercel traces create` is an alias for `vercel curl --trace`:

```bash
vercel traces create /api/status --deployment https://my-app-abc123.vercel.app --scope my-team --json
```

Without `--deployment`, the CLI picks the linked project's deployment and prefers production. Production capture needs `--yes` in non-interactive mode. The CLI adds a protection bypass for protected deployments; for other access, `⤳ skill: access-protected-vercel-deployment`.

Pass curl options after `--`, for example to reproduce an authorized POST:

```bash
vercel traces create /api/test --deployment https://my-app-abc123.vercel.app --scope my-team -- --request POST --header 'Content-Type: application/json' --data '{"name":"John"}'
```

With `--json`, the command prints `{ response, requestId }`, not search JSON Lines. `response` is the body only; to see the HTTP status, rerun without `--json` and add `-- --silent --output /dev/null --write-out '%{http_code}\n'`. [Inspect](inspection.md) `requestId` in the deployment's project and team; if the result is not the captured request, see [troubleshooting](troubleshooting.md#inspect-returns-the-wrong-trace). See [CLI capture](https://vercel.com/docs/cli/traces#create).

## Capture a browser flow

Use a preview or production deployment with the Vercel Toolbar enabled:

1. Open **Tracing** in the Toolbar. Select **Run Page Trace** for one page load, or **Start Tracing Session** for a flow; the page reloads to activate capture.
2. Reproduce the flow. Open the completed page trace or **View Session Traces** to inspect captured requests.
3. Select **Stop Tracing Session** when finished. Sessions stay active until stopped or browser cookies are cleared.

See [browser capture instructions](https://vercel.com/docs/tracing/session-tracing). Use [inspection](inspection.md) to choose a trace view.
