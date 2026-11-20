# Security

`vercel security` reads the current team's security posture. `vercel security check` runs the Security Dashboard checks, and `vercel security vulnerabilities` lists and triages Security Review findings. Both need a team scope; run `vercel switch` or pass `--scope <team>` when none is selected.

## Vulnerabilities

Security Review reports vulnerabilities it finds in a team's code. Use `vercel security vulnerabilities` to read and triage them from the terminal.

```bash
vercel security vulnerabilities                                   # open, Production and most severe first
vercel security vulnerabilities --project my-app --git-branch main
vercel security vulnerabilities inspect my-app/12                 # summary, description, and suggested fix
```

Each vulnerability has a reference, `<project>/<number>` or `<owner>/<repo>/<number>`. `inspect`, `dismiss`, and `reopen` accept the reference or the vulnerability ID.

`list` is the default subcommand. Filter with `--project`, `--repository`, `--environment`, `--git-branch`, `--severity`, `--status` (default `open`; `all` for every status), and `--query`. Results are paginated: follow the printed next-page command, or pass the `pagination.next` cursor from `--json` output to `--next`. List output omits descriptions and fixes, so `inspect` a vulnerability before acting on it.

If Security Review isn't enabled for the team, the command fails and says so. Which vulnerabilities you can see and change depends on the team role.

### Start from a pull request

Security Review adds a GitHub check to each commit it reviews. On private and internal repositories, it also posts each vulnerability as a comment on the branch's open pull request. Treat a check or comment as a pointer to a vulnerability. Before fixing it, read the vulnerability from the CLI, which has the full description, the suggested fix, and the current status:

```bash
vercel security vulnerabilities --repository my-org/my-app --git-branch my-feature   # open, on the pull request's head branch
vercel security vulnerabilities inspect my-app/12
```

`--repository` takes `<owner>/<repo>` and includes projects deployed from that repository. `inspect` each listed vulnerability, or go straight to `inspect` when the check or comment gives a reference or vulnerability ID.

### Fix a vulnerability

1. `inspect` it and confirm the issue is still present on its branch.
2. Make the smallest fix, then run the project's type checks, lint, and tests.
3. Push the fix to the same branch. A later review closes the vulnerability when it no longer detects the issue.

`closed` means a later review no longer detects the issue, not that a fix was verified. Severity is an AI-generated estimate, so judge each finding against the application.

### Dismiss or reopen

```bash
vercel security vulnerabilities dismiss my-app/12 --reason false-positive
vercel security vulnerabilities dismiss my-app/12 --reason accepted-risk --message "Internal tool behind SSO"
vercel security vulnerabilities reopen my-app/12
```

Dismissing records a decision for the team. Dismiss only when the user asks or agrees, not to clear a vulnerability you haven't fixed. `dismiss` requires `--reason` in non-interactive runs and with `--json`. Closed vulnerabilities can't be dismissed or reopened.

## Checks

```bash
vercel security                          # same as vercel security check
vercel security check --findings         # list findings under every check
vercel security check pats-no-expiration # run one check and list its findings
vercel security check --project my-app
```

Each check reports a risk, a status (`failing`, `passing`, `muted`, `no access`, or `error`), and violation and muted counts. In non-interactive runs, `check` writes JSON to stdout. A failing check still exits 0, so gate CI on the report contents, not the exit code.

## Sensitive output

Check reports include member emails, token names, and project settings. Vulnerabilities include source code and how to exploit it. Keep both out of shared logs, issues, and pull request comments.

## Docs

- https://vercel.com/docs/cli/security
- https://vercel.com/docs/agent/security-review/usage
