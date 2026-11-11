---
description: Bootstrap a repository with Vercel-linked resources by running preflight checks, provisioning integrations, verifying env keys, and then executing db/dev startup commands safely.
---

# Vercel Project Bootstrap

Run a deterministic bootstrap flow for repositories using selected Vercel resources.

## Applicability

<!-- Sourced from bootstrap skill: Applicability -->
Apply this sequence only to setup that depends on Vercel-linked resources
already selected by the user or project. Preserve the chosen framework,
providers, existing resources, and confirmed UI: do not change layout, theme,
fonts, or component libraries as part of environment setup. General planning
and local-only repositories do not require this Vercel bootstrap sequence.

A `prisma/schema.prisma` file makes the Prisma guidance discoverable; it does
not select Vercel hosting or authorize database provisioning. First inspect
the existing connection and the requested setup. If the task does not use
Vercel-linked resources, follow the existing provider's workflow without
requiring Vercel authentication, linking, or env pulls before migrations or
development.

For the applicable Vercel setup, execute bootstrap in strict order. Do not run
migrations or the development server until project linking and environment
verification are complete. Run only the resource sections required by the
project; Postgres and AUTH_SECRET are not universal prerequisites.

## Preflight

<!-- Sourced from bootstrap skill: Preflight -->
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

6. Detect package manager and available scripts (`db:push`, `db:seed`, `db:migrate`, `db:generate`, `dev`) from `package.json`.
7. Inspect auth/database signals (`prisma/schema.prisma`, `drizzle.config.*`, `auth.*`, `src/**/auth.*`) to scope bootstrap details.

Stop with clear guidance if CLI auth or linkage fails.

## Plan

Execute in this order:

1. Preflight validation and project linking.
2. Verify existing resources; provision only required new resources through the selected provider. When choosing a new Vercel-managed Postgres database, prefer Prisma Postgres for Prisma ORM projects and Neon otherwise.
3. Required secret/bootstrap env setup (`AUTH_SECRET` only when needed, env pull, key verification).
4. Application bootstrap (`db:*` then `dev`) only after env checks pass.

<!-- Sourced from bootstrap skill: Rules -->
- For setup that depends on selected Vercel resources, do not run `db:push`, `db:migrate`, `db:seed`, or `dev` until Vercel linking is complete and env keys are verified.
- Preserve existing providers and resources. Use Vercel-managed provisioning (`vercel integration ...`) for new resources when that integration path is selected.
- Use the existing provider's supported setup path for external resources; use provider CLIs as fallback when the selected Vercel integration flow is unavailable.
- Never echo secret values in terminal output, logs, or summaries.

## Commands

### 1. Link + local env template

Copy the first matching template file only if `.env.local` does not exist:

```bash
cp .env.example .env.local
```

If `.env.example` is absent, use `.env.sample` or `.env.template`.

### 2. Provision Postgres

<!-- Sourced from bootstrap skill: Resource Setup: Postgres -->
Reuse an existing database and verify its connection before considering a new
resource. Provision only when the task requires a new Postgres database and
the Vercel integration path has been selected. Preserve an explicitly chosen
provider; the defaults below apply only when the provider is still unchosen.

### Prisma ORM projects

For an eligible new database in a repo with `prisma/schema.prisma`, prefer
Prisma Postgres over the Neon default below:

```bash
vercel integration guide prisma
vercel integration add prisma --scope <team>
```

It sets `DATABASE_URL` to the direct connection string. Then verify and pull env vars as in step 3 of the preferred path below. For production traffic from Vercel Functions, add the pooled string as described in the `vercel-storage` skill.

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

### 3. Generate and store `AUTH_SECRET`

<!-- Sourced from bootstrap skill: AUTH_SECRET Generation -->
Generate a high-entropy secret without printing it, then store it in Vercel and refresh local env:

```bash
AUTH_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
printf "%s" "$AUTH_SECRET" | vercel env add AUTH_SECRET production,preview
printf "%s" "$AUTH_SECRET" | vercel env add AUTH_SECRET development  # separate command: development-only adds default to Config
unset AUTH_SECRET
vercel env pull .env.local --yes
```

### 4. Verify required env keys

<!-- Sourced from bootstrap skill: Env Verification -->
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

Do not continue if any required keys are missing.

### 5. Run app bootstrap commands (after verification)

<!-- Sourced from bootstrap skill: App Setup -->
After linkage + env verification:

```bash
npm run db:push
npm run db:seed
npm run dev
```

Use the repository package manager (`npm`, `pnpm`, `bun`, or `yarn`) and run only scripts that exist in `package.json`.

## Verification

<!-- Sourced from bootstrap skill: Bootstrap Verification -->
Confirm each checkpoint:

- `vercel whoami` succeeds.
- `.vercel/project.json` exists and matches chosen project.
- Required resource setup completed using the selected path; record Postgres as not required when the project does not use it.
- `vercel env pull .env.local --yes` succeeds.
- Required env key diff is empty.
- Database command status is recorded (`db:push`, `db:seed`, `db:migrate`, `db:generate` as applicable).
- `dev` command starts without immediate config/auth/env failure.

If verification fails, stop and report exact failing step plus remediation.

## Summary

<!-- Sourced from bootstrap skill: Summary Format -->
Return a final bootstrap summary in this format:

```md
## Bootstrap Result
- **Linked Project**: <team>/<project>
- **Resource Path**: existing-provider | vercel-integration-prisma | vercel-integration-neon | dashboard-neon | neon-cli | not-required
- **Env Keys**: <count> required, <count> present, <count> missing
- **Secrets**: not-required | existing | configured (values never shown)
- **Migration Status**: not-run | success | failed (<step>)
- **Dev Result**: not-run | started | failed
```

## Next Steps

<!-- Sourced from bootstrap skill: Bootstrap Next Steps -->
- If env keys are still missing, add the missing keys in Vercel and re-run `vercel env pull .env.local --yes`.
- If DB commands fail, fix connectivity/schema issues and re-run only the failed db step.
- If `dev` fails, resolve runtime errors, then restart with your package manager's `run dev`.
