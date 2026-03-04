---
name: vercel-cli
description: Vercel CLI expert guidance. Use when deploying, managing environment variables, linking projects, viewing logs, managing domains, or interacting with the Vercel platform from the command line.
---

# Vercel CLI

You are an expert in the Vercel CLI (`vercel` or `vc`). The CLI is the primary way to manage Vercel projects from the terminal.

## Installation

```bash
npm i -g vercel
```

## Core Commands

### Deployment

```bash
# Preview deployment (from project root)
vercel

# Production deployment
vercel --prod

# Build locally, deploy build output only
vercel build
vercel deploy --prebuilt

# Build for production (uses production env vars)
vercel build --prod
vercel deploy --prebuilt --prod

# Force a new deployment (skip cache)
vercel --force

# Promote a preview deployment to production
vercel promote <deployment-url>

# Rollback to previous production deployment
vercel rollback
```

### Development

```bash
# Start local dev server with Vercel features
vercel dev

# Link current directory to a Vercel project
vercel link

# Pull environment variables and project settings
vercel pull

# Pull specific environment
vercel pull --environment=production
```

### Environment Variables

```bash
# List all environment variables
vercel env ls

# Add an environment variable
vercel env add MY_VAR

# Add for specific environments
vercel env add MY_VAR production
vercel env add MY_VAR preview development

# Add branch-scoped variable
vercel env add MY_VAR preview --branch=feature-x

# Add sensitive (write-only) variable
vercel env add MY_SECRET --sensitive

# Remove an environment variable
vercel env rm MY_VAR

# Pull all env vars to .env.local
vercel env pull
vercel env pull .env.production.local --environment=production
```

### Logs & Inspection

```bash
# View function logs (real-time)
vercel logs <deployment-url>

# View build logs
vercel logs <deployment-url> --build

# Inspect a deployment
vercel inspect <deployment-url>

# List recent deployments
vercel ls
```

### Domains

```bash
# List domains
vercel domains ls

# Add a domain to a project
vercel domains add example.com

# Remove a domain
vercel domains rm example.com
```

### DNS

```bash
# List DNS records
vercel dns ls example.com

# Add a DNS record
vercel dns add example.com @ A 1.2.3.4
```

### Teams

```bash
# List teams
vercel teams ls

# Switch to a team
vercel teams switch my-team
```

### Cache Management

```bash
# Purge all cache (CDN + Data cache) for current project
vercel cache purge

# Purge only CDN cache
vercel cache purge --type cdn

# Purge only Data cache
vercel cache purge --type data

# Purge without confirmation prompt
vercel cache purge --yes

# Invalidate by tag (stale-while-revalidate)
vercel cache invalidate --tag blog-posts

# Invalidate multiple tags
vercel cache invalidate --tag blog-posts,user-profiles,homepage

# Hard delete by tag (blocks until revalidated — use with caution)
vercel cache dangerously-delete --tag blog-posts

# Hard delete with revalidation deadline (deletes only if not accessed within N seconds)
vercel cache dangerously-delete --tag blog-posts --revalidation-deadline-seconds 3600

# Invalidate cached image transformations by source path
vercel cache invalidate --srcimg /api/avatar/1

# Hard delete cached image transformations
vercel cache dangerously-delete --srcimg /api/avatar/1
```

**Key distinction:** `invalidate` serves STALE and revalidates in the background. `dangerously-delete` serves MISS and blocks while revalidating. Prefer `invalidate` unless you need immediate freshness.

**Note:** `--tag` and `--srcimg` cannot be used together.

### MCP Server Integration

```bash
# Initialize global MCP client configuration for your Vercel account
vercel mcp

# Set up project-specific MCP access for the linked project
vercel mcp --project
```

The `vercel mcp` command links your local MCP client configuration to a Vercel Project. It generates connection details so AI agents and tools can call your MCP endpoints deployed on Vercel securely.

### Marketplace Integrations (2026)

```bash
# Discover available integrations (agent-friendly JSON output)
vercel integration discover --format=json

# Get setup instructions for an integration
vercel integration guide neon

# The guide output is markdown — AI agents can parse and execute setup steps
```

## CI/CD Integration

Required environment variables for CI:
```bash
VERCEL_TOKEN=<your-token>
VERCEL_ORG_ID=<org-id>
VERCEL_PROJECT_ID=<project-id>
```

### GitHub Actions Example

```yaml
- name: Deploy to Vercel
  run: |
    vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
    vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}
    vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
```

## Global Options

| Flag | Purpose |
|------|---------|
| `--token` | Authentication token (for CI) |
| `--cwd <dir>` | Working directory |
| `--debug` / `-d` | Verbose output |
| `--yes` / `-y` | Skip confirmation prompts |
| `--scope <team>` | Execute as a team |

## Common Workflows

### First-Time Setup
```bash
vercel link          # Connect to Vercel project
vercel env pull      # Get environment variables
vercel dev           # Start local dev
```

### Deploy from CI
```bash
vercel pull --yes --environment=production --token=$TOKEN
vercel build --prod --token=$TOKEN
vercel deploy --prebuilt --prod --token=$TOKEN
```

### Quick Preview
```bash
vercel               # Creates preview deployment, returns URL
```

## Official Documentation

- [Vercel CLI](https://vercel.com/docs/cli)
- [Cache Management](https://vercel.com/docs/cli/cache)
- [MCP Integration](https://vercel.com/docs/cli/mcp)
- [Deployments](https://vercel.com/docs/deployments)
- [REST API](https://vercel.com/docs/rest-api/reference)
- [GitHub: Vercel CLI](https://github.com/vercel/vercel)
