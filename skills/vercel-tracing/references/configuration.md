# Sampling rules reference

Use this reference for always-on tracing. [Request and browser capture](capture.md) work separately from these rules.

## Inspect and configure

Inspect rules in the intended project before changing them:

```bash
vercel traces config ls --scope my-team --project my-app --json
```

For an authorized sampling change, set the rate and verify the resulting rules:

```bash
vercel traces config set production 10 /api --scope my-team --project my-app
vercel traces config ls --scope my-team --project my-app --json
```

## Rule matching

Rules match an environment and optional path prefix. `set` changes the rate for an existing pair or appends a new rule. Environments are `production`, `preview`, and `any`. The first matching rule wins, so an earlier broad rule can shadow a later narrow rule. Up to 10 rules are allowed. CLI rates are integers from 1 to 100; use the dashboard for a zero-rate exclusion. A positive rule enables always-on tracing; removing all rules disables it. Requests matching no rule are not collected. Sampling makes one decision per trace, rather than sampling its spans independently; [size limits](troubleshooting.md#oversized-telemetry) can still leave spans missing.

## Trace Drains are separate

Trace Drains use their own rules. An empty Drain rule set forwards all traces; an empty always-on tracing rule set collects none. Do not infer one configuration from the other. See [Trace Drain sampling](https://vercel.com/docs/drains/reference/traces#sampling-rate).

## Remove rules

`rm production /api` removes one rule, `rm production --default` removes only the rule without a path prefix, and `rm production` removes every production rule. `rm any` removes only rules whose environment is `any`, not every rule. See the [CLI reference](https://vercel.com/docs/cli/traces#config-rm).

Removal requires an interactive confirmation and has no bypass flag. In non-interactive mode, `rm` lists the rules at risk and returns the exact command to run in a terminal; give that command to the user. When tracing is disabled but saved rules remain, `rm` refuses until `set` re-enables tracing. Do not change sampling merely to investigate an issue. Consult [collection pricing and retention](https://vercel.com/docs/tracing/always-on-tracing) for current pricing and retention.
