# Security Checks and Security Review Vulnerabilities

`vercel security` reads the current team's security posture. It has two subcommands: `check` runs the Security Dashboard checks, and `vulnerabilities` lists and triages the findings that Vercel Security Review reports. Both need a team scope; run `vercel switch` or pass `--scope <team>` when none is selected.

## Security Review vulnerabilities

Use `vercel security vulnerabilities` to read Security Review findings. This is the path for a failing **Vercel Security Review** GitHub check: on a public repository the check names what it reviewed and links to the dashboard but never includes finding details, so the findings are not in GitHub at all. The dashboard needs a browser login, while the CLI reuses the existing authenticated context.

```bash
# Open vulnerabilities, Production and most severe first (list is the default)
vercel security vulnerabilities

# Narrow to the branch behind a pull request
vercel security vulnerabilities --project my-app --git-branch my-branch

# Show one vulnerability in full: summary, description, and suggested fix
vercel security vulnerabilities inspect my-app/12
vercel security vulnerabilities inspect my-app/12 --json
```

Each vulnerability has a reference: `<project>/<number>` for a project, or `<owner>/<repo>/<number>` for a repository. `inspect`, `dismiss`, and `reopen` accept the reference or the vulnerability ID.

`list` filters: `--project`, `--environment`, `--git-branch`, `--severity critical,high,medium,low`, `--status open,closed,dismissed` or `all` (default `open`), and `--query` to search titles, summaries, and descriptions. It returns 20 at a time (`--limit` up to 100) and prints the command for the next page; with `--json`, pass the `pagination.next` cursor to `--next`. List JSON omits descriptions and fixes, so `inspect` each vulnerability you act on.

When output is not a terminal, `list` prints tab-separated rows; pass `--json` for structured output. If Security Review is not enabled for the team, the command fails and says so. Which vulnerabilities you can see and change depends on the team role.

### Fixing a vulnerability

1. `inspect` the vulnerability and confirm the issue is still present in the code on that branch.
2. Apply the smallest fix that removes it, then run the project's type checks, lint, and tests.
3. Push the fix to the same branch. The next review closes the finding when it no longer detects the issue. `closed` means a later review no longer detects it; Vercel sets it, and it does not confirm the fix.

Severity ratings are AI-generated estimates. Review each finding against the application rather than treating severity as a fixed score.

### Dismissing and reopening

```bash
vercel security vulnerabilities dismiss my-app/12 --reason false-positive
vercel security vulnerabilities dismiss my-app/12 --reason accepted-risk --message "Internal tool behind SSO"
vercel security vulnerabilities reopen my-app/12
```

Dismissing records a decision on the team's behalf. Do it only when the user asks or agrees, never as a way to make a failing check pass. Without `--reason`, `dismiss` prompts, and it fails in non-interactive runs or with `--json`. Dismissing an already dismissed vulnerability, or reopening an open one, changes nothing and exits 0. Closed vulnerabilities cannot be dismissed or reopened.

## Security Dashboard checks

```bash
vercel security                          # same as vercel security check
vercel security check --findings         # expand findings under every check
vercel security check pats-no-expiration # run one check and list its findings
vercel security check --project my-app --json
```

`check` reports each check's risk, status (`failing`, `passing`, `muted`, `no access`, or `error`), violation count, and muted findings. Unknown slugs fail with the list of valid slugs. In non-interactive runs it writes the JSON report to stdout without `--json`. A failing check still exits 0, so gate CI on the report contents, not the exit code.

## Handle output as sensitive

Check reports include member emails, token names, and project settings. Vulnerabilities include source code and how to exploit it. Do not paste either into public logs, public pull request comments, or issues; a public repository's Security Review check omits details for exactly this reason.

## Docs

- https://vercel.com/docs/cli/security
- https://vercel.com/docs/agent/security-review/usage
