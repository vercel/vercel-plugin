---
name: vercel-connect
description: Vercel Connect expert guidance for securely obtaining scoped credentials for third-party services on behalf of apps or users. Use when wiring up provider API access, OAuth, API-key services, MCP servers, triggers, framework adapters, or eve agent connections.
metadata:
  priority: 5
  docs:
    - "https://vercel.com/docs/connect"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - 'agent/connections/**'
    - 'agent/channels/**'
  importPatterns:
    - '@vercel/connect'
    - '@vercel/connect/eve'
    - '@vercel/connect/ai-sdk'
    - '@vercel/connect/mcp'
    - '@vercel/connect/tanstack-ai'
    - '@vercel/connect/chat'
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
      - "microsoft graph token"
      - "teams bot token"
      - "discord bot token"
      - "notion token"
      - "salesforce connection"
      - "api key connector"
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
      - "discord"
      - "notion"
      - "salesforce"
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
    - add slack channel to agent
    - connect to oauth provider
    - obtain api credentials
    - connect to mcp server
    - set up mcp connection
    - add snowflake connection
    - connect an AI SDK app to an authenticated MCP server
    - configure Connect triggers
  entities:
    - Vercel Connect
    - getToken
    - "@vercel/connect"
    - OAuth
    - Slack
    - GitHub
    - MCP
    - Snowflake
    - eve
    - connector
    - project link
    - installation
  examples:
    - send a slack message from my app
    - get a github oauth token
    - wire up Linear in my eve agent
    - connect my agent to a MCP server
    - add Snowflake credentials to my project
chainTo:
  -
    pattern: "from\\s+['\"]@vercel/connect/eve['\"]"
    targetSkill: eve
    message: 'eve + Vercel Connect import detected: loading eve framework guidance alongside the connect() helper and channel credential patterns.'
  -
    pattern: 'SLACK_(BOT|SIGNING)_(TOKEN|SECRET)|SLACK_WEBHOOK_URL|GITHUB_(APP_PRIVATE_KEY|APP_ID|INSTALLATION_ID|WEBHOOK_SECRET)|LINEAR_(ACCESS_TOKEN|WEBHOOK_SECRET)'
    targetSkill: vercel-connect
    message: 'Hand-managed Slack/GitHub/Linear secrets detected. For eve projects, use Vercel Connect channel credential helpers to remove these provider secrets from project environment variables.'
    skipIfFileContains: 'connectSlackCredentials|connectGitHubCredentials|connectLinearCredentials|@vercel/connect'
---

# Vercel Connect Skill

## Overview

Vercel Connect gives applications short-lived provider credentials without storing provider API keys or refresh tokens in project environment variables. A Vercel deployment authenticates with its project OIDC token. External CI or non-Vercel runtimes can pass a scoped Vercel access token through `options.vercelToken`.

Connectors are owned by a Vercel team. A consuming project and environment must be linked to the connector before it can request credentials. The connector UID, such as `slack/acme-slack`, is the stable identifier used by the SDK and CLI. Always use the UID or `scl_...` ID returned by `create` or `list`.

## When to Use Vercel Connect

Use Vercel Connect when you need to:

- Send messages via Slack (as a bot or on behalf of a user)
- Access GitHub repositories or APIs
- Connect to any third-party system that requires OAuth tokens or API credentials
- Obtain scoped, short-lived provider credentials for authenticated API calls
- Forward provider events to applications through Vercel Connect triggers

## Modes of tokens

The SDK supports three subject types. Pick based on what's acting:

- **`user`**: actions performed on behalf of a specific end user (e.g., post a Slack message as the user). Requires a user `id` and optional `issuer`.
- **`app`**: actions performed as the app itself (e.g., post as a Slack bot or use a GitHub installation). It skips per-user consent but may still require a provider installation or supported app grant.
- **`jwt-bearer`**: federated identity through the OAuth JWT-bearer grant. Pass `sub` (required), plus optional `iss`, `aud`, and `additionalClaims`.

For user subjects, derive `subject.id` from a stable identity in the authenticated server-side session. Never accept it from a request body or other client input. Keep `getToken()`, Connect auth providers, and MCP clients on the server.

## CLI

The `vercel connect` CLI is currently beta. It operates in the selected Vercel team and supports machine-readable output with `--format=json` or `-F json`.

Use the full lifecycle instead of assuming connector creation also authorizes a project:

```bash
# Inspect connectors linked to the current project, or all team connectors
vercel connect list
vercel connect list --all-projects

# Inspect supported setup options, then create a connector
vercel connect create <service> --help
vercel connect create <service>

# Link the connector to the current project and selected environments
vercel connect attach <connector>

# Request a scoped provider token
vercel connect token <connector> --subject app
```

The CLI also supports `detach`, `update`, `remove`, and `open`. Run `vercel connect <command> --help` before using optional installation, scope, trigger, branch, or custom-environment flags.

Use current-project behavior from a Vercel-linked project directory. Creating a connector and attaching it are distinct operations. Connector creation or token authorization may open a browser. Show the returned URL and wait for the person to finish the provider flow. `--yes` permits automatic browser opening; it does not force reauthorization.

Supported connectors include managed Slack, GitHub, Linear, Microsoft, Microsoft Teams, Snowflake, and Salesforce connectors, plus Custom OAuth/OIDC, API-key services, and MCP servers. This list can grow. Use `vercel connect create <service> --help` and the live connector catalog instead of treating a fixed list as exhaustive.

## JavaScript/TypeScript SDK (`@vercel/connect`)

For JavaScript/TypeScript code, use the `@vercel/connect` package directly:

```typescript
import { getToken } from "@vercel/connect";

// Get a token for Slack bot
const token = await getToken("slack/acme-slack", {
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

On Vercel, the SDK reads `VERCEL_OIDC_TOKEN` automatically. For local development, run `vercel link` followed by `vercel env pull`. Development OIDC tokens expire, so pull again when authentication fails. For external CI or non-Vercel hosting, pass a scoped Vercel access token through the third `options` argument.

Use `getToken()` immediately before calling the provider and let the SDK cache identical requests. Scope each SDK request to what it needs with `installationId`, `scopes`, `audience`, `resources`, or `authorizationDetails`. The CLI supports subject, installation, and scopes, but not every SDK field. Do not invent CLI flags for SDK-only parameters.

Use these root APIs when needed:

- `getTokenResponse()` for token metadata such as expiry and connector details.
- `getConnectorMetadata()` to inspect connector metadata and provider-specific public configuration.
- `startAuthorization()` after `UserAuthorizationRequiredError` to begin user consent.
- `revokeToken()` and `deleteTokenCacheEntry()` for revocation and cache eviction.
- `forceRefresh` and `validityBufferMs` only when the default cache behavior does not fit the call.

#### eve agents: `@vercel/connect/eve`

When the project is built on [eve](https://eve.dev), prefer the `connect` helper over calling `getToken` directly inside connection definitions. It wires token requests and interactive authorization into eve's connection runtime:

```typescript
// agent/connections/linear.ts
import { defineMcpClientConnection } from "eve/connections";
import { connect } from "@vercel/connect/eve";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear workspace: issues, projects, cycles, and comments.",
  auth: connect("linear/my-agent"),
});
```

Key points for the agent:

- Omit `principalType` for the default per-user OAuth flow, or set `principalType: "app"` for app-scoped tokens.
- Pass the connector UID directly with `connect("linear/my-agent")`, or use `connect({ connector: "linear/my-agent" })` when you need options.
- For scopes, audiences, or `authorizationDetails`, pass them through `tokenParams`. For a custom challenge prompt, pass `instructions`. Both are optional.
- `eve` is an optional peer dependency, so the rest of `@vercel/connect` (CLI, `getToken`, etc.) is unaffected for non-eve consumers.

##### Slack channel: `connectSlackCredentials`

For eve Slack channels (`agent/channels/slack.ts`), use `connectSlackCredentials(connector)` from `@vercel/connect/eve`. It returns a complete `SlackChannelCredentials` object. Both the bot token and inbound webhook verification are handled by Vercel Connect, so you do **not** need `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET` env vars:

```typescript
// agent/channels/slack.ts
import { slackChannel } from "eve/channels/slack";
import { connectSlackCredentials } from "@vercel/connect/eve";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent", {
    installationId: "inst_workspace_xyz",
  }),
});
```

What the helper wires up:

- `botToken`: a function that requests an app token when the channel needs it. Connect stores and refreshes installation credentials.
- `webhookVerifier`: a Vercel OIDC verifier (`vercelOidc()`). Vercel Connect forwards verified Slack webhooks to your app as signed Vercel OIDC requests; the helper verifies that signature instead of the raw Slack signing secret.

Without an explicit `installationId`, a channel helper uses the connector's default installation. It does not infer the correct installation from an inbound workspace or organization. Multi-tenant applications must resolve a trusted installation mapping and pass the resulting ID as the helper's second argument.

Use this whenever the project is on eve + Vercel Connect. It is the one-liner for both outbound posts and inbound webhook auth.

##### GitHub channel: `connectGitHubCredentials`

For eve GitHub channels (`agent/channels/github.ts`), use `connectGitHubCredentials(connector)` from `@vercel/connect/eve`. It returns a complete `GitHubChannelCredentials` object. eve uses the installation token directly, while Vercel Connect stores and refreshes provider credentials. Pass an explicit trusted `installationId` for multi-tenant routing. You do **not** need `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, or `GITHUB_WEBHOOK_SECRET` env vars:

```typescript
// agent/channels/github.ts
import { githubChannel } from "eve/channels/github";
import { connectGitHubCredentials } from "@vercel/connect/eve";

export default githubChannel({
  botName: "my-agent",
  credentials: connectGitHubCredentials("github/myagent"),
});
```

What the helper wires up:

- `installationToken`: a function that calls `getToken(connector, { subject: { type: "app" } })`. The helper pins `subject` to `"app"` because GitHub installation tokens are app-scoped.
- `webhookVerifier`: a Vercel OIDC verifier (`vercelOidc()`). Vercel Connect forwards verified GitHub webhooks to your app as signed Vercel OIDC requests; the helper verifies that signature instead of the raw GitHub webhook secret.

##### Linear channel: `connectLinearCredentials`

For eve Linear channels (`agent/channels/linear.ts`), use `connectLinearCredentials(connector)` from `@vercel/connect/eve`. It returns a complete `LinearChannelCredentials` object. Vercel Connect manages the Linear app access token and webhook auth, so you do **not** need `LINEAR_ACCESS_TOKEN` or `LINEAR_WEBHOOK_SECRET` env vars:

```typescript
// agent/channels/linear.ts
import { linearChannel } from "eve/channels/linear";
import { connectLinearCredentials } from "@vercel/connect/eve";

export default linearChannel({
  credentials: connectLinearCredentials("linear/myagent"),
});
```

What the helper wires up:

- `accessToken`: a function that calls `getToken(connector, { subject: { type: "app" } })`. The helper pins `subject` to `"app"` because Linear Agent tokens are app-scoped.
- `webhookVerifier`: a Vercel OIDC verifier (`vercelOidc()`). Vercel Connect forwards verified Linear webhooks to your app as signed Vercel OIDC requests; the helper verifies that signature instead of the raw Linear webhook secret.

The eve entrypoint also provides Connect credential helpers for Discord, Microsoft Teams, Linq, and Photon channels. `connectOAuth()` verifies Connect OAuth-gateway bearer tokens for inbound routes; use `connect()` for MCP client connection authorization. Check the current eve integration docs for subject creation, automatic provisioning, validation, eviction, and revocation options instead of copying configuration between connector types.

## HTTP API

For other languages, request a token directly from the Vercel API. Authenticate with the project's Vercel OIDC token or a scoped Vercel access token. A connector UID containing `/` must be URL-encoded as one path segment:

With a Vercel access token, request only an `app` subject or the access-token owner's own user subject. Use a project OIDC token to request a provider credential for a different user subject.

```bash
# Get a token via HTTP
POST https://api.vercel.com/v1/connect/token/slack%2Facme-slack
Authorization: Bearer <VERCEL_OIDC_TOKEN | Vercel access token>
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
    "https://api.vercel.com/v1/connect/token/slack%2Facme-slack",
    headers={"Authorization": f"Bearer {os.environ['VERCEL_OIDC_TOKEN']}"},
    json={
        "subject": {"type": "app"},
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

## Framework adapters

Choose the adapter by job:

- `@vercel/connect/ai-sdk` and `@vercel/connect/mcp`: use `connectAuthProvider()` to authenticate MCP clients and coordinate consent. Provider consent and AI SDK tool approval are separate decisions.
- `@vercel/connect/tanstack-ai`: use its Connect transport and consent helpers with TanStack AI.
- `@vercel/connect/chat`: supply credentials for supported Chat SDK adapters. Connect-trigger OIDC verification applies to Slack, Discord, Microsoft Teams, GitHub, and Linear. Notion and Telegram use their native inbound mechanisms.
- `@vercel/connect/eve`: authorize eve connections, supply channel credentials, and authenticate inbound OAuth routes.
- `@vercel/connect/betterauth` and `@vercel/connect/authjs`: sign users into your application through a Connect OAuth provider.

### Better Auth and Auth.js

These adapters sign users into the application. They do not return a provider API token. If the app also needs to call the provider API, use the root SDK's `getToken()` with the appropriate subject and scopes.

#### Better Auth: `@vercel/connect/betterauth`

Optional peer dependency: `better-auth`. Pass the connector through Better Auth's `genericOAuth` plugin. Connector UIDs can contain a `/` (e.g. `linear/myagent`), and Better Auth additionally requires a `providerId`:

```typescript
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { connect } from "@vercel/connect/betterauth";

genericOAuth({
  config: [connect({ providerId: "linear", connector: "linear/myagent" })],
});
```

#### Auth.js: `@vercel/connect/authjs`

Optional peer dependency: `@auth/core`. Use the connector as an `OAuth2Config` provider. Connector UIDs can contain a `/` (e.g. `linear/myagent`), and Auth.js additionally requires an `id`:

```typescript
import { connect } from "@vercel/connect/authjs";

const providers = [connect({ id: "linear", connector: "linear/myagent" })];
```

## Project links, installations, and environments

- `vercel connect attach <connector>` grants the linked project access in selected environments. Use `detach` to remove that link.
- Project links authorize token requests. They do not isolate a connector's provider installations. Use separate connectors when production and non-production must be isolated at the provider level.
- Installation-backed connectors may require `installationId`. Never guess one when multiple installations are available.
- Custom Environments and branch targeting are configured through project-link and trigger options. Inspect current CLI help before changing them.

## Triggers and observability

Triggers are opt-in destinations that forward supported provider events to an application. Connect signs forwarded requests, retries documented 5xx failures, and limits the number of destinations per connector. Configure trigger paths and environment or branch targeting explicitly rather than assuming connector creation adds them.

Use connector event history, correlation IDs, and configured drains when diagnosing token, installation, authorization, or trigger failures. Do not log raw provider tokens.

## Recommended workflow

1. Link the local directory with `vercel link`, then pull a development OIDC token with `vercel env pull`.
2. Run `vercel connect list` and, when needed, `vercel connect list --all-projects`.
3. If no suitable connector exists, inspect `vercel connect create <service> --help`, create it, and capture the returned UID or ID.
4. Attach the connector to the consuming project and required environments.
5. For CLI token requests, choose the narrowest practical subject, installation, and scopes. In SDK code, also use `audience`, `resources`, or `authorizationDetails` when the provider requires them.
6. If user consent or provider installation is required, surface the authorization URL or typed error and wait for completion.
7. Call the provider with the short-lived credential. In SDK code, request it at use time and let the cache refresh it.
8. Configure triggers separately when inbound events are required, then verify delivery with event history and correlation IDs.

## Sources of truth

Vercel Connect changes quickly. Before generating commands or framework code, consult:

- [Vercel Connect docs](https://vercel.com/docs/connect)
- [CLI reference](https://vercel.com/docs/cli/connect)
- [TypeScript SDK reference](https://vercel.com/docs/connect/ts-sdk-reference)
- [Frameworks and adapters](https://vercel.com/docs/connect/frameworks)
- [Connector catalog](https://vercel.com/connect/browse)
