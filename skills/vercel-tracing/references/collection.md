# Collection prerequisites

Use this reference before setup or querying when collection is uncertain. Reuse completed setup.

## Choose the spans needed

Infrastructure and outbound-fetch spans are automatic and need no application OpenTelemetry setup. Framework and custom spans need [application instrumentation](instrumentation.md) deployed to the target environment. Library spans also need it, plus an [opt-in](library-spans.md) for each installed library that has one. See [automatic instrumentation](https://vercel.com/docs/tracing#automatic-instrumentation).

## Choose a collection mode

| Mode | Use for | Required setup |
| --- | --- | --- |
| Always-on tracing | Investigating sampled traffic already captured | Matching positive [sampling rules](configuration.md) for the project, environment, and paths |
| Single request | Reproducing an endpoint from the terminal | [CLI request capture](capture.md#capture-a-request) against a deployment |
| Browser session or page | Reproducing a flow interactively | [Browser capture](capture.md#capture-a-browser-flow) with the Vercel Toolbar enabled |

Request and browser capture do not require always-on tracing rules. See [session tracing](https://vercel.com/docs/tracing/session-tracing).

## Verify before querying

1. Select the intended team, project, and preview or production deployment. Local execution alone is insufficient.
2. For framework and custom spans, check that [instrumentation](instrumentation.md) is deployed.
3. Check the selected mode's setup. For always-on tracing, inspect existing rules before an authorized change; see [configuration](configuration.md).
4. Send requests after collection is enabled. Query the same project, environment, and time window, then [inspect a representative trace](inspection.md).

Use [troubleshooting](troubleshooting.md) if the expected spans are absent.
