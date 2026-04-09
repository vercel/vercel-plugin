/**
 * Single source of truth for benchmark scenarios.
 *
 * Both scripts/benchmark-runner.ts (local WezTerm) and
 * .claude/skills/benchmark-sandbox/sandbox-runner.ts (Vercel Sandbox)
 * import from this module — no duplication, no regex+eval fallbacks.
 */

export interface BenchmarkProject {
  slug: string;
  prompt: string;
  expectedSkills: string[];
}

export const PROJECTS: BenchmarkProject[] = [
  {
    slug: "01-doc-qa-agent",
    prompt:
      "Build a documentation Q&A agent with semantic search, citation links, and follow-up question memory. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-sdk", "vercel-storage", "nextjs"],
  },
  {
    slug: "02-customer-support-agent",
    prompt:
      "Create a customer support agent that triages tickets, drafts replies, and escalates urgent conversations with an authenticated admin dashboard. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-sdk", "auth", "vercel-storage"],
  },
  {
    slug: "03-deploy-monitor",
    prompt:
      "Build a deploy monitor that tracks preview and production deploy health, surfaces incidents, and posts summaries to an internal dashboard. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["observability", "deployments-cicd", "vercel-api"],
  },
  {
    slug: "04-multi-model-router",
    prompt:
      "Create a multi-model router that chooses the best model per request, supports failover policies, and streams responses to the UI. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-gateway", "ai-sdk", "nextjs"],
  },
  {
    slug: "05-slack-pr-reviewer",
    prompt:
      "Build a Slack PR reviewer that reacts to pull-request webhooks, summarizes diffs, and posts review guidance to Slack threads. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-sdk", "vercel-functions", "vercel-api"],
  },
  {
    slug: "06-content-pipeline",
    prompt:
      "Create a content pipeline that ingests drafts, runs scheduled enrichment, and publishes to multiple channels with approvals. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["workflow", "cron-jobs", "cms"],
  },
  {
    slug: "07-feature-rollout",
    prompt:
      "Build a feature rollout system with audience targeting, gradual percentage releases, and rollback controls with experiment tracking. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["vercel-flags", "observability"],
  },
  {
    slug: "08-event-driven-crm",
    prompt:
      "Create an event-driven CRM that processes inbound events, updates customer timelines, and triggers follow-up workflows. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["vercel-queues", "workflow", "vercel-storage"],
  },
  {
    slug: "09-code-sandbox-tutor",
    prompt:
      "Build a code sandbox tutor that runs untrusted snippets safely, explains execution errors, and gives step-by-step coaching. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["vercel-sandbox", "ai-sdk", "nextjs"],
  },
  {
    slug: "10-multi-agent-research",
    prompt:
      "Create a multi-agent research assistant that delegates subtasks, aggregates findings, and produces a cited final report. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["ai-sdk", "workflow", "chat-sdk"],
  },
  {
    slug: "11-discord-game-master",
    prompt:
      "Build a Discord game master bot with turn tracking, encounter memory, and persistent campaign state across sessions. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["chat-sdk", "runtime-cache", "vercel-functions"],
  },
  {
    slug: "12-compliance-auditor",
    prompt:
      "Create a compliance auditor that scans configs, flags policy drift, and generates remediation reports for engineering teams. Link the project to my vercel-labs team so we can deploy it later.",
    expectedSkills: ["vercel-firewall", "observability", "vercel-api"],
  },
];
