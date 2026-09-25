---
name: env-vars
description: Vercel environment variable expert guidance. Use when working with .env files, vercel env commands, Secret or Config variable types, OIDC tokens, or managing environment-specific configuration.
metadata:
  priority: 7
  docs:
    - "https://vercel.com/docs/environment-variables"
    - "https://vercel.com/docs/environment-variables/sensitive-environment-variables"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - '.env'
    - '.env.*'
    - '.env.local'
    - '.env.production'
    - '.env.development'
    - '.env.test'
    - '.env.production.local'
    - '.env.development.local'
    - '.env.test.local'
    - '.env.example'
  bashPatterns:
    - '\bvercel\s+env\s+pull\b'
    - '\bvercel\s+env\s+add\b'
    - '\bvercel\s+env\s+rm\b'
    - '\bvercel\s+env\s+ls\b'
    - '\bvercel\s+env\s+update\b'
    - '\bvercel\s+env\s+run\b'
chainTo:
  -
    pattern: '\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY)\b'
    targetSkill: ai-gateway
    message: 'Direct provider API key detected — loading AI Gateway guidance for OIDC auth (no manual keys needed on Vercel).'
retrieval:
  aliases:
    - environment variables
    - env file
    - secrets
    - config vars
    - secret env var
    - sensitive env var
  intents:
    - set env var
    - manage secrets
    - pull env vars
    - configure environment
  entities:
    - .env
    - vercel env
    - OIDC
    - environment variable

---

# Vercel Environment Variables

You are an expert in Vercel environment variable management — `.env` file conventions, the `vercel env` CLI, OIDC token lifecycle, and environment-specific configuration.

## .env File Hierarchy

Vercel and Next.js load environment variables in a specific order. Later files override earlier ones:

| File | Purpose | Git-tracked? |
|------|---------|-------------|
| `.env` | Default values for all environments | Yes |
| `.env.local` | Local overrides and secrets | **No** (gitignored) |
| `.env.development` | Development-specific defaults | Yes |
| `.env.development.local` | Local dev overrides | **No** |
| `.env.production` | Production-specific defaults | Yes |
| `.env.production.local` | Local prod overrides | **No** |
| `.env.test` | Test-specific defaults | Yes |
| `.env.test.local` | Local test overrides | **No** |

### Load Order (Next.js)

1. `.env` (lowest priority)
2. `.env.[environment]` (development, production, or test)
3. `.env.local` (skipped in test environment)
4. `.env.[environment].local` (highest priority, skipped in test)

### Critical Rules

- **Never commit secrets** to `.env`, `.env.development`, or `.env.production` — use `.local` variants or Vercel environment variables
- `.env.local` is always gitignored by Next.js — this is where `vercel env pull` writes secrets
- Variables prefixed with `NEXT_PUBLIC_` are exposed to the browser bundle — never put secrets in `NEXT_PUBLIC_` vars
- All other variables are server-only (API routes, Server Components, middleware)

## vercel env CLI

### Pull Environment Variables

```bash
# Pull all env vars for the current environment into .env.local
vercel env pull .env.local

# Pull for a specific environment
vercel env pull .env.local --environment=production
vercel env pull .env.local --environment=preview
vercel env pull .env.local --environment=development

# Overwrite existing file without prompting
vercel env pull .env.local --yes

# Pull to a custom file
vercel env pull .env.production.local --environment=production
```

### Add Environment Variables

Every variable has a type:

| Type | After saving | Use for |
|------|--------------|---------|
| **Secret** | Hidden in the dashboard and `vercel env ls`; can be replaced, never read back. Production and Preview Secrets are not returned by `vercel env pull`. | Passwords, API keys, tokens, database URLs |
| **Config** | Readable by members with access | Non-sensitive values you need to read later |

Deployments receive both types at build time and runtime. Secret and Config replaced the Sensitive toggle; existing Sensitive variables are Secrets.

```bash
# Interactive — prompts for value, environments, and type
vercel env add MY_SECRET

# Non-interactive: read the value from a file so it never lands in shell
# history or process arguments (echo "value" | ... and --value do both)
vercel env add MY_SECRET production < ./secret.txt

# Add to production and preview in one command
vercel env add MY_SECRET production,preview < ./secret.txt

# Set the type explicitly
vercel env add MY_SECRET production --type secret < ./secret.txt
vercel env add SITE_REGION production --type config < ./region.txt

# Add development in its own command; development-only adds default to Config
vercel env add MY_SECRET development < ./dev-secret.txt

# Update an existing value
vercel env update MY_SECRET production < ./secret.txt
```

- **Defaults**: a non-interactive add to production, preview, or a custom environment is stored as Secret.
- **Public prefixes are always Config**: variables such as `NEXT_PUBLIC_*` or `VITE_*` are exposed to browsers, so the CLI refuses `--type secret` for them. Keep a private value under a name without the prefix.
- **Flags**: `--type config|secret` needs Vercel CLI 59.6 or later. Older CLIs use `--visibility`, now a deprecated alias of `--type`. `--sensitive` (Secret) and `--no-sensitive` (Config) still work in every version.
- **Team policy**: **Separate Production Secret Values** requires a Production Secret to differ from the Preview, Development, and custom environment values of the same key. Under it, create separate Production and non-Production values instead of adding one value to all targets. It replaces the deprecated **Enforce Sensitive Environment Variables** policy.

### List Environment Variables

```bash
# List all environment variables
vercel env ls

# Filter by environment
vercel env ls production
```

### Remove Environment Variables

```bash
# Remove from specific environment
vercel env rm MY_SECRET production

# Remove from all environments
vercel env rm MY_SECRET
```

## Bootstrap Flow (Fresh Clone / New Machine)

Use this sequence when setting up a project from scratch:

```bash
# 1) Link first so pulls target the correct Vercel project
vercel link --yes --project <name-or-id> --scope <team>

# 2) Pull env vars into .env.local
vercel env pull .env.local --yes

# 3) Verify required keys from .env.example exist in .env.local
while IFS='=' read -r key _; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  grep -q "^${key}=" .env.local || echo "Missing in .env.local: $key"
done < .env.example
```

### Temporary Path: Run With Vercel Envs Without Writing a File

If you need Vercel environment variables immediately but do not want to write `.env.local` yet:

```bash
vercel env run -- npm run dev
```

This is useful for quick validation during bootstrap, but still pull `.env.local` for a normal local workflow.

### Re-pull After Secret or Provisioning Changes

After creating/updating secrets (`vercel env add`, dashboard changes) or provisioning integrations that add env vars (for example Neon/Upstash), re-run:

```bash
vercel env pull .env.local --yes
```

## OIDC Token Lifecycle

Vercel uses **OIDC (OpenID Connect)** tokens for secure, keyless authentication between your app and Vercel services (AI Gateway, storage, etc.).

### How It Works

1. **On Vercel deployments**: `VERCEL_OIDC_TOKEN` is automatically injected as a short-lived JWT and auto-refreshed — zero configuration needed
2. **Local development**: `vercel env pull .env.local` provisions a `VERCEL_OIDC_TOKEN` valid for ~12 hours
3. **Token expiry**: When the local OIDC token expires, re-run `vercel env pull .env.local --yes` to get a fresh one. Consider re-pulling at the start of each dev session to avoid mid-session auth failures

### Common OIDC Patterns

```ts
// The @vercel/oidc package reads VERCEL_OIDC_TOKEN automatically
import { getVercelOidcToken } from '@vercel/oidc'

// AI Gateway uses OIDC by default — no manual token handling needed
import { gateway } from 'ai'
const result = await generateText({
  model: gateway('openai/gpt-5.2'),
  prompt: 'Hello',
})
```

### Troubleshooting OIDC

| Symptom | Cause | Fix |
|---------|-------|-----|
| `VERCEL_OIDC_TOKEN` missing locally | Haven't pulled env vars | `vercel env pull .env.local` |
| Auth errors after ~12h locally | Token expired | `vercel env pull .env.local --yes` |
| Works on Vercel, fails locally | Token not in `.env.local` | `vercel env pull .env.local` |
| `AI_GATEWAY_API_KEY` vs OIDC | Both set, key takes priority | Remove `AI_GATEWAY_API_KEY` to use OIDC |

## Environment-Specific Configuration

### Vercel Dashboard vs .env Files

| Use Case | Where to Set |
|----------|-------------|
| Secrets (API keys, tokens) | Vercel Dashboard (`https://vercel.com/{team}/{project}/settings/environment-variables`) or `vercel env add`, as type Secret |
| Public config (site URL, feature flags) | `.env` or `.env.[environment]` files |
| Local-only overrides | `.env.local` |
| CI/CD secrets | Vercel Dashboard (`https://vercel.com/{team}/{project}/settings/environment-variables`) with environment scoping |

### Environment Scoping on Vercel

Variables set in the Vercel Dashboard at `https://vercel.com/{team}/{project}/settings/environment-variables` can be scoped to:

- **Production** — production domain deployments
- **Preview** — branch/PR deployments
- **Development** — `vercel dev` and `vercel env pull`

A variable can be assigned to one, two, or all three environments.

### Git Branch Overrides

Preview environment variables can be scoped to specific Git branches:

```bash
# Add a variable only for the "staging" branch
vercel env add DATABASE_URL preview --git-branch=staging < ./staging-database-url.txt
```

## Gotchas

### `vercel env pull` Overwrites Custom Variables

`vercel env pull .env.local` **replaces the entire file** — any manually added variables (custom secrets, local overrides, debug flags) are lost. Always back up or re-add custom vars after pulling:

```bash
# Save custom vars before pulling
grep -v '^#' .env.local | grep -v '^VERCEL_\|^POSTGRES_\|^NEXT_PUBLIC_' > .env.custom.bak
vercel env pull .env.local --yes
cat .env.custom.bak >> .env.local  # Re-append custom vars
```

Or maintain custom vars in a separate `.env.development.local` file (loaded after `.env.local` by Next.js).

### Pulled Files Omit Production and Preview Secrets

`vercel env pull --environment=production` (or `preview`) does not write Secret values, so a pulled file cannot reproduce production credentials. Keep separate Development values for local work instead of trying to copy production Secrets onto a machine.

### Scripts Don't Auto-Load `.env.local`

Only Next.js auto-loads `.env.local`. Standalone scripts (`drizzle-kit`, `tsx`, custom Node scripts) need explicit loading:

```bash
# Use dotenv-cli
npm install -D dotenv-cli
npx dotenv -e .env.local -- npx drizzle-kit push
npx dotenv -e .env.local -- npx tsx scripts/seed.ts

# Or source manually
source <(grep -v '^#' .env.local | sed 's/^/export /') && node scripts/migrate.js
```

## Best Practices

1. **Use `vercel env pull` as part of your setup workflow** — document it in your README
2. **Never hardcode secrets** — always use environment variables
3. **Scope narrowly** — don't give preview deployments production database access
4. **Rotate OIDC tokens regularly in local dev** — re-pull when you see auth errors
5. **Use `.env.example`** — commit a template with empty values so teammates know which vars are needed
6. **Prefix client-side vars with `NEXT_PUBLIC_`** — and never put secrets in them
7. **Keep custom vars in `.env.development.local`** — protects them from `vercel env pull` overwrites

## Official Documentation

- [Environment Variables](https://vercel.com/docs/environment-variables)
- [Vercel CLI: env](https://vercel.com/docs/cli/env)
- [Secret and Config types](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types)
- [Next.js Environment Variables](https://nextjs.org/docs/app/guides/environment-variables)
