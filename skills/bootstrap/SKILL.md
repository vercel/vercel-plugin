---
name: bootstrap
description: Set up or repair repositories that already use, or have selected, Vercel-linked resources. Coordinate project linking, required integrations, environment verification, and first-run commands while preserving the chosen framework, providers, and UI. Generic local setup or planning alone does not require Vercel linking or provisioning.
metadata:
  priority: 8
  docs:
    - "https://vercel.com/docs/getting-started-with-vercel"
    - "https://nextjs.org/docs/app/getting-started/installation"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - '.vercel/project.json'
    - '.vercel/repo.json'
    - 'vercel.ts'
  bashPatterns:
    - '\\bvercel\\s+link\\b'
    - '\\bvercel\\s+integration\\s+(?:add|install)\\b'
    - '\\bvercel\\s+env\\s+pull\\b'
  importPatterns:
    - '@vercel/blob'
    - '@vercel/edge-config'
    - '@vercel/global-config'
chainTo:
  -
    pattern: '@vercel/(postgres|kv)|\b(KV_REST_API_URL|POSTGRES_URL)\b'
    targetSkill: vercel-storage
    message: '@vercel/postgres and @vercel/kv are sunset — loading Vercel Storage guidance for Neon and Upstash migration.'
  -
    pattern: 'from\s+[''""](next-auth|@auth/core|@clerk/nextjs|better-auth)[''""]'
    targetSkill: auth
    message: 'Auth library detected during Vercel bootstrap — load guidance for the configured provider without changing the chosen authentication architecture.'
  -
    pattern: 'AI_GATEWAY|VERCEL_OIDC'
    targetSkill: env-vars
    message: 'Vercel AI authentication detected — load environment guidance for the selected authentication path.'
    skipIfFileContains: 'VERCEL_OIDC|vercel env pull'
retrieval:
  aliases:
    - Vercel project setup
    - Vercel repo initialization
    - Vercel resource bootstrap
  intents:
    - set up a project using selected Vercel resources
    - initialize a Vercel-linked repository
    - link vercel project
    - pull env vars
  entities:
    - vercel link
    - env pull
    - database setup
    - first run

---

# Project Bootstrap Orchestrator

Apply this sequence only to setup that depends on Vercel-linked resources
already selected by the user or project. Preserve the chosen framework,
providers, existing resources, and confirmed UI: do not change layout, theme,
fonts, or component libraries as part of environment setup. General planning
and local-only repositories do not require this Vercel bootstrap sequence.

For the applicable Vercel setup, execute bootstrap in strict order. Do not run
migrations or the development server until project linking and environment
verification are complete. Run only the resource sections required by the
project; Postgres and AUTH_SECRET are not universal prerequisites.

## Rules

- Do not run `db:push`, `db:migrate`, `db:seed`, or `dev` until Vercel linking is complete and env keys are verified.
- Preserve existing providers and resources. Use Vercel-managed provisioning (`vercel integration ...`) for new resources when that integration path is selected.
- Use the existing provider's supported setup path for external resources; use provider CLIs as fallback when the selected Vercel integration flow is unavailable.
- Never echo secret values in terminal output, logs, or summaries.

## Preflight

1. Confirm Vercel CLI is installed and authenticated.

```bash
vercel --version
vercel whoami
```

2. Confirm repo linkage by checking `.vercel/project.json`.
3. If not linked, inspect available teams/projects before asking the user to choose:

```bash
vercel teams ls
vercel projects ls --scope <team>
vercel link --yes --scope <team> --project <project>
```

4. Find the env template in priority order: `.env.example`, `.env.sample`, `.env.template`.
5. Create local env file if missing:

```bash
cp .env.example .env.local
```

## Resource Setup: Postgres

### Preferred path (Vercel-managed Neon)

1. Read integration setup guidance:

```bash
vercel integration guide neon
```

2. Add Neon integration to the Vercel scope:

```bash
vercel integration add neon --scope <team>
```

3. Verify expected environment variable names exist in Vercel and pull locally:

```bash
vercel env ls
vercel env pull .env.local --yes
```

### Fallback path 1 (Dashboard)

1. Provision Neon through the Vercel dashboard integration UI.
2. Re-run `vercel env pull .env.local --yes`.

### Fallback path 2 (Neon CLI)

Use Neon CLI only when Vercel-managed provisioning is unavailable. After creating resources, add required env vars in Vercel and pull again.

## AUTH_SECRET Generation

Generate a high-entropy secret without printing it, then store it in Vercel and refresh local env:

```bash
AUTH_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
printf "%s" "$AUTH_SECRET" | vercel env add AUTH_SECRET production,preview
printf "%s" "$AUTH_SECRET" | vercel env add AUTH_SECRET development  # separate command: development-only adds default to Config
unset AUTH_SECRET
vercel env pull .env.local --yes
```

## Env Verification

Compare required keys from template file against `.env.local` keys (names only, never values):

```bash
template_file=""
for candidate in .env.example .env.sample .env.template; do
  if [ -f "$candidate" ]; then
    template_file="$candidate"
    break
  fi
done

comm -23 \
  <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$template_file" | cut -d '=' -f 1 | sort -u) \
  <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.local | cut -d '=' -f 1 | sort -u)
```

Proceed only when missing key list is empty.

## App Setup

After linkage + env verification:

```bash
npm run db:push
npm run db:seed
npm run dev
```

Use the repository package manager (`npm`, `pnpm`, `bun`, or `yarn`) and run only scripts that exist in `package.json`.

## Bootstrap Verification

Confirm each checkpoint:

- `vercel whoami` succeeds.
- `.vercel/project.json` exists and matches chosen project.
- Required resource setup completed using the selected path; record Postgres as not required when the project does not use it.
- `vercel env pull .env.local --yes` succeeds.
- Required env key diff is empty.
- Database command status is recorded (`db:push`, `db:seed`, `db:migrate`, `db:generate` as applicable).
- `dev` command starts without immediate config/auth/env failure.

If verification fails, stop and report exact failing step plus remediation.

## Summary Format

Return a final bootstrap summary in this format:

```md
## Bootstrap Result
- **Linked Project**: <team>/<project>
- **Resource Path**: existing-provider | vercel-integration-neon | dashboard-neon | neon-cli | not-required
- **Env Keys**: <count> required, <count> present, <count> missing
- **Secrets**: not-required | existing | configured (values never shown)
- **Migration Status**: not-run | success | failed (<step>)
- **Dev Result**: not-run | started | failed
```

## Bootstrap Next Steps

- If env keys are still missing, add the missing keys in Vercel and re-run `vercel env pull .env.local --yes`.
- If DB commands fail, fix connectivity/schema issues and re-run only the failed db step.
- If `dev` fails, resolve runtime errors, then restart with your package manager's `run dev`.

## next-forge Projects

If the project was scaffolded with `npx next-forge init` (detected by `packages/auth` + `packages/database` + `@repo/*` imports; package manager is chosen at init):

1. Env files are per-app (`apps/app/.env.local`, `apps/web/.env.local`, `apps/api/.env.local`) plus `packages/database/.env`.
2. Run the `migrate` script with the repo's package manager (not `db:push`) — it runs `prisma format` + `prisma generate` + `prisma migrate dev` and prompts for a migration name.
3. Minimum env vars: `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WEB_URL`, `NEXT_PUBLIC_API_URL` (URLs are pre-configured for local dev).
4. Optional services (Clerk, Stripe, Resend, PostHog, etc.) can be skipped initially — integrations whose keys are unset are skipped at runtime. Delete the empty `KEY=""` placeholders copied from `.env.example`: an empty string fails the `keys.ts` format checks.
5. Deploy as 3 separate Vercel projects with root directories `apps/app`, `apps/api`, `apps/web`.
