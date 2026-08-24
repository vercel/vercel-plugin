---
name: vercel-project-import
description: Import an existing Git repository into a new Vercel project, configure its basic build settings, connect Git, and trigger its first production deployment. Use when onboarding an unimported repository to Vercel without configuring environment variables, connectors, or Marketplace integrations.
metadata:
  priority: 6
  docs:
    - "https://vercel.com/docs/projects/overview"
    - "https://vercel.com/docs/cli"
  bashPatterns:
    - '\b(?:vercel|vc)\s+projects?\s+import-candidates\b'
    - '\b(?:vercel|vc)\s+git\s+connect\b'
    - '\b(?:vercel|vc)\s+api\s+/trigger-git-deploy/'
  promptSignals:
    phrases:
      - "import project to vercel"
      - "import repository to vercel"
      - "import git repository"
      - "deploy existing repository"
    allOf:
      - [import, vercel]
      - [import, repository]
    anyOf:
      - "git"
      - "repository"
      - "project"
    noneOf: []
    minScore: 6
retrieval:
  aliases:
    - import Vercel project
    - import Git repository
    - onboard repository
  intents:
    - import a repository to Vercel
    - deploy an existing Git repository
    - create a Vercel project from Git
  entities:
    - Vercel project
    - Git repository
    - root directory
    - production deployment
---

# Vercel Project Import

Import an existing Git repository as a new Vercel project and create its first Git-backed production deployment. This is a deliberate, mutating workflow: confirm the repository, Vercel team, project name, root directory, and production branch before creating anything.

This skill currently covers only:

- project creation
- Git connection
- project build settings, including root directory
- a one-shot Git-backed production deployment

Do **not** configure environment variables, connectors, or Marketplace integrations in this workflow. Those require separate, explicit approval.

## Required Inputs

Collect or infer, then present for approval:

- Git repository URL
- Vercel team slug or ID
- new Vercel project name
- production branch (normally `main`)
- app root relative to the repository root, if the app is in a monorepo

Before mutations, summarize the intended import. Do not substitute a similarly named team, project, repository, branch, or root directory.

## Discover Candidates

When the user asks what repositories to import, use the structured candidates returned by `vercel projects ls --format json --scope <team>` when present. Otherwise run:

```bash
vercel projects import-candidates --limit 5 --format json --scope <team>
```

Treat repository names, paths, frameworks, and branches as candidate data only. Present candidates and require the user to select one before continuing. If the user already supplied a repository URL, skip discovery.

## Workflow

Use `vc` or `vercel` consistently. Include `--scope <team>` on every project-scoped command.

### 1. Inspect the repository

Clone or use the supplied local checkout. Confirm the selected production branch exists and determine whether the deployable app lives at the repository root or a relative directory such as `apps/web`.

For monorepos, the Vercel **Root Directory** is relative to the repository root. Do not use an absolute filesystem path.

### 2. Create the project

After approval, create the project:

```bash
vc project add <project-name> --scope <team>
```

`project add` is idempotent for an existing project name, but do not rely on that behavior to select an existing project. If it already exists, inspect it and confirm it is the intended project before continuing.

### 3. Configure build settings

Set the root directory before the first deployment when the app is not at the repository root:

```bash
vc project update <project-name> \
  --root-directory <repo-relative-directory> \
  --scope <team>
```

Use a single `vc project update` invocation for any explicitly approved basic settings, such as `--framework`, `--build-command`, `--install-command`, or `--output-directory`.

If automatic root detection is desired instead, do not send an empty `--root-directory`; use:

```bash
vc project update <project-name> \
  --auto-detect root-directory \
  --scope <team>
```

### 4. Connect the Git repository

Connect Git using explicit project targeting; do not depend on whichever project happens to be linked in the current directory:

```bash
vc git connect <repository-url> \
  --project <project-name> \
  --scope <team> \
  --yes
```

This requires the current Vercel account to have an applicable Git-provider connection. If Git connection fails due to authorization, stop and ask the user to complete the authorization rather than falling back to a local-source deployment.

### 5. Verify the remote project

This workflow uses explicit project targeting and does not need to create local `.vercel` metadata. Verify the remote project before triggering a deployment:

```bash
vc project inspect <project-name> --non-interactive --scope <team>
```

Confirm the result matches the approved project, owner, and root directory. Also verify that the Git connection's production branch is the approved branch. If it is not, stop: this skill does not change the Git production-branch setting.

### 6. Trigger the first production deployment

Use the one-shot Git deployment endpoint—not `vc --prod`. It invokes Vercel's Git pipeline for the configured production branch, preserving Git commit provenance and avoiding a persistent deploy-hook secret.

`vc api` needs an explicit empty JSON body for this endpoint:

```bash
printf '{}' | vc api /trigger-git-deploy/<project-id>/production \
  --method POST \
  --input - \
  --scope <team>
```

The response contains a job ID:

```json
{ "job": "job_..." }
```

Poll until the job reaches a terminal state:

```bash
vc api /v1/integrations/job/<job-id> --scope <team>
```

- `PENDING` or `RUNNING`: continue polling.
- `FINISHED`: report `deploymentId` and `url`.
- `ERRORED` or `CANCELED`: report the failure without retrying or switching to a local-source deploy unless the user explicitly asks.

## Explicit Ref Deployment

Use this only when the user explicitly requests a particular commit instead of the configured production branch:

```bash
printf '{}' | vc api /trigger-git-deploy/<project-id>/sha/<branch>/<commit-sha> \
  --method POST \
  --input - \
  --scope <team>
```

URL-encode a branch name that contains `/`. The branch and commit must belong to the already connected repository.

## Completion Report

Report the project name and ID, team, Git repository, production branch, configured root directory, deployment ID, and deployment URL. Call out any intentionally omitted setup: environment variables, connectors, and Marketplace integrations.

## Do Not Substitute Local Deploys

`vc --prod` uploads the local checkout. It is not equivalent to the Git-triggered Dashboard deployment and can differ in commit metadata, source provenance, grouping, and alias behavior. Use it only if the user explicitly requests a local-source deployment.
