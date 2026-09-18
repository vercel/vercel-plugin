---
name: vercel-agent
description: Vercel Agent guidance — dashboard and Slack chat, code review, production investigation, approved actions, and product installation. Use when configuring or working with Vercel's AI assistant.
metadata:
  priority: 4
  docs:
    - "https://vercel.com/docs"
    - "https://sdk.vercel.ai/docs"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns: 
    - '.github/workflows/vercel*.yml'
    - '.github/workflows/vercel*.yaml'
    - '.github/workflows/deploy*.yml'
    - '.github/workflows/deploy*.yaml'
    - '.github/workflows/preview*.yml'
    - '.github/workflows/preview*.yaml'
  bashPatterns: 
    - '\bvercel\s+agent\b'
retrieval:
  aliases:
    - ai code review
    - production debugger
    - dashboard chat
    - slack agent
    - vercel ai tools
    - pr analyzer
  intents:
    - set up vercel agent
    - automate code review
    - investigate incident
    - configure ai tools
  entities:
    - Vercel Agent
    - code review
    - incident investigation
    - approved actions
chainTo:
  -
    pattern: 'uses:\s*vercel/|vercel-action|VERCEL_TOKEN.*github'
    targetSkill: deployments-cicd
    message: 'GitHub Actions with Vercel detected — loading CI/CD guidance for deployment workflows, preview URLs, and production promotions.'
---

# Vercel Agent

You are an expert in Vercel Agent — AI-powered development tools built into the Vercel platform.

## What It Is

Vercel Agent is an AI assistant built into Vercel. It uses project, deployment, log, metric, configuration, usage, and repository context to answer questions, investigate production issues, review code, install supported products, and propose approved actions.

Dashboard chat, Slack chat, Investigations, and Code Review are in public beta for Pro and Enterprise teams.

## Capabilities

### Chat

- Start conversations from the **Agent** button in the Vercel dashboard.
- Connect Slack to ask questions and investigate issues from supported conversations.
- Vercel Agent is read-only by default. When a task requires a write, it presents a scoped plan and waits for approval.
- Approved work can make a supported change directly or open a pull request, depending on the task.

### Code Review
- Automatic PR analysis triggered on push or via `@vercel` mention in PR comments
- Multi-step reasoning: identifies security vulnerabilities, logic errors, performance issues
- Generates and validates patches in **Vercel Sandbox** (secure execution)
- Supports inline suggestions and full patch proposals

### Investigation
- Analyzes anomaly alerts, failed deployments, runtime errors, cost issues, and performance issues using project logs and metrics.
- Observability Plus includes 10 investigations per billing cycle. Additional investigations are billed by token use.

### Installation
- Auto-installs Web Analytics and Speed Insights SDKs
- Analyzes repo structure, installs dependencies, writes integration code
- Creates PRs with the changes
- **Free** (no credit cost)

## Pricing

- Paid Vercel Agent work uses the underlying provider inference rate with no markup, plus a Vercel Token Rate of $0.25 per million input, output, and cached tokens.
- Chat and Slack include a limited number of simple requests during the public beta.
- Observability Plus includes 10 investigations per billing cycle.
- Installation has no Agent charge, though installed products retain their normal usage charges.

## Configuration

Select **Agent** in the top-right corner of the Vercel dashboard to start a conversation or configure Chat, Slack, Code Review, Investigations, and Installation. Vercel Agent is a platform service and does not require an npm package.

## When to Use

- Automated security and quality checks on every PR
- Root-cause analysis when anomaly alerts fire
- Questions and approved operational actions from the dashboard or Slack
- Quick SDK installation for analytics/monitoring

## References

- 📖 docs: https://vercel.com/docs/agent
- 📖 pricing: https://vercel.com/docs/agent/pricing
- 📖 permissions: https://vercel.com/docs/agent/chat/permissions
