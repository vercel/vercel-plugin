# Projects & Teams

## Projects

```bash
vercel project ls                    # list projects
vercel project add my-project        # create project
vercel project inspect my-app        # inspect project
vercel project rm my-app             # remove project
```

## Import Candidates

Discover up to five recently pushed Git repositories that have not been imported to Vercel:

```bash
vercel projects import-candidates --limit 5 --scope my-team
vercel projects import-candidates --limit 5 --format json --scope my-team
```

The command is read-only. In agent workflows, use JSON output to seed context, then present the candidates and require the user to select one before creating a project, connecting Git, or deploying. Use `⤳ skill: vercel-project-import` for the approval-gated import workflow.

## Deployments

```bash
vercel list                          # list deployments
vercel list --status READY           # filter by status
vercel list -m gitBranch=main        # filter by metadata
vercel inspect <url>                 # deployment details
vercel remove <name|id>              # remove deployments
vercel remove my-app --safe          # skip aliased deployments
```

## Teams

```bash
vercel whoami                        # current user and team
vercel teams ls                      # list teams
vercel teams switch                  # interactive team picker
vercel teams switch my-team          # switch by slug
vercel teams invite user@example.com # invite member
```

## Scoping

Use `--scope` or `--team` on any command to target a specific team:

```bash
vercel deploy --scope my-team
```
