---
name: build-agents
description: "Plan and build AI agents within a Vercel or eve architecture already selected by the user or existing project. Use for eve setup, Vercel agent architecture, and tools, channels, schedules, or subagents in that stack. General agent discussion or work in another established stack does not select eve or authorize scaffolding."
summary: "Build within the selected Vercel/eve architecture; preserve the project's existing stack and task scope."
metadata:
  priority: 10
  docs:
    - "https://eve.dev/docs"
    - "https://github.com/vercel/eve"
    - "https://github.com/vercel-labs/slack-agent-skill"
    - "https://docs.slack.dev/ai/getting-started-with-vercel-skill/"
    - "https://vercel.com/docs/connect"
  bashPatterns:
    - '\bnpx\s+eve(?:@latest)?\s+init\b'
    - '\bbunx\s+eve(?:@latest)?\s+init\b'
    - '\beve\s+init\b'
  promptSignals:
    phrases:
      - "build an eve agent"
      - "eve agent"
      - "scaffold eve"
      - "agent architecture on vercel"
      - "eve slack agent"
    allOf:
      - [eve, agent]
      - [vercel, agent, build]
      - [eve, slack]
    anyOf:
      - "eve"
      - "node_modules/eve"
      - "eve init"
    noneOf:
      - "user agent"
      - "user-agent"
      - "vercel agent"
      - "code review"
      - "incident investigation"
      - "eve online"
    minScore: 4
retrieval:
  aliases:
    - eve agent builder
    - agent development on Vercel
    - eve slack agent builder
  intents:
    - build a new AI agent with eve
    - design an agent within the selected Vercel architecture
    - scaffold an eve agent application
    - add tools skills channels schedules or subagents to an eve agent
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
    - build an eve agent that triages support tickets
    - create a scheduled research agent on our selected Vercel stack
    - add a Slack channel to this eve agent
    - design tools and approvals for our existing eve workflow
---

# Build Agents

Use this guidance within the user's selected Vercel/eve architecture. Preserve
confirmed framework, provider, deployment, and interaction decisions. A request
to discuss or design an agent stays at that level; it does not by itself call
for installing a framework or scaffolding a project.

## What eve is

eve is Vercel's filesystem-first framework for durable AI agents and
agent-powered applications. Agent behavior lives in files — instructions,
tools, skills — so it is versioned, reviewable, and deployable like any other
code. Sessions are durable: agents survive restarts and deploys and can run
long-lived or scheduled work.

High-level capabilities:

- **Durable sessions** — long-running, crash-safe conversations and jobs.
- **Tools** — typed actions the agent can take, defined in code.
- **Skills** — load-on-demand instruction files for specialized behavior.
- **Connections** — managed auth to external APIs and MCP servers, backed by
  Vercel Connect.
- **Channels** — external surfaces such as Slack, GitHub, or Linear where the
  agent sends and receives messages.
- **Sandboxes** — isolated environments for running generated or untrusted
  code.
- **Subagents, schedules, and evals** — delegation, recurring runs, and
  quality checks.
- **Frontend clients** — build agent-powered UIs on the same runtime.

## Getting started

1. Reuse the existing project when present. For an authorized new eve project,
   run init:

   ```bash
   npx eve@latest init <agent-name>
   ```

2. Read the docs. Versioned docs ship with the package at
   `node_modules/eve/docs/README.md` — once eve is installed, treat them as
   the implementation source of truth. Public docs: https://eve.dev/docs. Load
   the `eve` skill for detailed framework guidance while working inside the
   project. Do not recreate eve API guidance from memory.

Use eve when it is already selected or when the requested architecture work
establishes that it fits the workload. Resolve an unchosen framework at the
planning stage before scaffolding; use decisions and authorization already
present in the conversation without asking for them again. Keep existing
non-eve stacks and provider integrations unless migration is in scope. Use
AI Gateway when it is selected; do not migrate a working provider integration
solely because this skill is available.

## Slack Agents

For a Slack project that has selected eve, consult the Slack Agent Skill.
Use an installed copy; add it only when the requested setup needs it:

```bash
npx skills add vercel-labs/slack-agent-skill
```

If that skill is already installed, read its `SKILL.md` and its relevant
`wizard/`, `reference/`, or `patterns/` files before scaffolding or changing a
Slack agent.

For an eve Slack project, the stack is:

- eve for the agent runtime.
- `@vercel/connect` for Slack credentials and webhook verification.
- `agent/channels/slack.ts` for the Slack channel.
- `SLACK_CONNECTOR` as the Slack connector identifier.
- `/eve/v1/slack` as the Connect trigger path.

Preserve an existing or selected Chat SDK or Bolt project. Evaluate a new
Slack project's framework from its requirements before choosing eve.

## Boundaries

- Do not use Vercel Agent for generic agent building. Vercel Agent is the
  platform feature for code review, incident investigation, and SDK
  installation.
- Do not duplicate the Slack Agent Skill's setup wizard in this skill.
- Do not hardcode credentials, Slack bot tokens, signing secrets, or provider
  API keys into generated projects.
