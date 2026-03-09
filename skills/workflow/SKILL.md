---
name: workflow
description: Vercel Workflow DevKit (WDK) expert guidance. Use when building durable workflows, long-running tasks, API routes or agents that need pause/resume, retries, step-based execution, or crash-safe orchestration with Vercel Workflow.
metadata:
  priority: 9
  pathPatterns:
    - 'lib/workflow/**'
    - 'src/lib/workflow/**'
    - 'workflows/**'
    - 'lib/workflow.*'
    - 'src/lib/workflow.*'
    - 'workflow.*'
    - '*workflow*'
    - '*workflow*/**'
  importPatterns:
    - '@vercel/workflow'
    - 'workflow'
    - '@workflow/*'
    - '*workflow*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*@vercel/workflow\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@vercel/workflow\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@vercel/workflow\b'
    - '\byarn\s+add\s+[^\n]*@vercel/workflow\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bworkflow\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bworkflow\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bworkflow\b'
    - '\byarn\s+add\s+[^\n]*\bworkflow\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@workflow/'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@workflow/'
    - '\bbun\s+(install|i|add)\s+[^\n]*@workflow/'
    - '\byarn\s+add\s+[^\n]*@workflow/'
    - '\bnpx\s+workflow(?:@latest)?\b'
    - '\bbunx\s+workflow(?:@latest)?\b'
  promptSignals:
    phrases:
      - "vercel workflow"
      - "workflow devkit"
      - "durable workflow"
      - "durable execution"
      - "durable function"
      - "step function"
      - "step functions"
      - "use workflow"
      - "use step"
    allOf:
      - [workflow, durable]
      - [workflow, retry]
      - [workflow, resume]
      - [pause, resume]
      - [survive, crash]
    anyOf:
      - "long-running"
      - "long running"
      - "api route"
      - "route handler"
      - "agent"
      - "orchestration"
      - "observability"
    noneOf:
      - "github actions"
      - ".github/workflows"
      - "ci workflow"
      - "aws step functions"
    minScore: 6
---

# Vercel Workflow DevKit (WDK)

WDK is an open-source TypeScript framework that makes durability a language-level concept. Functions can pause for minutes or months, survive deployments and crashes, and resume exactly where they stopped.

## Status

WDK is in **public beta** (since October 2025) and open source. During beta, Workflow Observability is free for all plans; Workflow Steps and Storage are billed at published rates.

**Security**: Upgrade to `workflow@>=4.2.0-beta.64` — versions ≤4.1.0-beta.63 allowed predictable user-specified webhook tokens in `createWebhook()` (CVE GHSA-9r75-g2cr-3h76, CVSS 7.5). Run `npx workflow@latest` to update.

## Installation

```bash
npm install workflow@latest
# For AI agent durability:
npm install @workflow/ai@latest
```

> Run `npx workflow@latest` to scaffold or update your project.

**Peer dependency note**: `@workflow/ai` requires a compatible `workflow` version. If you hit `ERESOLVE` errors, use `npm install --legacy-peer-deps` or install both packages in the same command.

### Next.js Setup (Required)

Add the `withWorkflow` plugin to `next.config.ts`:

```ts
import { withWorkflow } from "workflow/next";

const nextConfig = {};
export default withWorkflow(nextConfig);
```

Without this, workflow routes will not be registered and `start()` calls will fail at runtime.

## Essential Imports

**Workflow primitives** (from `"workflow"`):

```ts
import { getWritable, getStepMetadata, getWorkflowMetadata } from "workflow";
import { sleep, fetch, defineHook, createHook, createWebhook } from "workflow";
import { FatalError, RetryableError } from "workflow";
```

**API operations** (from `"workflow/api"`):

```ts
import { start, getRun, resumeHook, resumeWebhook } from "workflow/api";
```

**Framework integration** (from `"workflow/next"`):

```ts
import { withWorkflow } from "workflow/next";
```

**AI agent** (from `"@workflow/ai/agent"`):

```ts
import { DurableAgent } from "@workflow/ai/agent";
```

## Core Directives

Two directives turn ordinary async functions into durable workflows:

```ts
"use workflow"  // First line of function — marks it as a durable workflow
"use step"      // First line of function — marks it as a retryable, observable step
```

**Critical sandbox rule**: Step functions have full Node.js access. Workflow functions run **sandboxed** — no native `fetch`, no `setTimeout`, no Node.js modules, and **no `getWritable().getWriter()` calls**. You MUST move all `getWritable()` usage into `"use step"` functions. Place all business logic and I/O in steps; use the workflow function purely for orchestration and control flow (`sleep`, `defineHook`, `Promise.race`).

## Canonical Project Structure (Next.js)

Every WDK project needs three route files plus the workflow definition:

```
workflows/
  my-workflow.ts              ← workflow definition ("use workflow" + "use step")
app/api/
  my-workflow/route.ts        ← POST handler: start(workflow, args) → { runId }
  readable/[runId]/route.ts   ← GET handler: SSE stream from run.getReadable()
  run/[runId]/route.ts        ← GET handler: run status via getRun(runId)
```

### 1. Workflow Definition (`workflows/my-workflow.ts`)

```ts
import { getWritable } from "workflow";

export type MyEvent =
  | { type: "step_start"; name: string }
  | { type: "step_done"; name: string }
  | { type: "done"; result: string };

export async function myWorkflow(input: string): Promise<{ result: string }> {
  "use workflow";

  const data = await stepOne(input);
  const result = await stepTwo(data);

  return { result };
}

async function stepOne(input: string): Promise<string> {
  "use step";
  const writer = getWritable<MyEvent>().getWriter();
  try {
    await writer.write({ type: "step_start", name: "stepOne" });
    // Full Node.js access here — fetch, db calls, etc.
    const result = await doWork(input);
    await writer.write({ type: "step_done", name: "stepOne" });
    return result;
  } finally {
    writer.releaseLock();
  }
}

async function stepTwo(data: string): Promise<string> {
  "use step";
  const writer = getWritable<MyEvent>().getWriter();
  try {
    await writer.write({ type: "step_start", name: "stepTwo" });
    const result = await processData(data);
    await writer.write({ type: "step_done", name: "stepTwo" });
    return result;
  } finally {
    writer.releaseLock();
  }
}
```

### 2. Start Route (`app/api/my-workflow/route.ts`)

```ts
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { myWorkflow } from "@/workflows/my-workflow";

export async function POST(request: Request) {
  const body = await request.json();
  const run = await start(myWorkflow, [body.input]);
  return NextResponse.json({ runId: run.runId });
}
```

**IMPORTANT**: Never call the workflow function directly. Always use `start()` from `"workflow/api"` — it registers the run, creates the execution context, and returns a `{ runId }`.

### 3. Readable Stream Route (`app/api/readable/[runId]/route.ts`)

```ts
import { NextRequest } from "next/server";
import { getRun } from "workflow/api";

type ReadableRouteContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(_request: NextRequest, { params }: ReadableRouteContext) {
  const { runId } = await params;

  let run;
  try {
    run = await getRun(runId);
  } catch {
    return Response.json(
      { ok: false, error: { code: "RUN_NOT_FOUND", message: `Run ${runId} not found` } },
      { status: 404 }
    );
  }

  const readable = run.getReadable();
  const encoder = new TextEncoder();
  const sseStream = (readable as unknown as ReadableStream).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        const data = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      },
    })
  );

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

### 4. Run Status Route (`app/api/run/[runId]/route.ts`)

```ts
import { NextResponse } from "next/server";
import { getRun } from "workflow/api";

type RunRouteContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(_request: Request, { params }: RunRouteContext) {
  const { runId } = await params;

  let run;
  try {
    run = await getRun(runId);
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "RUN_NOT_FOUND", message: `Run ${runId} not found` } },
      { status: 404 }
    );
  }

  const [status, workflowName, createdAt, startedAt, completedAt] =
    await Promise.all([
      run.status,
      run.workflowName,
      run.createdAt,
      run.startedAt,
      run.completedAt,
    ]);

  return NextResponse.json({
    runId,
    status,
    workflowName,
    createdAt: createdAt.toISOString(),
    startedAt: startedAt?.toISOString() ?? null,
    completedAt: completedAt?.toISOString() ?? null,
  });
}
```

## Streaming with `getWritable()`

`getWritable<T>()` returns a `WritableStream` scoped to the current run. Call it inside step functions and always release the lock:

```ts
async function emit<T>(event: T): Promise<void> {
  "use step";
  const writer = getWritable<T>().getWriter();
  try {
    await writer.write(event);
  } finally {
    writer.releaseLock();
  }
}
```

Consumers read via `getRun(runId).getReadable()` in the readable route (see above).

## Hooks — Waiting for External Events

Use `defineHook` for typed, reusable hooks:

```ts
import { defineHook, getWritable, sleep } from "workflow";

export interface ApprovalPayload {
  approved: boolean;
  comment?: string;
}

export const approvalHook = defineHook<ApprovalPayload>();

export async function approvalGate(orderId: string): Promise<{ status: string }> {
  "use workflow";

  const hook = approvalHook.create({ token: `approval:${orderId}` });

  // Race between approval and timeout
  const result = await Promise.race([
    hook.then((payload) => ({ type: "approval" as const, payload })),
    sleep("24h").then(() => ({ type: "timeout" as const, payload: null })),
  ]);

  if (result.type === "timeout") {
    return { status: "timeout" };
  }
  return { status: result.payload!.approved ? "approved" : "rejected" };
}
```

Resume hooks from an API route:

```ts
import { resumeHook } from "workflow/api";

export async function POST(req: Request) {
  const { token, data } = await req.json();
  await resumeHook(token, data);
  return new Response("ok");
}
```

## Error Handling

```ts
import { FatalError, RetryableError } from "workflow";

async function callExternalAPI(url: string) {
  "use step";
  const res = await fetch(url);

  if (res.status >= 400 && res.status < 500) {
    throw new FatalError(`Client error: ${res.status}`);  // No retry
  }
  if (res.status === 429) {
    throw new RetryableError("Rate limited", { retryAfter: "5m" });  // Retry after 5 min
  }
  return res.json();
}
```

Step retry metadata:

```ts
import { getStepMetadata } from "workflow";

async function processWithRetry(id: string) {
  "use step";
  const { attempt } = getStepMetadata();
  console.log(`Attempt ${attempt} for ${id}`);
  // ...
}
```

## Sandbox Limitations & Workarounds

| Limitation | Solution |
|-----------|----------|
| No native `fetch()` in workflow scope | Import `fetch` from `"workflow"` or move to a step |
| No `setTimeout`/`setInterval` | Use `sleep()` from `"workflow"` |
| No Node.js modules in workflow scope | Move all Node.js logic to step functions |

## DurableAgent (AI SDK Integration)

```ts
import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";
import { z } from "zod";

async function searchDatabase(query: string) {
  "use step";
  // Full Node.js access — real DB calls here
  return `Results for "${query}"`;
}

export async function researchAgent(topic: string) {
  "use workflow";

  const agent = new DurableAgent({
    model: "anthropic/claude-sonnet-4-5",
    system: "You are a research assistant.",
    tools: {
      search: {
        description: "Search the database",
        inputSchema: z.object({ query: z.string() }),
        execute: searchDatabase,  // Tool execute uses "use step"
      },
    },
  });

  const result = await agent.stream({
    messages: [{ role: "user", content: `Research ${topic}` }],
    writable: getWritable(),
    maxSteps: 10,
  });

  return result.messages;
}
```

Every LLM call and tool execution becomes a retryable step. The entire agent loop survives crashes and deployments.

## Common Patterns

### Fan-Out / Parallel Steps

```ts
export async function processImages(imageIds: string[]) {
  "use workflow";

  const results = await Promise.all(
    imageIds.map(async (id) => {
      return await resizeImage(id);  // Each is its own step
    })
  );

  await saveResults(results);
}

async function resizeImage(id: string) {
  "use step";
  // ...
}
```

### Saga with Compensation

```ts
import { FatalError, getWritable } from "workflow";

export async function upgradeSaga(userId: string) {
  "use workflow";

  await reserveSeats(userId);

  try {
    await chargePayment(userId);
  } catch {
    await releaseSeats(userId);  // Compensate
    throw new FatalError("Payment failed");
  }

  await activatePlan(userId);
}
```

## Debugging

```bash
npx workflow health                    # Check endpoints
npx workflow web                       # Visual dashboard
npx workflow inspect runs              # List all runs
npx workflow inspect run <run_id>      # Inspect specific run
npx workflow cancel <run_id>           # Cancel execution
```

## When to Use WDK vs Regular Functions

| Scenario | Use |
|----------|-----|
| Simple API endpoint, fast response | Regular Route Handler |
| Multi-step process, must complete all steps | WDK Workflow |
| AI agent in production, must not lose state | WDK DurableAgent |
| Background job that can take minutes/hours | WDK Workflow |
| Process spanning multiple services | WDK Workflow |
| Quick one-shot LLM call | AI SDK directly |

## Framework Support

Next.js, Nitro, SvelteKit, Astro, Express, Hono (supported). TanStack Start, React Router (in development).

## Official Documentation

- [Workflow DevKit](https://vercel.com/docs/workflow)
- [Website](https://useworkflow.dev)
- [GitHub](https://github.com/vercel/workflow)
- [Workflow Builder Template](https://vercel.com/templates/next.js/workflow-builder)
