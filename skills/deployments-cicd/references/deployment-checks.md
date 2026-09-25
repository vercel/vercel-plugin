# Deployment Checks

[Deployment Checks](https://vercel.com/docs/deployment-checks) hold each production deployment until every required check passes, then assign production domains automatically. Vercel keeps building from Git, and only a tested build goes live.

- Keep auto-assignment of production domains on. The checks decide when it happens.
- Add checks in **Settings → Build and Deployment → Deployment Checks**.
- **Force Promote** on the deployment page bypasses the checks.

| Source | What it checks |
| --- | --- |
| Vercel ([native](https://vercel.com/docs/deployment-checks#native-deployment-checks)) | Runs the `lint` and `typecheck` (or `type-check`, `check-types`) scripts from `package.json`, skipping a check with no matching script. Each check can be limited to specific environments |
| GitHub | Commit statuses and GitHub Actions check runs on the deployed commit. Requires Vercel for GitHub |
| Integrations | Marketplace integrations for testing, monitoring, and observability |

## Test Each Deployment with GitHub Actions

Vercel sends the `vercel.deployment.ready` [repository dispatch event](https://vercel.com/docs/git/vercel-for-github#repository-dispatch-events) after it creates a deployment and before checks run. Test the deployment it names, and report the result with `vercel/repository-dispatch/actions/status@v1`. That action sets a commit status on the deployed commit when the job finishes; require that status as a GitHub check.

```yaml
name: E2E
on:
  repository_dispatch:
    types: [vercel.deployment.ready]

jobs:
  e2e:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      statuses: write
    steps:
      - uses: vercel/repository-dispatch/actions/status@v1
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.client_payload.git.sha }}
      - run: npm ci && npx playwright install --with-deps
      - run: npx playwright test
        env:
          BASE_URL: ${{ github.event.client_payload.url }}
          VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

- GitHub runs `repository_dispatch` workflows from the default branch, so check out `client_payload.git.sha` to test the deployed commit.
- The status name defaults to `<workflow> | <job> (<project> - <environment>)`, which keeps one status per environment. Renaming the workflow or job renames the status, so select the check again.

## Reach Protected Deployments from CI

[Standard Protection](https://vercel.com/docs/deployment-protection#standard-protection) covers every URL except production domains, including the URL of a production deployment waiting on checks.

**Browser tests:** create a [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation#playwright) secret, store it as a CI secret, and send it on every request:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
if (!bypass) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET is required');

export default defineConfig({
  use: {
    baseURL: process.env.BASE_URL,
    extraHTTPHeaders: {
      'x-vercel-protection-bypass': bypass,
      'x-vercel-set-bypass-cookie': 'true',
    },
  },
});
```

**Scripted requests:** add GitHub Actions as a [Trusted Source](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources#add-a-github-actions-service) instead of storing a secret. Scope the rule to the repository and the environments the job may reach, grant the job `id-token: write`, and send the token from `core.getIDToken()` in the `x-vercel-trusted-oidc-idp-token` header.

For agent or local access to a protected URL: `⤳ skill: access-protected-vercel-deployment`.
