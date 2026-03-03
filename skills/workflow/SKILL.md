---
name: workflow
description: Vercel Workflow DevKit (WDK) expert guidance. Use when building durable workflows, long-running tasks, AI agents that must survive crashes, or any async process that needs pause/resume, retries, and observability.
---

# Vercel Workflow DevKit (WDK)

You are an expert in the Vercel Workflow DevKit. WDK is an open-source TypeScript framework that makes durability a language-level concept. Functions can pause for minutes or months, survive deployments and crashes, and resume exactly where they stopped.

## Installation

```bash
npm install @workflow/core
# For AI agent durability:
npm install @workflow/ai
# For self-hosted Postgres worlds:
npm install @workflow/world-postgres
```

## Core Concepts

### Directives

WDK introduces two directives that turn ordinary async functions into durable workflows:

```ts
'use workflow'  // Marks a function as a durable workflow
'use step'      // Marks a block as an individually retryable, observable step
```

### How It Works

1. Each `'use step'` block compiles into an isolated API Route
2. Inputs and outputs are recorded for deterministic replay
3. If a deploy or crash occurs, the system replays execution from the last completed step
4. While a step executes, the workflow is suspended (zero resource consumption)
5. When the step completes, the workflow resumes automatically

### Basic Workflow

```ts
'use workflow'

export async function processOrder(orderId: string) {
  'use step'
  const order = await db.getOrder(orderId)

  'use step'
  const payment = await processPayment(order)

  'use step'
  await sendConfirmation(order, payment)

  'use step'
  await updateInventory(order)

  return { success: true, orderId }
}
```

Each step is:
- **Retryable**: Automatically retried on transient failures
- **Observable**: Step-level visibility in the dashboard
- **Durable**: State persisted between steps
- **Isolated**: Runs as its own API route

## Worlds (Execution Environments)

A "World" is where workflow state gets stored. WDK is portable across environments:

### Local World (Development)
```ts
// State stored as JSON files on disk
// Automatic in local development
```

### Vercel World (Production)
```ts
// Fully managed: scalable storage, distributed queuing
// Zero configuration when deployed to Vercel
// Automatic authentication
```

### Self-Hosted
```ts
// Use Postgres, Redis, or build your own World
// Full control over state storage
import { createPostgresWorld } from '@workflow/world-postgres'

const world = createPostgresWorld({
  connectionString: process.env.DATABASE_URL,
})
```

## DurableAgent (AI SDK Integration)

The killer feature: wrap AI SDK agents with durability.

```ts
import { DurableAgent } from '@workflow/ai/agent'
import { openai } from '@ai-sdk/openai'

const agent = new DurableAgent({
  model: openai('gpt-5-mini'),
  tools: {
    searchWeb: { /* ... */ },
    writeFile: { /* ... */ },
    sendEmail: { /* ... */ },
  },
  system: 'You are a research assistant.',
})

// Every LLM call and tool execution becomes a retryable step
'use workflow'
export async function researchTask(topic: string) {
  const result = await agent.generateText({
    prompt: `Research ${topic} and write a comprehensive report.`,
  })
  return result.text
}
```

With `DurableAgent`:
- Every LLM call is a step (retried on failure)
- Every tool execution is a step (individually observable)
- The entire agent loop survives crashes and deployments
- Results are aggregated within the workflow context
- Streaming works out of the box

## Patterns

### Long-Running Workflow with Pauses

```ts
'use workflow'

export async function onboardUser(userId: string) {
  'use step'
  await sendWelcomeEmail(userId)

  'use step'
  // Wait for user to verify email (could be hours/days)
  await waitForEvent(`email-verified:${userId}`)

  'use step'
  await setupDefaultWorkspace(userId)

  'use step'
  await sendOnboardingGuide(userId)
}
```

### Workflow with Error Handling

```ts
'use workflow'

export async function processRefund(orderId: string) {
  'use step'
  const order = await getOrder(orderId)

  'use step'
  try {
    await issueRefund(order)
  } catch (error) {
    // Step will be retried automatically on transient errors
    // For permanent failures, the error is recorded
    throw error
  }

  'use step'
  await notifyCustomer(order, 'refund_processed')
}
```

### Fan-Out / Parallel Steps

```ts
'use workflow'

export async function processImages(imageIds: string[]) {
  'use step'
  const images = await getImages(imageIds)

  // Process in parallel — each is its own step
  const results = await Promise.all(
    images.map(async (img) => {
      'use step'
      return await resizeImage(img)
    })
  )

  'use step'
  await saveResults(results)
}
```

## Integration with Next.js

Workflows are exposed as API routes in Next.js:

```ts
// app/api/workflows/process-order/route.ts
import { processOrder } from '@/workflows/process-order'

export async function POST(req: Request) {
  const { orderId } = await req.json()
  const result = await processOrder(orderId)
  return Response.json(result)
}
```

## Key Properties

- **Open source**: No vendor lock-in
- **TypeScript-native**: async/await, no YAML or state machines
- **Observable**: Step-level visibility, timing, inputs/outputs
- **Retryable**: Automatic retry with configurable backoff
- **Portable**: Local, Vercel, or self-hosted
- **AI-first**: DurableAgent wraps AI SDK seamlessly

## When to Use WDK vs. Regular Functions

| Scenario | Use |
|----------|-----|
| Simple API endpoint, fast response | Regular Route Handler |
| Multi-step process, must complete all steps | WDK Workflow |
| AI agent in production, must not lose state | WDK DurableAgent |
| Background job that can take minutes/hours | WDK Workflow |
| Process spanning multiple services | WDK Workflow |
| Quick one-shot LLM call | AI SDK directly |

## Official Documentation

- [Workflow DevKit](https://vercel.com/docs/workflow)
- [Vercel Functions](https://vercel.com/docs/functions) — Workflows compile to Vercel Functions
- [AI SDK Agents](https://ai-sdk.dev/docs/ai-sdk-core/agents) — DurableAgent wraps AI SDK Agent
- [GitHub: Workflow DevKit](https://github.com/vercel/workflow)
