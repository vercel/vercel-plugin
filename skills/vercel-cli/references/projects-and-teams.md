# Projects & Teams

## Projects

```bash
vercel project ls                    # list projects
vercel project ls --filter my-app    # substring search by name
vercel project add my-project        # create project
vercel project inspect my-app        # inspect project
vercel project rm my-app             # remove project
```

`vercel project inspect` shows the Git repository that the project is connected to and its production branch (the `repository` field with `--json`). For the linked project, it also warns when the Git remotes of the current directory have a different name. Pushes deploy the project only when they go to the connected repository, so check this before you rely on `git push` to deploy.

## Deployments

```bash
vercel list                          # list deployments
vercel list --status READY           # filter by status
vercel list -m gitBranch=main        # filter by metadata
vercel inspect <url>                 # deployment details
vercel remove <name|id>              # remove deployments
vercel remove my-app --safe          # skip aliased deployments
```

`vercel list` returns one page of 20 and supports cursor pagination with `--next`; do not assume it accepts `--limit`. Use project, scope, status, environment, and metadata filters to keep deployment lists focused, or use `vercel api` when a strict page size is required.

## Teams

```bash
vercel whoami --format json          # current user and effective team
vercel teams ls                      # list teams
vercel teams switch                  # interactive team picker
vercel teams switch my-team          # switch by slug
vercel teams invite user@example.com # invite member
```

## Discovering Scope

Use these commands when the user has not specified a team or project and the task is read-only:

```bash
vercel whoami --format json
vercel teams ls --format json
vercel project ls --scope <team-slug> --format json
vercel list <project-name> --scope <team-slug> --status READY --format json
```

Use explicit scope after selecting or inferring the team:

```bash
vercel project inspect <project-name> --scope <team-slug>
vercel list <project-name> --scope <team-slug> --status READY --format json
```

Do not conclude that no projects or deployments exist after checking only one relevant scope. If several plausible targets remain, ask the user to choose from the candidates found. Avoid broad enumeration across unrelated teams unless the user asked for account-wide investigation.

## Scoping

Use `--scope` on any command to target a specific team. `--team` exists for compatibility but is deprecated.

```bash
vercel deploy --scope my-team
```
