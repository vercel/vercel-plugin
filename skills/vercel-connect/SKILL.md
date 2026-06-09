---
name: vercel-connect
description: Vercel Connect expert guidance — securely obtain scoped OAuth tokens for third-party services (Slack, GitHub, MCP servers, OAuth, Snowflake, Salesforce) on behalf of apps or users via Vercel OIDC. Use when wiring up third-party API access, connecting to MCP servers, sending Slack messages, or accessing GitHub APIs.
metadata:
  priority: 5
  docs:
    - "https://vercel.com/docs/connect"
  sitemap: "https://vercel.com/sitemap/docs.xml"
  importPatterns:
    - '@vercel/connect'
    - '@vercel/connect/authjs'
    - '@vercel/connect/betterauth'
  bashPatterns:
    - '\bvercel\s+connect\b'
    - '\bvc\s+connect\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@vercel/connect\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@vercel/connect\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@vercel/connect\b'
    - '\byarn\s+add\s+[^\n]*@vercel/connect\b'
  promptSignals:
    phrases:
      - "vercel connect"
      - "slack token"
      - "slack bot token"
      - "post to slack"
      - "send slack message"
      - "github oauth token"
      - "linear oauth"
      - "oauth token for"
      - "third-party token"
      - "connect to slack"
      - "connect to github"
      - "connect to mcp"
      - "mcp connection"
      - "mcp server"
      - "snowflake connection"
      - "salesforce connection"
    allOf:
      - [slack, token]
      - [github, token]
      - [oauth, token]
      - [mcp, connect]
      - [mcp, server]
    anyOf:
      - "vercel connect"
      - "@vercel/connect"
      - "oauth"
      - "mcp"
    noneOf:
      - "supabase auth"
      - "clerk"
      - "auth0"
    minScore: 6
retrieval:
  aliases:
    - vercel connect
    - oauth helper
    - third-party tokens
    - connect sdk
    - mcp connector
  intents:
    - get slack token
    - get github oauth token
    - wire up third-party oauth
    - connect to oauth provider
    - obtain api credentials
    - connect to mcp server
    - set up mcp connection
    - add snowflake connection
    - add salesforce connection
  entities:
    - Vercel Connect
    - getToken
    - "@vercel/connect"
    - OAuth
    - Slack
    - GitHub
    - MCP
    - Snowflake
    - Salesforce
    - connector
  examples:
    - send a slack message from my app
    - get a github oauth token
    - connect my agent to a MCP server
    - add Snowflake credentials to my project
---

# Vercel Connect Skill

## Overview

Vercel Connect enables to securely obtain scoped tokens for accessing third-party services on behalf of apps or users. It uses Vercel OIDC tokens to authenticate and exchange for Vercel Connect tokens via the Vercel API.

## When to Use Vercel Connect

Use Vercel Connect when you need to:

- Send messages via Slack (as a bot or on behalf of a user)
- Access GitHub repositories or APIs
- Connect to any third-party system that requires OAuth tokens or API credentials
- Obtain tokens for authenticated API calls

## Modes of tokens

The SDK supports three subject types — pick based on what's acting:

- **`user`** — actions performed on behalf of a specific end user (e.g., post a Slack message as the user). Requires a user `id` and optional `issuer`.
- **`app`** — actions performed as the app itself (e.g., post as a Slack bot, app-level GitHub access). No consent flow — fails terminally if the connector is not installed.
- **`jwt-bearer`** — RFC 7523 JWT-bearer exchange for connectors that accept a caller-minted assertion. Pass `sub` (required), plus optional `iss`, `aud`, and `additionalClaims`. Use when the third-party expects you to vouch for the subject via a signed JWT rather than an interactive OAuth grant.

## Available Tools

All tools have `--format=json` option for machine-readable output.

### 1. Vercel Connect CLI (for Bash/Shell)

Use the `vercel connect` CLI for command-line operations. Use `vercel connect --help` to get available commands. The user needs to be authenticated to the Vercel CLI and the commands work within the scope of the user's currently selected Vercel team. For eg it will create & list Connect connectors created within the currently selected Vercel team.

Important! Always run `vercel connect` commands from the **project or agent folder** that will consume the connection (the directory containing `package.json` / `vercel.json`). Vercel Connect reads the local project context to auto-configure the connection — for example, picking a sensible connector name and `uid`, setting up project access to the connection, configuring webhooks and triggers. Running from the repo root or an unrelated directory skips this auto-configuration and you'll have to wire things up by hand. If the user invokes a `vc connect` command from elsewhere, `cd` into the closest matching project/agent folder first (or pass `--cwd <DIR>`).

Example commands:

```bash
# Create new Connect connector
vercel connect create <service>

# List existing Connect connectors
vercel connect list

# Get token
vercel connect token <connector> --subject user|app
```

Important! The `vercel connect create` and `vercel connect token` commands may open the browser for the user if there's a manual registration required (for eg completing the OAuth consent or installing a slack app to a workspace). The user must visit the browser to complete the process while you wait for the process to complete.

#### Available Services

| Service                | Modes      | Description                                |
| ---------------------- | ---------- | ------------------------------------------ |
| `slack`                | user, bot  | Slack API access                           |
| `github`               | user, app  | GitHub API access                          |
| MCP servers            | user, app  | Any MCP server (`mcp.<host>/<path>`)       |
| `snowflake`            | user       | Snowflake data access                      |
| `salesforce`           | user       | Salesforce API access                      |
| Generic OAuth provider | user, app  | Any OAuth 2.0 server registered via `vercel connect create` |

For MCP servers, pass the full endpoint URL when registering (e.g. `vercel connect create https://mcp.linear.app/mcp`). The connector ID then takes the form `mcp.<host>/<name>` (for example `mcp.linear.app/myagent`).

#### Example: Send a Slack message using curl

```bash
TOKEN=$(vercel connect token <connector>)
curl -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C1234567890", "text": "Hello from Vercel Connect!"}'
```

### 2. JavaScript/TypeScript SDK (`@vercel/connect`)

For JavaScript/TypeScript code, use the `@vercel/connect` package directly:

```typescript
import { getToken } from "@vercel/connect";

// Get a token for Slack bot
const token = await getToken("scl_abc123", {
  subject: { type: "app" }, // If sending as a bot, or else use "user"
});

// Use the token
const response = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    channel: "C1234567890",
    text: "Hello from Vercel Connect!",
  }),
});
```

The SDK uses the user's Vercel OIDC token to authenticate. The user should have run `vc env pull` to pull the OIDC token env variables locally (or `vc link` pulls it automatically)

### 3. HTTP API (for other languages)

For other languages, make HTTP requests directly to the Vercel Connect server. The request must be authenticated with the project's Vercel OIDC token (`VERCEL_OIDC_TOKEN` env var — pulled by `vc env pull` or injected at runtime):

```bash
# Get a token via HTTP
POST https://api.vercel.com/v1/connect/token/<connector>
Authorization: Bearer <VERCEL_OIDC_TOKEN>
Content-Type: application/json

{ "subject": { "type": "user", "id": "user_123" } }
```

The response is JSON with a `token` field (plus `expiresAt`, `connector`, and other metadata).

#### Python Example

```python
import os
import requests

# Get token from Vercel Connect
connect_response = requests.post(
    "https://api.vercel.com/v1/connect/token/slack1234",
    headers={"Authorization": f"Bearer {os.environ['VERCEL_OIDC_TOKEN']}"},
    json={
        "subject": {"type": "app"},
        "scopes": ["chat:write"],
    },
)
token = connect_response.json()["token"]

# Use the token
slack_response = requests.post(
    "https://slack.com/api/chat.postMessage",
    headers={"Authorization": f"Bearer {token}"},
    json={"channel": "C1234567890", "text": "Hello from Vercel Connect!"}
)
```

## Workflow

All tools have `--json` option for machine-readable output.

Before running any `vercel connect` step below, make sure your shell cwd is the project or agent folder that will use the connection (see the CLI section above). Vercel Connect uses that context to auto-configure the project, so running from the right directory removes follow-up wiring work.

1. **Check existing Connect connectors**: See if a required Connect connector is already present

   ```bash
   vercel connect list
   vercel connect token <connector>
   ```

Important! If more than one connector found, allow user to make the choice between them, or ask to create a new one

2. **Register**: If the provider you need is not registered of if the user asked to create a new connector / app / bot, follow the instructions to register it (this may involve setting up credentials on browser in the third-party service and then registering them with Vercel Connect).

   ```bash
   vercel connect create <service> [--name <app-name>]
   ```

Important! Provide the most precise server URL for the service, including the complete connection URL (e.g. `https://mcp.linear.app/mcp` rather than just `linear`). Short service aliases may resolve to a default endpoint that does not match the transport or path the user actually wants. When in doubt, run `vercel connect create --help` to confirm which service names and URL forms are accepted before picking one.

Important! This command will give you a URL or directly open it to complete the registration process. User must visit that URL and follow the instructions to link their third-party account with Vercel Connect. The command will not complete until they finish the registration. The agent must clearly show the URL to the user and prompt them to complete the registration.

Important! Once `vercel connect create` completes, it will print a successful message. You must capture that connector ID for the next step.

Important! The `vercel connect create` command may open the browser so it's better to get the user approval before running it.

3. **Get token**: Obtain a token for the provider you need:
   On CLI, you can get the token via

   ```bash
   vercel connect token <connector> [--subject <subject>]
   ```

The default subject is user. Use app for getting app scoped tokens. It's recommended to run this command with the `--yes` in case an re-authorization or installation is required. This will trigger the reauthorization flow for the user.

Important! Always put the token value into a variable and use the variable in the subsequent commands to avoid accidentally echoing the token in the terminal or logs. Avoid combining this command with other commands using `&&`. For example:

```bash
TOKEN=$(vercel connect token)
```

Important! Try to reuse tokens as much as possible. If you already have a token with the required scopes, use it instead of requesting a new one, even when fewer scopes are needed. This will reduce friction for the user and avoid unnecessary authorization prompts.

When working with a JavaScript/TypeScript code, use the `@vercel/connect` package directly:

4. **Use token**: Use the token to authenticate with the third-party service.
   For example:

```typescript
import { getToken } from "@vercel/connect";

const token = await getToken(
  "connector-id",
  // Optional params:
  {
    subject: { ... },
  },
);
```
