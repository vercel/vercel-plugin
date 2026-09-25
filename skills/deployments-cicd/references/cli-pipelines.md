# CLI Pipelines

These pipelines build and deploy with the Vercel CLI. Each needs the `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` variables described in the skill's Required Environment Variables section.

## Preview Deployments on PRs

The Git integration posts preview URLs on pull requests automatically. A CLI pipeline posts them itself:

```yaml
# GitHub Actions
on:
  pull_request:
    types: [opened, synchronize]

env:
  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g vercel
      - run: vercel pull --yes --environment=preview
      - run: vercel build
      - id: deploy
        run: echo "url=$(vercel deploy --prebuilt)" >> $GITHUB_OUTPUT
      - name: Comment PR
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `Preview: ${{ steps.deploy.outputs.url }}`
            })
```

## GitLab CI

```yaml
deploy:
  image: node:20
  stage: deploy
  script:
    - npm install -g vercel
    - vercel pull --yes --environment=production
    - vercel build --prod
    - vercel deploy --prebuilt --prod
  only:
    - main
```

## Bitbucket Pipelines

```yaml
pipelines:
  branches:
    main:
      - step:
          name: Deploy to Vercel
          image: node:20
          script:
            - npm install -g vercel
            - vercel pull --yes --environment=production
            - vercel build --prod
            - vercel deploy --prebuilt --prod
```
