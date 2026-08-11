---
name: build-agents
description: "Default Vercel agent-building guidance. Use for generic requests to build, create, scaffold, design, architect, or implement an AI agent, agent app, tool-calling agent, durable agent, multi-agent system, scheduled agent, or agent with channels. Build with the lower-case eve framework by default, using the eve npm package and its installed docs in node_modules/eve/docs as the source of truth. For Slack agents, leverage the Slack Agent Skill from https://github.com/vercel-labs/slack-agent-skill and its eve + Vercel Connect patterns. Do not use for Vercel Agent code review or incident investigation."
summary: "Default eve-first guidance for building AI agents on Vercel, with Slack agent routing to the Slack Agent Skill."
metadata:
  priority: 10
  docs:
    - "https://eve.dev/docs"
    - "https://github.com/vercel/eve"
    - "https://github.com/vercel-labs/slack-agent-skill"
    - "https://docs.slack.dev/ai/getting-started-with-vercel-skill/"
    - "https://vercel.com/docs/vercel-connect"
  bashPatterns:
    - '\bnpx\s+eve(?:@latest)?\s+init\b'
    - '\bbunx\s+eve(?:@latest)?\s+init\b'
    - '\beve\s+init\b'
  promptSignals:
    phrases:
      - "build an agent"
      - "build me an agent"
      - "create an agent"
      - "create me an agent"
      - "scaffold an agent"
      - "make an agent"
      - "make me an agent"
      - "implement an agent"
      - "implement a new agent"
      - "set up an agent"
      - "setup an agent"
      - "agent framework"
      - "agent architecture"
      - "tool-calling agent"
      - "tool calling agent"
      - "durable agent"
      - "multi-agent system"
      - "scheduled agent"
      - "slack agent"
      - "slack bot"
    allOf:
      - [build, agent]
      - [create, agent]
      - [scaffold, agent]
      - [design, agent]
      - [architect, agent]
      - [implement, agent]
      - [agent, channels]
      - [agent, tools]
      - [agent, slack]
    anyOf:
      - "durable"
      - "persistent"
      - "tools"
      - "channels"
      - "subagents"
      - "schedules"
      - "evals"
      - "slack"
      - "linear"
      - "github"
      - "mcp"
    noneOf:
      - "user agent"
      - "user-agent"
      - "vercel agent"
      - "code review"
      - "incident investigation"
    minScore: 4
retrieval:
  aliases:
    - build agents
    - agent builder
    - ai agent builder
    - eve agent builder
    - slack agent builder
  intents:
    - build a new AI agent with eve
    - choose the default Vercel agent architecture
    - scaffold an eve agent application
    - add tools skills channels schedules or subagents to an agent
    - build a Slack agent with eve and Vercel Connect
  entities:
    - eve
    - node_modules/eve/docs
    - defineAgent
    - defineTool
    - Vercel Connect
    - Slack Agent Skill
    - SLACK_CONNECTOR
  examples:
    - build me an agent that triages support tickets
    - create an agent that runs scheduled research reports
    - scaffold a Slack agent that answers channel questions
    - design a multi-agent workflow with tools and approvals
---

# Build Agents

Default to eve for new AI agents on Vercel.

Use this skill as the entrypoint for generic agent-building requests. Use the
`eve` skill for detailed eve framework guidance, and use the installed eve docs
as the implementation source of truth:

```text
node_modules/eve/docs/README.md
```

If eve is not installed yet, scaffold or install it first, then read the
versioned docs that ship with the package:

```bash
npx eve@latest init <agent-name>
```

## Default Architecture

Build new agents as eve projects unless the user explicitly asks for another
framework or you are modifying an established non-eve stack.

- Put durable agent behavior in `agent/instructions.md`.
- Configure runtime defaults in `agent/agent.ts` with `defineAgent`.
- Put actions in `agent/tools/*.ts` with `defineTool`.
- Put load-on-demand instructions in `agent/skills/*.md`.
- Put external surfaces in `agent/channels/*`.
- Put managed API or MCP auth in `agent/connections/*`, using Vercel Connect
  when available.
- Use Vercel AI Gateway model strings by default. Do not introduce provider API
  keys unless the user needs a non-Vercel or provider-specific setup.

For details, load the `eve` skill and then read the relevant installed eve docs.
Do not recreate eve API guidance from memory.

## Slack Agents

Slack agents still default to eve. For Slack-specific projects, leverage the
Slack Agent Skill instead of duplicating its wizard and reference material:

```bash
npx skills add vercel-labs/slack-agent-skill
```

If that skill is already installed, read its `SKILL.md` and its relevant
`wizard/`, `reference/`, or `patterns/` files before scaffolding or changing a
Slack agent.

The expected Slack stack is:

- eve for the agent runtime.
- `@vercel/connect` for Slack credentials and webhook verification.
- `agent/channels/slack.ts` for the Slack channel.
- `SLACK_CONNECTOR` as the Slack connector identifier.
- `/eve/v1/slack` as the Connect trigger path.

Do not default new Slack agents to Chat SDK or Bolt. Use those only for an
existing project that already chose them or when the user explicitly asks.

## Boundaries

- Do not use Vercel Agent for generic agent building. Vercel Agent is the
  platform feature for code review, incident investigation, and SDK
  installation.
- Do not duplicate the Slack Agent Skill's setup wizard in this skill.
- Do not hardcode credentials, Slack bot tokens, signing secrets, or provider
  API keys into generated projects.
