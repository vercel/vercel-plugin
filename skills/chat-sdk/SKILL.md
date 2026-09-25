---
name: chat-sdk
description: Vercel Chat SDK expert guidance. Use when building multi-platform chat bots — Slack, Telegram, Microsoft Teams, Discord, Google Chat, GitHub, Linear — with a single codebase. Covers the Chat class, adapters, threads, messages, cards, modals, streaming, state management, and webhook setup.
metadata:
  priority: 8
  docs:
    - "https://chat-sdk.dev/docs"
    - "https://vercel.com/kb/chat-sdk"
  sitemap: "https://chat-sdk.dev/sitemap.xml"
  pathPatterns:
    - "app/api/chat/**"
    - "app/api/chat-bot/**"
    - "app/api/bot/**"
    - "app/api/slack/**"
    - "app/api/teams/**"
    - "app/api/discord/**"
    - "app/api/gchat/**"
    - "app/api/telegram/**"
    - "app/api/github-bot/**"
    - "app/api/linear-bot/**"
    - "app/api/webhooks/slack/**"
    - "app/api/webhooks/teams/**"
    - "app/api/webhooks/discord/**"
    - "app/api/webhooks/gchat/**"
    - "app/api/webhooks/telegram/**"
    - "app/api/webhooks/github/**"
    - "app/api/webhooks/linear/**"
    - "src/app/api/chat/**"
    - "src/app/api/chat-bot/**"
    - "src/app/api/bot/**"
    - "src/app/api/slack/**"
    - "src/app/api/teams/**"
    - "src/app/api/discord/**"
    - "src/app/api/gchat/**"
    - "src/app/api/telegram/**"
    - "lib/bot.*"
    - "lib/bot/**"
    - "src/lib/bot.*"
    - "src/lib/bot/**"
    - "lib/chat-bot/**"
    - "src/lib/chat-bot/**"
    - "bot/**"
    - "pages/api/bot.*"
    - "pages/api/bot/**"
    - "src/pages/api/bot.*"
    - "src/pages/api/bot/**"
    - "tests/**/bot*"
    - "test/**/bot*"
    - "fixtures/replay/**"
    - "apps/*/app/api/bot/**"
    - "apps/*/app/api/slack/**"
    - "apps/*/app/api/teams/**"
    - "apps/*/app/api/discord/**"
    - "apps/*/lib/bot/**"
    - "apps/*/src/lib/bot/**"
  importPatterns:
    - "chat"
    - "@chat-adapter/*"
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bchat\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bchat\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bchat\b'
    - '\byarn\s+add\s+[^\n]*\bchat\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@chat-adapter/'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@chat-adapter/'
    - '\bbun\s+(install|i|add)\s+[^\n]*@chat-adapter/'
    - '\byarn\s+add\s+[^\n]*@chat-adapter/'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@chat-adapter/telegram'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@chat-adapter/telegram'
    - '\bbun\s+(install|i|add)\s+[^\n]*@chat-adapter/telegram'
    - '\byarn\s+add\s+[^\n]*@chat-adapter/telegram'
  promptSignals:
    phrases:
      - "chat sdk"
      - "chat bot"
      - "chatbot"
      - "conversational interface"
      - "slack bot"
      - "telegram bot"
      - "discord bot"
      - "teams bot"
    allOf:
      - [bot, platform]
      - [bot, multi]
    anyOf:
      - "onNewMention"
      - "onSubscribedMessage"
      - "chat adapter"
      - "cross-platform bot"
    noneOf:
      - "useChat"
    minScore: 6
retrieval:
  aliases:
    - chat ui
    - chatbot
    - conversation interface
    - messaging component
  intents:
    - build chatbot
    - add chat interface
    - create messaging ui
    - implement chat feature
  entities:
    - useChat
    - Message
    - ChatUI
    - StreamingMessage
    - chat-sdk
  examples:
    - build a chatbot interface
    - add chat to my app
    - create a messaging component
chainTo:
  -
    pattern: 'from\s+[''""]openai[''""]'
    targetSkill: ai-sdk
    message: 'Direct OpenAI SDK import in chat bot — loading AI SDK guidance for unified provider abstraction and streaming.'
  -
    pattern: 'from\s+[''\"](slack-bolt|@slack/bolt|@slack/web-api)[''"]|require\s*\(\s*[''\"](slack-bolt|@slack/bolt|@slack/web-api)[''"]|new\s+App\s*\(\s*\{\s*token'
    targetSkill: chat-sdk
    message: '@slack/bolt or @slack/web-api detected — use the Chat SDK with @chat-adapter/slack instead for a unified multi-platform bot that works across Slack, Teams, Discord, Telegram, and more.'
  -
    pattern: 'from\s+[''\"](discord\.js|discord-api-types|telegram-bot-api|telegraf|grammy)[''"]|require\s*\(\s*[''\"](discord\.js|telegraf|grammy)[''"]'
    targetSkill: chat-sdk
    message: 'Platform-specific bot library detected — use the Chat SDK with the corresponding @chat-adapter/* package for a unified multi-platform bot codebase.'
  -
    pattern: 'setTimeout\s*\(|setInterval\s*\(|while\s*\(\s*true'
    targetSkill: workflow
    message: 'Long-running or polling logic in chat bot — loading Workflow SDK for durable execution that survives deploys.'
    skipIfFileContains: 'use workflow|from\s+[''"]workflow[''"]'
  -
    pattern: 'process\.env\.(OPENAI_API_KEY|ANTHROPIC_API_KEY)|from\s+[''"]@ai-sdk/(anthropic|openai)[''""]'
    targetSkill: ai-gateway
    message: 'Direct provider API key in chat bot — loading AI Gateway guidance for OIDC auth and model routing.'
    skipIfFileContains: 'gateway\(|@ai-sdk/gateway'
---

# Chat SDK

Unified TypeScript SDK for building chat bots across Slack, Microsoft Teams, Google Chat, Discord, Telegram, GitHub, Linear, WhatsApp, and more. Write your bot logic once, deploy everywhere.

## Scaffold a new project

Use `create-chat-sdk` to scaffold a basic Next.js bot project without prompts. Run `npx create-chat-sdk --help` to see the available options and how the CLI works.

## Start with Chat SDK documentation

When Chat SDK is installed in a user's project, inspect the published docs that ship in `node_modules/chat/docs/`, the resources in `node_modules/chat/resources/`, and the available open source templates in `node_modules/chat/resources/templates.json`.

If those paths do not exist, the `chat` package is not installed in the project yet. The user can install it with `npm i chat`.

You can also find the docs on the [Chat SDK website](https://chat-sdk.dev/docs) and in the [Vercel knowledge base](https://vercel.com/kb/chat-sdk).

## Available resources

<!-- RESOURCES:START -->

### Guides

- `node_modules/chat/resources/guides/how-to-build-an-ai-agent-for-slack-with-chat-sdk-and-ai-sdk.md` — Build a Slack AI agent using Chat SDK, AI SDK's ToolLoopAgent, and Vercel AI Gateway. Covers project setup, tool definitions, streaming responses, deployment to Vercel, and scaling tool selection with toolpick.
- `node_modules/chat/resources/guides/human-in-the-loop-with-chat-sdk-and-workflow-sdk.md` — Pause durable workflows on Slack approval cards using Chat SDK and Workflow SDK. Uses createWebhook to suspend workflows until a button click, with patterns for multi-stage approvals, timeouts via durable sleep, and approver validation.
- `node_modules/chat/resources/guides/liveblocks-chat-sdk-ai-sdk.md` — Build an AI agent that replies to @-mentions in Liveblocks comment threads with streamed responses and tool calling. Uses Chat SDK, the Liveblocks adapter, AI SDK's ToolLoopAgent, and Redis for thread subscriptions and distributed locking.
- `node_modules/chat/resources/guides/slack-bot-vercel-blob.md` — Build a Slack bot that lists, reads, uploads, and deletes files in Vercel Blob through tool calls. Uses Chat SDK, AI SDK's ToolLoopAgent, and Files SDK's createFileTools factory with approval-gated write tools and a read-only mode.
- `node_modules/chat/resources/guides/run-and-track-deploys-from-slack.md` — Build a Slack deploy bot with Chat SDK and Vercel Workflow. Dispatch GitHub Actions from a slash command, gate production behind approval, poll for completion, and notify Linear and GitHub when the run finishes.
- `node_modules/chat/resources/guides/triage-form-submissions-with-chat-sdk.md` — Build a Slack bot that triages form submissions with interactive cards. Forward, edit, or mark as spam without leaving Slack. Built with Chat SDK, Hono, and Resend.
- `node_modules/chat/resources/guides/how-to-build-a-slack-bot-with-next-js-and-redis.md` — This guide walks through building a Slack bot with Next.js, covering project setup, Slack app configuration, event handling, interactive features, and deployment.
- `node_modules/chat/resources/guides/create-a-discord-support-bot-with-nuxt-and-redis.md` — This guide walks through building a Discord support bot with Nuxt, covering project setup, Discord app configuration, Gateway forwarding, AI-powered responses, and deployment.
- `node_modules/chat/resources/guides/ship-a-github-code-review-bot-with-hono-and-redis.md` — This guide walks through building a GitHub bot that reviews pull requests on demand. When a user @mentions the bot on a PR, Chat SDK picks up the mention, spins up a Vercel Sandbox with the repo cloned, and uses AI SDK to analyze the diff.
- `node_modules/chat/resources/guides/build-a-slack-bot-with-vercel-connect.md` — Learn how to build your very own Slackbot with Chat SDK and AI SDK. Vercel Connect supplies runtime Slack tokens and forwards triggers, so you never store a long-lived bot token.
- `node_modules/chat/resources/guides/vercel-connect.md` — Use Vercel Connect to call provider APIs like Slack, GitHub, and Snowflake from your agents and services with short-lived, user-authorized tokens instead of long-lived secrets.
- `node_modules/chat/resources/guides/ai-gateway-and-ai-sdk.md` — Build AI agents on Vercel with AI Gateway and AI SDK, then make them reliable, capable, and durable with Sandbox, Chat SDK, Vercel Connect, and Workflow.
- `node_modules/chat/resources/guides/daily-digest-bot-with-chat-sdk-and-workflow-sdk.md` — Create your own daily digest bot that posts a daily digest of GitHub stats to Slack. Learn how to use Vercel Connect to set up Slack and GitHub app securely in your project.

### Templates

Listed in `node_modules/chat/resources/templates.json`:

- **Chat SDK Liveblocks Bot** — Build a bot that you can engage with inside Liveblocks. (https://vercel.com/templates/next.js/chat-sdk-liveblocks-bot)
- **Durable iMessage Agent** — Durable iMessage agent powered by the Sendblue adapter. (https://vercel.com/templates/nitro/durable-imessage-ai-agent)
- **Knowledge Agent** — Open source file-system and knowledge based agent template. Build AI agents that stay up to date with your knowledge base. (https://vercel.com/templates/nuxt/chat-sdk-knowledge-agent)
- **Community Agent** — Open source AI-powered Slack community management bot with a built-in Next.js admin panel. Uses Chat SDK, AI SDK, and Vercel Workflow. (https://vercel.com/templates/next.js/chat-sdk-community-agent)
- **Caltext** — iMessage calorie tracking assistant powered by AI. (https://vercel.com/templates/hono/caltext)

<!-- RESOURCES:END -->

## Chat SDK adapters

### Adapter directory

See the 'Official Adapters', 'Vendor-Official Adapters', and 'Community Adapters' sections in the [Chat SDK llms.txt file](https://chat-sdk.dev/llms.txt) for the current list of official, vendor-official, and community adapters.

### Adapter catalog subpath

Chat SDK exposes a zero-dependency static catalog at `chat/adapters`.

Agents can import `ADAPTERS`, `ADAPTER_NAMES`, `getAdapter`, `isAdapterSlug`, `listEnvVars`, `getSecretEnvVars`, and metadata types like `CatalogAdapter` and `AdapterSlug` from this subpath without importing any adapter implementation package.

Use it for:
- Listing official and vendor-official adapter slugs, names, npm packages, groups, and platform vs state types.
- Building setup or onboarding flows that need package names, peer dependencies, and install guidance before any adapter is installed.
- Discovering required, optional, and credential-mode environment variables for an adapter, including which variables are secrets.
- Keeping vendor-official adapter docs and metadata aligned with the catalog when adding or updating a listed adapter.