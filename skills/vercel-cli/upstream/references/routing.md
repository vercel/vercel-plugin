# Routing Rules

## Overview

`vercel routes` manages project-level routing rules. Each rule matches requests by path pattern and optional conditions (headers, cookies, query parameters), then applies an action (rewrite, redirect, set status) or modifies headers and query parameters.

Routing rules take effect immediately without a deployment and take precedence over routes defined in your deployment configuration (`vercel.json`, `next.config.js`, etc.).

Each routing rule has a unique name within the project, used to identify it in `edit`, `delete`, `enable`, `disable`, and `reorder` commands. Rules are evaluated in priority order (top to bottom). Use `reorder` to control placement.

All changes are staged as drafts. Run `vercel routes publish` to push staged changes to production.

## Viewing Routing Rules

```bash
vercel routes list                           # all routing rules (alias: ls)
vercel routes list --diff                    # staged changes vs production
vercel routes list --expand                  # show expanded details for each route
vercel routes list --search "api"            # search by name, description, source, or destination
vercel routes list --filter rewrite          # filter by type: rewrite, redirect, set_status, transform
vercel routes list --production              # list routes from the live production version
vercel routes list --version-id <id>         # list routes from a specific version
vercel routes inspect "My Route"             # full details of a specific rule
```

## Creating Routing Rules

Use `--ai` with a natural language description to generate routing rules with AI. For full control, use flags or interactive mode.

### Source path (`--src` and `--src-syntax`)

Use `--src` to specify the path pattern and `--src-syntax` to control how it's interpreted:

| Syntax | Example | When to use |
|--------|---------|-------------|
| `regex` | `^/api/(.*)$` | Full regex control. |
| `path-to-regexp` | `/api/:path*` | Express-style named params. More readable. |
| `equals` | `/about` | Exact string match. Simplest option. |

Defaults to `regex` if `--src-syntax` is not specified. `path-to-regexp` and `equals` paths must start with `/`.

### Actions

Each routing rule can have at most one primary action:

| Action | Required flags | Description |
|--------|---------------|-------------|
| `rewrite` | `--dest` | Proxy to destination URL (transparent to the client) |
| `redirect` | `--dest` + `--status` (301/302/307/308) | Redirect the client to a new URL |
| `set-status` | `--status` (100-599) | Return a status code (no destination) |

A routing rule without a primary action can still set response headers or apply request transforms.

### Conditions

Conditions control when a routing rule matches. Use `--has` to require something is present, and `--missing` to require it is absent. Supported types are `header`, `cookie`, `query`, and `host`. Conditions are repeatable, up to 16 per rule.

```bash
# Existence check
--has "cookie:session"
--missing "header:Authorization"

# Value matching
--has "header:X-API-Key:eq=my-secret"          # exact match
--has "cookie:theme:contains=dark"              # value contains substring
--has "header:Accept:re=application/json.*"     # regex match
--missing "query:debug:eq=true"                 # must NOT have debug=true

# Host matching (no key, just value)
--has "host:eq=example.com"
```

### Response headers & request transforms

Response headers, request headers, and request query parameters can each be set, appended to, or deleted. All flags are repeatable.

```bash
--set-response-header "Cache-Control=public, max-age=3600"
--append-request-header "X-Forwarded-Host=myapp.com"
--delete-request-query "debug"
```

### Additional create flags

```bash
--disabled                                   # create the route in disabled state
--position start                             # place at the top (highest priority)
--position end                               # place at the bottom
--position after:<id>                        # place after a specific route
--position before:<id>                       # place before a specific route
```

### Examples

```bash
# AI — describe what you want
vercel routes add --ai "Rewrite /api/* to https://backend.example.com/*"

# Interactive — guided builder with prompts
vercel routes add

# Rewrite with path-to-regexp syntax and a request header
vercel routes add "API Proxy" \
  --src "/api/:path*" --src-syntax path-to-regexp \
  --action rewrite --dest "https://api.example.com/:path*" \
  --set-request-header "X-Forwarded-Host=myapp.com" --yes

# Redirect with status
vercel routes add "Legacy Redirect" \
  --src "/old-blog" --src-syntax equals \
  --action redirect --dest "/blog" --status 301 --yes

# Routing rule with conditions and a description
vercel routes add "Auth Required" \
  --src "/dashboard/:path*" --src-syntax path-to-regexp \
  --action redirect --dest "/login" --status 307 \
  --missing "cookie:session" \
  --description "Redirect unauthenticated users to login" --yes

# Create disabled at a specific position
vercel routes add "Maintenance Mode" \
  --src "/(.*)" --action set-status --status 503 \
  --disabled --position start --yes
```

## Editing Routing Rules

```bash
# AI — describe the changes
vercel routes edit "My Route" --ai "Add CORS headers and change to 308 redirect"

# Interactive — choose which fields to modify
vercel routes edit "My Route"

# Change specific fields
vercel routes edit "My Route" --dest "https://new-api.example.com/:path*" --yes
vercel routes edit "My Route" --action redirect --dest "/new" --status 301 --yes
vercel routes edit "My Route" --name "New Name" --yes

# Remove fields
vercel routes edit "My Route" --no-dest --yes            # remove destination
vercel routes edit "My Route" --no-status --yes           # remove status code

# Clear collections
vercel routes edit "My Route" --clear-conditions --yes    # remove all has/missing conditions
vercel routes edit "My Route" --clear-headers --yes       # remove all response headers
vercel routes edit "My Route" --clear-transforms --yes    # remove all request transforms
```

## Managing Routing Rules

Use `vercel routes list` or `inspect` to find routing rule names and IDs.

```bash
vercel routes enable "My Route"                          # enable a disabled routing rule
vercel routes disable "My Route"                         # disable without removing
vercel routes delete "My Route"                          # delete a routing rule (alias: rm)
vercel routes delete "Route A" "Route B"                 # delete multiple at once
vercel routes reorder "My Route" --first --yes           # move to top (highest priority)
vercel routes reorder "My Route" --last --yes            # move to bottom (lowest priority)
vercel routes reorder "My Route" --position 3 --yes      # move to a specific position (1-based)
vercel routes reorder "My Route" --position start        # move to top (same as --first)
vercel routes reorder "My Route" --position end          # move to bottom (same as --last)
vercel routes reorder "My Route" --position after:<id>   # move after another route
vercel routes reorder "My Route" --position before:<id>  # move before another route
```

Aliases: `reorder` → `move`, `delete` → `rm`.

## Exporting Routes

Export routes in `vercel.json` or `vercel.ts` format for use in deployment configuration:

```bash
vercel routes export                          # export all routes as JSON
vercel routes export --format ts              # export as TypeScript (vercel.ts)
vercel routes export "My Route"               # export a specific route
```

## Publishing & Versioning

```bash
vercel routes publish                    # promote staged changes to production
vercel routes discard-staging            # discard all staged changes
vercel routes list-versions              # view version history
vercel routes list-versions --count 20   # fetch up to N versions
vercel routes restore <version-id>       # roll back to a previous version
```
