---
name: deployments-cicd
description: Vercel deployment and CI/CD expert guidance. Use when deploying, promoting, rolling back, inspecting deployments, building with --prebuilt, or configuring CI workflow files for Vercel.
metadata:
  priority: 6
  docs:
    - "https://vercel.com/docs/deployments/overview"
    - "https://vercel.com/docs/git"
    - "https://vercel.com/docs/deployments/promoting-a-deployment"
    - "https://vercel.com/docs/deployment-checks"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - '.github/workflows/*.yml'
    - '.github/workflows/*.yaml'
    - '.gitlab-ci.yml'
    - 'bitbucket-pipelines.yml'
    - 'vercel.json'
    - 'apps/*/vercel.json'
  bashPatterns:
    - '\bvercel\s+deploy\b'
    - '\bvercel\s+--prod\b'
    - '\bvercel\s+promote\b'
    - '\bvercel\s+rollback\b'
    - '\bvercel\s+inspect\b'
    - '\bvercel\s+build\b'
    - '\bvercel\s+deploy\s+--prebuilt\b'
validate:
  -
    pattern: 'cron:\s*[''"]|from\s+[''"](node-cron)[''"]|cron\.schedule\('
    message: 'Manual cron scheduling detected. Use Vercel Cron Jobs (vercel.json crons) for platform-native scheduled tasks.'
    severity: recommended
    skipIfFileContains: 'vercel\.json.*crons|@vercel/cron'
retrieval:
  aliases:
    - deploy
    - ci cd
    - continuous deployment
    - release pipeline
  intents:
    - deploy to vercel
    - set up ci cd
    - promote deployment
    - rollback deploy
  entities:
    - vercel deploy
    - preview
    - production
    - rollback
    - promote
    - CI workflow
---

# Vercel Deployments & CI/CD

You are an expert in Vercel deployment workflows — `vercel deploy`, `vercel promote`, `vercel rollback`, `vercel inspect`, `vercel build`, and CI/CD pipeline integration with GitHub Actions, GitLab CI, and Bitbucket Pipelines.

## Deployment Commands

### Preview Deployment

```bash
# Deploy from project root (creates preview URL)
vercel

# Equivalent explicit form
vercel deploy
```

Preview deployments are created automatically for every push to a non-production branch when using Git integration. They provide a unique URL for testing.

### Production Deployment

```bash
# Deploy directly to production
vercel --prod
vercel deploy --prod

# Force a new deployment (skip cache)
vercel --prod --force
```

### Build Locally, Deploy Build Output

```bash
# Build locally (uses development env vars by default)
vercel build

# Build with production env vars
vercel build --prod

# Deploy only the build output (no remote build)
vercel deploy --prebuilt
vercel deploy --prebuilt --prod
```

**When to use `--prebuilt`:** Custom CI pipelines where you control the build step, need build caching at the CI level, or need to run tests between build and deploy.

**Prebuilt limits:** [System Environment Variables are missing at build time](https://vercel.com/docs/cli/deploy#when-not-to-use---prebuilt), and Next.js Skew Protection needs a [custom deployment ID](https://vercel.com/docs/skew-protection#custom-deployment-id).

### Promote & Rollback

```bash
# Stage a production deployment without assigning domains
vercel deploy --prod --skip-domain

# Promote it (instant, no rebuild)
vercel promote <deployment-url-or-id>

# Rollback to the previous production deployment
vercel rollback

# Rollback to a specific deployment
vercel rollback <deployment-url-or-id>
```

**Promote a production deployment, not a preview.** Promoting a staged production deployment is instant and serves the same build. Promoting a preview rebuilds it with production environment variables, so the tested build is not the one released.

**Rollback turns off auto-assignment.** New production pushes stop going live until `vercel promote` restores it.

### Inspect Deployments

```bash
# View deployment details (build info, functions, metadata)
vercel inspect <deployment-url>

# List recent deployments
vercel ls

# View logs for a deployment
vercel logs <deployment-url>
vercel logs <deployment-url> --follow
```

## CI/CD Integration

### When to Add a CI Pipeline

The Git integration builds every push, posts preview URLs on pull requests, and deploys the production branch. Use CI for what Vercel does not run: tests, security scans, performance budgets, and approval gates. Gate releases on them with [Deployment Checks](references/deployment-checks.md) while Vercel keeps building. Deploy from CI only when the build must run in your runner, such as to keep source code off Vercel or for GitHub Enterprise Server.

### Required Environment Variables

Every CI pipeline needs these three variables:

```bash
VERCEL_TOKEN=<your-token>        # Personal or team token
VERCEL_ORG_ID=<org-id>           # From .vercel/project.json
VERCEL_PROJECT_ID=<project-id>   # From .vercel/project.json
```

Set these as secrets in your CI provider. Never commit them to source control. The CLI reads `VERCEL_TOKEN` from the environment; do not pass `--token`, which exposes it in process lists and logs.

### GitHub Actions

```yaml
name: Deploy to Vercel
on:
  push:
    branches: [main]

env:
  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Vercel CLI
        run: npm install -g vercel

      - name: Pull Vercel Environment
        run: vercel pull --yes --environment=production

      - name: Build
        run: vercel build --prod

      - name: Deploy
        run: vercel deploy --prebuilt --prod
```

### Other CI Pipelines and Backend Access

| Task | Read |
| --- | --- |
| Post preview URLs on pull requests from GitHub Actions, or deploy from GitLab CI or Bitbucket Pipelines | [references/cli-pipelines.md](references/cli-pipelines.md) |
| Let deployed functions reach AWS, GCP, or Vault without static secrets (OIDC federation) | [references/oidc-federation.md](references/oidc-federation.md) |
| Deployment Checks, or testing protected deployments from CI | [references/deployment-checks.md](references/deployment-checks.md) |

## Common CI Patterns

### Release Only Tested Builds

With Git deployments, require [Deployment Checks](references/deployment-checks.md). When CI deploys with the CLI, stage a production deployment, test it, then promote that build:

```yaml
env:
  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

jobs:
  stage:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    outputs:
      url: ${{ steps.deploy.outputs.url }}
    steps:
      # ... checkout, install, vercel pull --environment=production, vercel build --prod ...
      - id: deploy
        run: echo "url=$(vercel deploy --prebuilt --prod --skip-domain)" >> $GITHUB_OUTPUT

  e2e-tests:
    needs: stage
    runs-on: ubuntu-latest
    steps:
      # ... checkout, install, bypass header in playwright.config.ts (see references/deployment-checks.md) ...
      - run: npx playwright test
        env:
          BASE_URL: ${{ needs.stage.outputs.url }}
          VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}

  promote:
    needs: [stage, e2e-tests]
    runs-on: ubuntu-latest
    steps:
      - run: npm install -g vercel
      - run: vercel promote ${{ needs.stage.outputs.url }}
```

## Global CLI Flags for CI

| Flag | Purpose |
|------|---------|
| `--token <token>` | Authenticate; in CI, set `VERCEL_TOKEN` instead |
| `--yes` / `-y` | Skip confirmation prompts |
| `--scope <team>` | Execute as a specific team |
| `--cwd <dir>` | Set working directory |

## Best Practices

1. **Always use `--prebuilt` in CI** — separates build from deploy, enables build caching and test gates
2. **Use `vercel pull` before build** — ensures correct env vars and project settings
3. **Release only tested builds** — Deployment Checks (Git) or staged production builds (CLI)
4. **Use OIDC federation for runtime backend access** — lets Vercel functions auth to AWS/GCP without static secrets (does not replace `VERCEL_TOKEN` for CLI)
5. **Pin the Vercel CLI version in CI** — `npm install -g vercel@latest` can break unexpectedly
6. **Add `--yes` flag in CI** — prevents interactive prompts from hanging pipelines

## Deployment Strategy Matrix

| Scenario | Strategy | Commands |
|----------|----------|----------|
| Standard team workflow | Git-push deploy | Push to main/feature branches |
| Custom CI/CD (Actions, CircleCI) | Prebuilt deploy | `vercel build && vercel deploy --prebuilt` |
| Monorepo with Turborepo | Affected + remote cache | `turbo run build --affected --remote-cache` |
| Preview for every PR | Default behavior | Auto-creates preview URL per branch |
| Release a tested build | Deployment Checks (Git) or staged production (CLI) | Required checks, or `vercel deploy --prod --skip-domain` → test → `vercel promote <url>` |
| Atomic deploys with DB migrations | Two-phase | Run migration → verify → `vercel promote` |
| Latency-sensitive regional data | Vercel Functions | Keep the Node.js default; set the function region near the data |

## Common Build Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `ERR_PNPM_OUTDATED_LOCKFILE` | Lockfile doesn't match package.json | Run `pnpm install`, commit lockfile |
| `NEXT_NOT_FOUND` | Root directory misconfigured | Set `rootDirectory` in Project Settings |
| `Invalid next.config.js` | Config syntax error | Validate config locally with `next build` |
| `functions/api/*.js` mismatch | Wrong file structure | Move to `app/api/` directory (App Router) |
| `Error: EPERM` | File permission issue in build | Don't `chmod` in build scripts; use postinstall |

## Deploy Summary Format

Present a structured deploy result block:

```
## Deploy Result
- **URL**: <deployment-url>
- **Target**: production | preview
- **Status**: READY | ERROR | BUILDING | QUEUED
- **Commit**: <short-sha>
- **Framework**: <detected-framework>
- **Build Duration**: <duration>
```

If the deployment failed, append:

```
- **Error**: <summary of failure from logs>
```

For production deploys, also include:

```
### Post-Deploy Observability
- **Error scan**: <N errors found / clean> (scanned via vercel logs --level error --since 1h)
- **Drains**: <N configured / none>
- **Monitoring**: <active / gaps identified>
```

## Deploy Next Steps

Based on the deployment outcome:

- **Success (preview)** → "Visit the preview URL to verify. When ready, run `/deploy prod` to promote to production."
- **Success (production)** → "Your production site is live. Run `/status` to see the full project overview."
- **Build error** → "Check the build logs above. Common fixes: verify `build` script in package.json, check for missing env vars with `/env list`, ensure dependencies are installed."
- **Missing env vars** → "Run `/env pull` to sync environment variables locally, or `/env list` to review what's configured on Vercel."
- **Monorepo issues** → "Ensure the correct project root is configured in Vercel project settings. Check `vercel.json` for `rootDirectory`."
- **Post-deploy errors detected** → "Review errors above. Check `vercel logs <url> --level error` for details. If drains are configured, correlate with external monitoring."
- **No monitoring configured** → "Set up drains or install an error tracking integration before the next production deploy. Run `/status` for a full observability diagnostic."

## Official Documentation

- [Deployments](https://vercel.com/docs/deployments)
- [Vercel CLI](https://vercel.com/docs/cli)
- [GitHub Actions](https://vercel.com/docs/deployments/git/vercel-for-github)
- [GitLab CI](https://vercel.com/docs/deployments/git/vercel-for-gitlab)
- [Bitbucket Pipelines](https://vercel.com/docs/deployments/git/vercel-for-bitbucket)
- [OIDC Federation](https://vercel.com/docs/oidc)
