---
name: vercel-connect
description: Vercel Connect expert guidance — securely obtain scoped OAuth tokens for third-party services (Slack, GitHub, Linear, generic OAuth) on behalf of apps or users via Vercel OIDC. Use when wiring up third-party API access, sending Slack messages, accessing GitHub APIs, or building Ash agent connections.
metadata:
  priority: 5
  docs:
    - "https://vercel.com/docs/connect"
  sitemap: "https://vercel.com/sitemap/docs.xml"
  pathPatterns:
    - 'agent/connections/**'
    - 'agent/channels/**'
  importPatterns:
    - '@vercel/connect'
    - '@vercel/connect/ash'
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
    allOf:
      - [slack, token]
      - [github, token]
      - [oauth, token]
    anyOf:
      - "vercel connect"
      - "@vercel/connect"
      - "oauth"
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
  intents:
    - get slack token
    - get github oauth token
    - wire up third-party oauth
    - add slack channel to agent
    - connect to oauth provider
    - obtain api credentials
  entities:
    - Vercel Connect
    - getToken
    - "@vercel/connect"
    - OAuth
    - Slack
    - GitHub
    - Ash
    - connector
  examples:
    - send a slack message from my app
    - get a github oauth token
    - wire up Linear in my Ash agent
chainTo:
  -
    pattern: "from\\s+['\"]@vercel/connect/ash['\"]"
    targetSkill: vercel-connect
    message: 'Ash + Vercel Connect import detected — loading Vercel Connect guidance for the connect() helper and Slack channel patterns.'
  -
    pattern: 'SLACK_(BOT|SIGNING)_(TOKEN|SECRET)|SLACK_WEBHOOK_URL'
    targetSkill: vercel-connect
    message: 'Hand-managed Slack secrets detected — use Vercel Connect + connectSlackCredentials() to remove the need for SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET env vars.'
    skipIfFileContains: 'connectSlackCredentials|@vercel/connect'
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

Some tokens allow user and bot modes. The difference is important. When the goal is to perform actions on behalf of a user (e.g., post a message to a channel as the user), you need a user token. When the goal is to perform actions as a bot (e.g., post a message to a channel as a bot), you need a bot token. Some providers may also support app tokens for application-level access.

## Available Tools

All tools have `--format=json` option for machine-readable output.

### 1. Vercel Connect CLI (for Bash/Shell)

Use the `vercel connect` CLI for command-line operations. Use `vercel connect --help` to get available commands. The user needs to be authenticated to the Vercel CLI and the commands work within the scope of the user's currently selected Vercel team. For eg it will create & list Connect connectors created within the currently selected Vercel team.

Important! Always run `vercel connect` commands from the **project or agent folder** that will consume the connection (the directory containing `package.json` / `vercel.json`). Vercel Connect reads the local project context to auto-configure the connection — for example, picking a sensible connector name and `uid`, setting up project access to the connection, configuring webhooks and triggers. Running from the repo root or an unrelated directory skips this auto-configuration and you'll have to wire things up by hand. If the user invokes a `vc connect` command from elsewhere, `cd` into the closest matching project/agent folder first (or pass `--cwd <DIR>`).

Example commands:

```bash
# Create new Connect connector
vercel connect create <provider>

# List existing Connect connectors
vercel connect list

# Get token
vercel connect token <connector> --subject user|app
```

Important! The `vercel connect create` and `vercel connect token` commands may open the browser for the user if there's a manual registration required (for eg completing the OAuth consent or installing a slack app to a workspace). The user must visit the browser to complete the process while you wait for the process to complete.

#### Available Providers

| Provider | Modes     | Description       |
| -------- | --------- | ----------------- |
| `slack`  | user, bot | Slack API access  |
| `github` | user, app | GitHub API access |

And many more, including generic OAuth providers.

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

#### Ash agents — `@vercel/connect/ash`

When the project is built on [Ash](https://github.com/vercel/ash), prefer the `connect` helper over calling `getToken` directly inside connection definitions. The helper wires the full token / start-authorization / complete-authorization lifecycle into Ash's connection runtime, so a Vercel Connect-backed connection becomes a single declaration:

```typescript
// agent/connections/linear.ts
import { defineMcpClientConnection } from "experimental-ash/connections";
import { connect } from "@vercel/connect/ash";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/sse",
  description: "Linear workspace — issues, projects, cycles, and comments.",
  auth: connect("linear"),
});
```

Key points for the agent:

- Omit `principalType` for the default per-user OAuth flow, or set `"app"` for app-scoped tokens (no consent flow — fail terminally if not installed).
- Pass the connector id directly with `connect("linear")`, or use `connect({ connector: "linear" })` when you need options.
- For scopes, audiences, or `authorizationDetails`, pass them through `tokenParams`. For a custom challenge prompt, pass `instructions`. Both are optional.
- `experimental-ash` is an optional peer dependency, so the rest of `@vercel/connect` (CLI, `getToken`, etc.) is unaffected for non-Ash consumers.

##### Slack channel — `connectSlackCredentials`

For Ash Slack channels (`agent/channels/slack.ts`), use `connectSlackCredentials(connector)` from `@vercel/connect/ash`. It returns a complete `SlackChannelCredentials` object — both the bot token and inbound webhook verification are handled by Vercel Connect, so you do **not** need `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET` env vars:

```typescript
// agent/channels/slack.ts
import { slackRoute } from "experimental-ash/channels/slack";
import { connectSlackCredentials } from "@vercel/connect/ash";

export default slackRoute({
  credentials: connectSlackCredentials("slack/myagent"),
});
```

What the helper wires up:

- `botToken`: a function that calls `getToken(connector, { subject: { type: "app" } })` on each inbound webhook, so token rotation, refresh, and multi-workspace tenancy are handled server-side.
- `webhookVerifier`: a Vercel OIDC verifier (`vercelOidc()`). Vercel Connect forwards verified Slack webhooks to your app as signed Vercel OIDC requests; the helper verifies that signature instead of the raw Slack signing secret.

Use this whenever the project is on Ash + Vercel Connect — it's the one-liner for both outbound posts and inbound webhook auth.

### 3. HTTP API (for other languages)

For other languages, make HTTP requests directly to the Vercel Connect server:

```bash
# Get a token via HTTP
POST https://api.vercel.com/v1/connect/token/<connector>
Content-Type: application/json

```

#### Python Example

```python
import requests

# Get token from Vercel Connect
connect_response = requests.post(
    "https://api.vercel.com/v1/connect/token/slack1234",
    json={
        "scopes": ["chat:write"]
    }
)
token = connect_response.json()["accessToken"]

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
   vercel connect create <provider> [--name <app-name>]
   ```

Important! Provide the most precise server URL for the provider, including the complete connection URL (e.g. `https://mcp.linear.app/sse` rather than just `linear`). Short provider aliases may resolve to a default endpoint that does not match the transport or path the user actually wants. When in doubt, run `vercel connect create --help` to confirm which provider names and URL forms are accepted before picking one.

Important! This command will give you a URL or directly open it to complete the registration process. User must visit that URL and follow the instructions to link their third-party account with Vercel Connect. The command will not complete until they finish the registration. The agent must clearly show the URL to the user and prompt them to complete the registration.

Important! Once the register-token completes, it will print a successful message. You must capture that connector ID for the next step.

Important! The register-token command may open the browser so it's better to get the user approval before running it.

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
