---
name: queues
description: Vercel Queues guidance — durable topics with at-least-once delivery, independent consumer groups, retries, delays, and idempotency keys via @vercel/queue (JS) or vercel-queue (Python). Use when deferring background work, buffering traffic, fanning out events, or choosing between Queues and Workflows.
summary: "Vercel Queues (beta) publishes JSON messages to durable topics with `send()` from `@vercel/queue`; consumers are Vercel Functions exported with `handleCallback()` and registered in vercel.json under `functions.<path>.experimentalTriggers` as `{ type: 'queue/v2beta', topic: '<name>' }`. Delivery is at-least-once with automatic retries; use Workflows instead for multi-step durable logic."
metadata:
  priority: 6
  docs:
    - "https://vercel.com/docs/queues"
    - "https://vercel.com/docs/queues/sdk"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - 'app/api/queues/**'
    - 'src/app/api/queues/**'
    - 'pages/api/queues/**'
    - 'lib/queue.*'
    - 'src/lib/queue.*'
    - 'lib/queues/**'
    - 'src/lib/queues/**'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*@vercel/queue\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@vercel/queue\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@vercel/queue\b'
    - '\byarn\s+add\s+[^\n]*@vercel/queue\b'
    - '\b(pip|uv)\s+(install|add)\s+[^\n]*vercel-queue\b'
  importPatterns:
    - "@vercel/queue"
  promptSignals:
    phrases:
      - "vercel queues"
      - "@vercel/queue"
      - "background job"
      - "background jobs"
      - "message queue"
      - "job queue"
      - "consumer group"
    allOf:
      - [vercel, queues]
      - [queue, topic]
      - [queue, consumer]
      - [queue, buffer]
      - [fan, out]
    anyOf:
      - "queue"
      - "topic"
      - "retry"
      - "consumer"
      - "buffer"
      - "background"
    noneOf:
      - "build queue"
      - "deployment queue"
      - "queued deployment"
      - "deployments stuck"
      - "queues up deployments"
      - "queue up deployments"
      - "queues my deployments"
      - "queues our deployments"
      - "queues your deployments"
      - "queues the deployments"
      - "queues deployments"
      - "queues builds"
      - "queues my builds"
    minScore: 6
retrieval:
  aliases:
    - queues
    - message queue
    - background jobs
    - event streaming
    - pub sub
  intents:
    - defer work to a queue
    - process background jobs
    - fan out events to consumers
    - retry failed jobs
    - buffer traffic spikes
  entities:
    - Vercel Queues
    - "@vercel/queue"
    - topic
    - consumer group
    - handleCallback
    - experimentalTriggers
chainTo:
  -
    pattern: '"use workflow"|"use step"|from\s+[''"]workflow[''"]'
    targetSkill: workflow
    message: 'Workflow SDK code alongside Queues — Workflows is built on Queues and adds durable steps, sleep, and hooks. Loading Workflow guidance.'
  -
    pattern: 'from\s+[''"](bullmq|bull|bee-queue|agenda)[''"]|@aws-sdk/client-sqs'
    targetSkill: queues
    message: 'Third-party job queue detected — Vercel Queues provides durable topics with retries and fan-out without running a broker. Loading Queues guidance.'
    skipIfFileContains: '@vercel/queue'

---

# Vercel Queues

You are an expert in Vercel Queues, the durable message topics that power background work and agent events on Vercel.

## What It Is

Vercel Queues (public beta) gives you durable, append-only topics. Producers publish JSON messages, and every subscribed consumer group receives every message with at-least-once delivery and automatic retries. New consumer groups can join later and replay non-expired history. Queues is the primitive under Vercel Workflows; use Queues directly when you need control over publishing, consumption, and routing.

- **Topic**: a named durable log of messages, created on first publish
- **Consumer group**: an independent subscriber that receives every message on a topic
- **Delivery**: at-least-once; handlers must be idempotent
- **Retention**: 24 hours by default, up to 7 days; delivery can be delayed up to the retention period
- **Modes**: push (Vercel invokes your function) or poll (your own workers pull messages from any environment)

## Choose Queues or Workflows

| Need | Use | Why |
|------|-----|-----|
| Fire-and-forget background job, fan-out, buffering | **Queues** | Direct publish/consume, independent consumer groups |
| Multi-step logic with sleep, hooks, or human approval | **Workflows** (`⤳ skill: workflow`) | Durable steps and replay built on top of Queues |
| Scheduled invocation on a cron | Cron Jobs (`⤳ skill: vercel-functions`) | Time-based trigger, not message-based |

## Quickstart (Next.js App Router)

Install the SDK:

```bash
npm install @vercel/queue
```

Publish from any route, Server Action, or function:

```ts
// app/api/orders/route.ts
import { send } from '@vercel/queue';

export async function POST(request: Request) {
  const body = await request.json();
  const { messageId } = await send('orders', { orderId: body.orderId, action: 'process' });
  return Response.json({ messageId });
}
```

Consume with a push-mode handler. Messages are acknowledged when the handler returns and retried when it throws:

```ts
// app/api/queues/process-order/route.ts
import { handleCallback } from '@vercel/queue';

export const POST = handleCallback(async (message, metadata) => {
  await processOrder(message);
  console.log('processed', metadata.messageId, 'delivery', metadata.deliveryCount);
});
```

Register the consumer in `vercel.json` (or `vercel.ts`) so Vercel routes the topic to that function:

```json
{
  "functions": {
    "app/api/queues/process-order/route.ts": {
      "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "orders" }]
    }
  }
}
```

Run `vercel link` and `vercel env pull` before local development so the SDK can authenticate.

## Send Options

```ts
await send('orders', payload, {
  region: 'sfo1',            // target a specific region
  retentionSeconds: 3600,    // message TTL; min 60, max 604800 (7 days); default 24 hours
  delaySeconds: 60,          // delay first delivery; max 7 days, capped at the TTL
  idempotencyKey: 'order-123', // duplicates within the retention window are dropped
  headers: { 'x-trace-id': 'abc-123' },
});
```

Create a `QueueClient` when you need defaults, a fixed region, or multiple clients:

```ts
// lib/queue.ts
import { QueueClient } from '@vercel/queue';

const queue = new QueueClient({ region: 'sfo1' });
export const { send, handleCallback } = queue;
```

## Consumer Options and Retries

`handleCallback(handler, options)` accepts:

| Option | Default | Notes |
|--------|---------|-------|
| `visibilityTimeoutSeconds` | 300 | How long a message stays in flight; the SDK re-extends the lease while the handler runs |
| `retry` | built-in backoff | `(error, metadata) => { afterSeconds } \| { acknowledge: true } \| undefined` |

Handle poison messages by acknowledging after a delivery-count threshold:

```ts
export const POST = handleCallback(processOrder, {
  retry: (error, metadata) => {
    if (metadata.deliveryCount > 5) return { acknowledge: true }; // stop retrying
    return { afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 5) };
  },
});
```

`metadata` includes `messageId`, `deliveryCount`, `createdAt`, `expiresAt`, `topicName`, `consumerGroup`, and `region`.

For Express, Connect, or Next.js Pages Router handlers use `queue.handleNodeCallback(async (message, metadata) => ...)` from a `QueueClient` instance, which takes `(req, res)`.

## Other Runtimes and Frameworks

- **Python**: `vercel-queue` publishes and consumes with the same topic model, and FastAPI, Flask, and Django apps can use it; Celery and Dramatiq integrations are documented under the Python backend frameworks.
- **Nitro / Nuxt**: declare `vercel.queues.triggers` in `nitro.config.ts` and handle messages with the `vercel:queue` runtime hook; `send` from `@vercel/queue` works in any server route.
- **Poll mode**: pull messages from your own workers in any environment when push delivery to a Vercel Function does not fit.
- **Payloads**: JSON by default; use `BufferTransport` for binary or `StreamTransport` for large bodies when constructing a `QueueClient`.

## Errors

`@vercel/queue` exports typed errors: `UnauthorizedError`, `BadRequestError`, `DuplicateMessageError` (idempotency-key collision), `MessageNotFoundError`, and `QueueEmptyError`.

## Common Pitfalls

1. **Missing trigger**: a `handleCallback` route with no `experimentalTriggers` entry never receives messages. Register every consumer in `vercel.json`/`vercel.ts`.
2. **Non-idempotent handlers**: delivery is at-least-once. Key side effects on `metadata.messageId` or your own `idempotencyKey`.
3. **Retrying forever**: without a `retry` policy that acknowledges poison messages, a permanently failing message is redelivered until it expires.
4. **Using Queues for multi-step logic**: if you need sleep, hooks, or approvals between steps, use Workflows instead of chaining topics by hand.
5. **Local dev without credentials**: run `vercel link` and `vercel env pull` first; otherwise `send()` fails with `UnauthorizedError`.

## References

- 📖 docs: https://vercel.com/docs/queues
- 📖 JS SDK: https://vercel.com/docs/queues/sdk
- 📖 Python SDK: https://vercel.com/docs/queues/python-sdk
- 📖 poll mode: https://vercel.com/docs/queues/poll-mode
- 📖 pricing and limits: https://vercel.com/docs/queues/pricing
