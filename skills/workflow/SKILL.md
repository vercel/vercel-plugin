---
name: workflow
description: Vercel Workflow SDK expert guidance. Use when building durable workflows, long-running tasks, API routes or agents that need pause/resume, retries, step-based execution, or crash-safe orchestration with Vercel Workflow.
metadata:
  priority: 9
  docs:
    - "https://vercel.com/docs/workflow"
    - "https://workflow-sdk.dev"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - 'lib/workflow/**'
    - 'src/lib/workflow/**'
    - 'lib/workflow.*'
    - 'src/lib/workflow.*'
    - 'workflow.*'
    - '*workflow*'
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
      # Direct workflow mentions
      - "vercel workflow"
      - "workflow sdk"
      # Legacy product name retained only as an input matcher.
      - "workflow devkit"
      - "durable workflow"
      - "durable execution"
      - "durable function"
      - "durable pipeline"
      - "durable process"
      - "durable agent"
      - "durable chat"
      - "step function"
      - "step functions"
      - "use workflow"
      - "use step"
      # Pipeline / multi-step language (the BIG gap — natural product prompts)
      - "multi-step pipeline"
      - "multi step pipeline"
      - "multi-step process"
      - "multi step process"
      - "multi-step creation"
      - "multi-step generation"
      - "processing pipeline"
      - "creation pipeline"
      - "generation pipeline"
      - "content pipeline"
      - "production pipeline"
      - "approval pipeline"
      - "ingestion pipeline"
      - "streams progress"
      - "stream progress"
      - "streams each phase"
      - "streams each step"
      - "streams each"
      - "stream each"
      # Reliability / durability language (missed in customer-support eval)
      - "survive page reload"
      - "survive page reloads"
      - "survive a crash"
      - "survive crashes"
      - "survive network"
      - "fault-tolerant"
      - "fault tolerant"
      - "crash-safe"
      - "crash safe"
      - "automatically retry"
      - "auto retry"
      - "retry on failure"
      - "retry on error"
      - "reliable and retry"
      - "reliable processing"
      - "individually reliable"
      - "each step reliable"
      - "each step should be reliable"
      - "steps should be reliable"
      - "reliable with automatic retry"
      - "reliable with retry"
      - "retry on transient"
      - "transient failures"
      - "session persistence"
      - "session should persist"
      - "session survives"
      - "reconnect automatically"
      - "auto reconnect"
      - "reconnect if the network"
      - "reconnect on disconnect"
      - "resume after failure"
      - "resume after crash"
      - "resume on reconnect"
      # Human-in-the-loop / approval patterns
      - "human-in-the-loop"
      - "human in the loop"
      - "wait for approval"
      - "approval step"
      - "approval before"
      - "editorial approval"
      - "manual approval"
      - "wait for user"
      - "pause until"
      - "wait for response"
      - "callback url"
      - "webhook callback"
      # Conversational AI with durability
      - "chat should survive"
      - "chat survives"
      - "conversation should persist"
      - "conversation persists"
      - "conversation should survive"
      # Sequential / chain / trigger orchestration language
      - "sequential chain"
      - "email chain"
      - "chain of emails"
      - "chain of steps"
      - "chain engine"
      - "chain with triggers"
      - "trigger chain"
      - "triggered chain"
      - "webhook chain"
      - "webhook pipeline"
      - "webhook orchestration"
      - "multi-service trigger"
      - "cross-service trigger"
      - "various triggers"
      - "different triggers"
      - "triggers from different"
      - "triggers from various"
      - "sequential steps"
      - "sequential pipeline"
      - "sequential process"
      - "sequential emails"
      - "escalation chain"
      - "escalation pipeline"
      - "state machine"
      - "step-based"
      - "step based"
      - "delay between steps"
      - "delay between emails"
      - "delayed steps"
      - "conditional steps"
      - "skip steps"
      - "branch based on"
      - "wait for webhook"
      - "wait for trigger"
      - "wait for event"
      - "orchestrate emails"
      - "orchestrate webhooks"
      - "orchestrate services"
      - "chain across services"
      # Debugging
      - "workflow stuck"
      - "workflow hung"
      - "workflow hanging"
      - "workflow waiting"
      - "workflow failing"
      - "workflow timeout"
      - "workflow not running"
      - "workflow error"
      - "check workflow"
      - "workflow logs"
      - "workflow run status"
      - "debug workflow"
      - "workflow not finishing"
      - "workflow not responding"
      - "workflow stalled"
      - "workflow pending"
      - "step is stuck"
      - "step is hanging"
      - "why is my workflow"
      - "workflow run"
      - "step failed"
      - "run status"
      - "run failed"
      - "run logs"
      - "workflow run failed"
      - "workflow step failed"
    allOf:
      - [workflow, durable]
      - [workflow, retry]
      - [workflow, resume]
      - [pause, resume]
      - [survive, crash]
      - [survive, reload]
      - [survive, disconnect]
      - [pipeline, stream]
      - [pipeline, step]
      - [pipeline, durable]
      - [pipeline, reliable]
      - [pipeline, retry]
      - [multi-step, stream]
      - [multi-step, reliable]
      - [generation, pipeline]
      - [creation, pipeline]
      - [process, stream]
      - [process, reliable]
      - [process, retry]
      - [retry, failure]
      - [retry, error]
      - [retry, automatically]
      - [retry, transient]
      - [reliable, retry]
      - [individually, reliable]
      - [steps, reliable]
      - [sandbox, reliable]
      - [sandbox, retry]
      - [reconnect, network]
      - [reconnect, drop]
      - [reconnect, disconnect]
      - [session, persist]
      - [session, survive]
      - [session, reload]
      - [session, reconnect]
      - [chat, survive]
      - [chat, persist]
      - [chat, reconnect]
      - [chat, durable]
      - [chat, fault]
      - [conversation, persist]
      - [conversation, survive]
      - [approval, wait]
      - [approval, human]
      - [each, step]
      - [each, phase]
      - [each, stage]
      - [step, reliable]
      - [step, retry]
      # Chain / trigger / sequential orchestration
      - [chain, trigger]
      - [chain, sequential]
      - [chain, email]
      - [chain, webhook]
      - [chain, delay]
      - [chain, step]
      - [chain, escalat]
      - [sequential, trigger]
      - [sequential, email]
      - [sequential, step]
      - [sequential, webhook]
      - [trigger, orchestrat]
      - [trigger, service]
      - [trigger, delay]
      - [trigger, sequential]
      - [webhook, chain]
      - [webhook, orchestrat]
      - [webhook, pipeline]
      - [webhook, sequential]
      - [email, trigger]
      - [email, pipeline]
      - [email, sequential]
      - [email, delay]
      - [email, escalat]
      - [escalat, trigger]
      - [escalat, step]
      - [escalat, email]
      - [state, machine]
      - [conditional, step]
      - [conditional, skip]
      - [branch, condition]
      - [wait, webhook]
      - [wait, trigger]
      - [wait, event]
      - [workflow, stuck]
      - [workflow, hung]
      - [workflow, timeout]
      - [workflow, error]
      - [workflow, logs]
      - [workflow, debug]
      - [workflow, check]
      - [workflow, failing]
      - [workflow, status]
      - [run, status]
      - [step, failed]
      - [step, stuck]
      - [step, timeout]
      - [workflow, run]
      - [run, logs]
    anyOf:
      - "long-running"
      - "long running"
      - "multi-step"
      - "multi step"
      - "pipeline"
      - "orchestration"
      - "step-by-step"
      - "step by step"
      - "each piece"
      - "each step"
      - "each phase"
      - "each stage"
      - "phase"
      - "phases"
      - "stage"
      - "stages"
      - "durable"
      - "reliable"
      - "fault-tolerant"
      - "retry"
      - "reconnect"
      - "survive"
      - "persist"
      - "approval"
      - "chain"
      - "sequential"
      - "trigger"
      - "webhook"
      - "escalation"
      - "state machine"
      - "orchestrate"
      - "orchestration"
    noneOf:
      - "github actions"
      - ".github/workflows"
      - "ci workflow"
      - "aws step functions"
    minScore: 4
validate:
  -
    pattern: experimental_createWorkflow
    message: 'experimental_createWorkflow is now stable — use createWorkflow from @vercel/workflow. Run npx @ai-sdk/codemod v6 for automated migration.'
    severity: error
    upgradeToSkill: workflow
    upgradeWhy: 'Guides migration from experimental_createWorkflow to the stable createWorkflow API and then to the "use workflow" directive.'
  -
    pattern: from\s+['"]@vercel/workflow['"]
    message: 'Workflow SDK requires AI Gateway OIDC setup — ensure vercel link + vercel env pull for VERCEL_OIDC_TOKEN'
    severity: recommended
  -
    pattern: setTimeout|setInterval
    message: 'setTimeout/setInterval are not available in workflow sandbox scope — use sleep() from "workflow" for delays'
    severity: error
    skipIfFileContains: "use step"
  -
    pattern: context\.run\s*\(
    message: 'context.run() is not a Workflow SDK pattern — use "use step" directive for retryable, observable steps'
    severity: error
    upgradeToSkill: workflow
    upgradeWhy: 'Guides migration from context.run() to the "use step" directive for durable, retryable workflow steps.'
  -
    pattern: \brequire\s*\(
    message: 'require() is not available in workflow sandbox scope — use ESM imports and move Node.js logic into "use step" functions'
    severity: error
    skipIfFileContains: "use step"
  -
    pattern: getWritable\(\)
    message: 'getWritable() must only be called inside "use step" functions — workflow sandbox scope does not support it'
    severity: recommended
    skipIfFileContains: "use step"
  -
    pattern: createWorkflow\s*\(
    message: 'createWorkflow() is the legacy API — use the "use workflow" directive on an async function instead'
    severity: error
    upgradeToSkill: workflow
    upgradeWhy: 'Guides migration from createWorkflow() function API to the "use workflow" directive pattern.'
    skipIfFileContains: experimental_createWorkflow
  -
    pattern: streamObject\s*\(
    message: 'streamObject() was removed in AI SDK v6 — use streamText() with output: Output.object() instead'
    severity: error
    upgradeToSkill: ai-sdk
    upgradeWhy: 'Guides migration from streamObject to streamText + Output.object() with correct v6 streaming patterns.'
  -
    pattern: await\s+\w+Workflow\s*\(
    message: 'Do not call workflow functions directly — use start() from "workflow/api" to register the run and get a runId'
    severity: recommended
    skipIfFileContains: "use workflow"
  -
    pattern: \bfetch\s*\(
    message: 'Native fetch() is not available in workflow sandbox scope — import fetch from "workflow" or move the call into a "use step" function'
    severity: recommended
    skipIfFileContains: "use step"
  -
    pattern: '"use step"'
    message: "Workflow steps should include console.log or structured logging for observability — add logging at step entry/exit to debug hangs"
    severity: warn
    skipIfFileContains: "console\\.(log|warn|error|info)"
  -
    pattern: '"use workflow"'
    message: "Workflow files should import and use logging — add console.log or a logger at key execution points for debugging"
    severity: warn
    skipIfFileContains: "console\\.(log|warn|error|info)"
chainTo:
  -
    pattern: 'DurableAgent|@workflow/ai'
    targetSkill: ai-sdk
    message: 'DurableAgent detected without AI SDK context — loading AI SDK guidance for tool calling, Agent class, and model configuration.'
    skipIfFileContains: 'from\s+[''"]ai[''"]|@ai-sdk/|streamText|generateText'
  -
    pattern: 'process\.env\.(OPENAI_API_KEY|ANTHROPIC_API_KEY)|from\s+[''"]@ai-sdk/(anthropic|openai)[''""]'
    targetSkill: ai-gateway
    message: 'Direct provider API key in workflow — loading AI Gateway guidance for OIDC auth (required for Workflow SDK AI steps).'
    skipIfFileContains: 'gateway\(|@ai-sdk/gateway|VERCEL_OIDC'
  -
    pattern: 'setTimeout\s*\(|setInterval\s*\('
    targetSkill: vercel-functions
    message: 'Timer-based delay in workflow code — use sleep() from "workflow" instead of setTimeout/setInterval. Loading Vercel Functions guidance.'
    skipIfFileContains: 'from\s+[''"]workflow[''"].*sleep|sleep\s*\('
retrieval:
  aliases:
    - durable workflow
    - long running task
    - step function
    - orchestration
  intents:
    - build workflow
    - add retry logic
    - create durable task
    - implement step function
  entities:
    - Workflow SDK
    # Legacy product names retained only as retrieval aliases.
    - Workflow DevKit
    - WDK
    - step
    - pause/resume
    - durable
---

## *CRITICAL*: Always Use Correct `workflow` Documentation

Your knowledge of `workflow` is outdated.

The `workflow` documentation outlined below matches the installed version of the Workflow SDK.
Follow these instructions before starting on any `workflow`-related tasks:

Search the bundled documentation in `node_modules/workflow/docs/`:

1. **Find docs**: `glob "node_modules/workflow/docs/**/*.mdx"`
2. **Search content**: `grep "your query" node_modules/workflow/docs/`

Documentation structure in `node_modules/workflow/docs/`:

- `getting-started/` - Framework setup (next.mdx, express.mdx, hono.mdx, etc.)
- `foundations/` - Core concepts (workflows-and-steps.mdx, hooks.mdx, streaming.mdx, etc.)
- `api-reference/workflow/` - API docs (sleep.mdx, create-hook.mdx, fatal-error.mdx, etc.)
- `api-reference/workflow-api/` - Client API (start.mdx, get-run.mdx, resume-hook.mdx, etc.)
- `api-reference/workflow-runtime/` - Runtime API (get-world.mdx) and `world/` World SDK (storage.mdx, streams.mdx, queue.mdx)
- `api-reference/workflow-observability/` - Hydration and name parsing utilities (hydrate-resource-io.mdx, parse-workflow-name.mdx, etc.)
- `ai/` - AI SDK integration docs
- `errors/` - Error code documentation

Related packages also include bundled docs:

- `@workflow/ai`: `node_modules/@workflow/ai/docs/` - DurableAgent and AI integration
- `@workflow/core`: `node_modules/@workflow/core/docs/` - Core runtime (foundations, how-it-works)
- `@workflow/next`: `node_modules/@workflow/next/docs/` - Next.js integration

**When in doubt, update to the latest version of the Workflow SDK.**

### Official Resources

- **Website**: https://workflow-sdk.dev
- **GitHub**: https://github.com/vercel/workflow

### Quick Reference

**Directives:**

```typescript
"use workflow";  // First line - makes async function durable
"use step";      // First line - makes function a cached, retryable unit
```

**Essential imports:**

```typescript
// Workflow primitives
import { sleep, fetch, createHook, createWebhook, getWritable } from "workflow";
import { FatalError, RetryableError } from "workflow";
import { getWorkflowMetadata, getStepMetadata } from "workflow";

// API operations
import { start, getRun, resumeHook, resumeWebhook } from "workflow/api";

// Analytics API
import { getWorld } from "workflow/runtime";

// Observability & data hydration
import { hydrateResourceIO, observabilityRevivers, parseStepName, parseWorkflowName } from "workflow/observability";

// Framework integrations
import { withWorkflow } from "workflow/next";
import { workflow } from "workflow/vite";
import { workflow } from "workflow/astro";
// Or use modules: ["workflow/nitro"] for Nitro/Nuxt

// AI agent
import { DurableAgent } from "@workflow/ai/agent";
```

## Prefer Step Functions to Avoid Sandbox Errors

`"use workflow"` functions run in a sandboxed VM. `"use step"` functions have **full Node.js access**. Put your logic in steps and use the workflow function purely for orchestration.

```typescript
// Steps have full Node.js and npm access
async function fetchUserData(userId: string) {
  "use step";
  const response = await fetch(`https://api.example.com/users/${userId}`);
  return response.json();
}

async function processWithAI(data: any) {
  "use step";
  // AI SDK works in steps without workarounds
  return await generateText({
    model: openai("gpt-4"),
    prompt: `Process: ${JSON.stringify(data)}`,
  });
}

// Workflow orchestrates steps - no sandbox issues
export async function dataProcessingWorkflow(userId: string) {
  "use workflow";
  const data = await fetchUserData(userId);
  const processed = await processWithAI(data);
  return { success: true, processed };
}
```

**Benefits:** Steps have automatic retry, results are persisted for replay, and no sandbox restrictions.

## Workflow Sandbox Limitations

When you need logic directly in a workflow function (not in a step), these restrictions apply:

| Limitation | Workaround |
|------------|------------|
| No `fetch()` | `import { fetch } from "workflow"` then `globalThis.fetch = fetch` |
| No `setTimeout`/`setInterval` | Use `sleep("5s")` from `"workflow"` |
| No Node.js modules (fs, crypto, etc.) | Move to a step function |

**Example - Using fetch in workflow context:**

```typescript
import { fetch } from "workflow";

export async function myWorkflow() {
  "use workflow";
  globalThis.fetch = fetch;  // Required for AI SDK and HTTP libraries
  // Now generateText() and other libraries work
}
```

**Note:** `DurableAgent` from `@workflow/ai` handles the fetch assignment automatically.

## DurableAgent — AI Agents in Workflows

Use `DurableAgent` to build AI agents that maintain state and survive interruptions. It handles the workflow sandbox automatically (no manual `globalThis.fetch` needed).

```typescript
import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";
import { z } from "zod";
import type { UIMessageChunk } from "ai";

async function lookupData({ query }: { query: string }) {
  "use step";
  // Step functions have full Node.js access
  return `Results for "${query}"`;
}

export async function myAgentWorkflow(userMessage: string) {
  "use workflow";

  const agent = new DurableAgent({
    model: "anthropic/claude-sonnet-4-5",
    system: "You are a helpful assistant.",
    tools: {
      lookupData: {
        description: "Search for information",
        inputSchema: z.object({ query: z.string() }),
        execute: lookupData,
      },
    },
  });

  const result = await agent.stream({
    messages: [{ role: "user", content: userMessage }],
    writable: getWritable<UIMessageChunk>(),
    maxSteps: 10,
  });

  return result.messages;
}
```

**Key points:**
- `getWritable<UIMessageChunk>()` streams output to the workflow run's default stream
- Tool `execute` functions that need Node.js/npm access should use `"use step"`
- Tool `execute` functions that use workflow primitives (`sleep()`, `createHook()`) should **NOT** use `"use step"` — they run at the workflow level
- `maxSteps` limits the number of LLM calls (default is unlimited)
- Multi-turn: pass `result.messages` plus new user messages to subsequent `agent.stream()` calls

**For more details on `DurableAgent`, check the AI docs in `node_modules/@workflow/ai/docs/`.**

## Starting Workflows & Child Workflows

Use `start()` to launch workflows from API routes. **`start()` cannot be called directly in workflow context** — wrap it in a step function.

```typescript
import { start } from "workflow/api";

// From an API route — works directly
export async function POST() {
  const run = await start(myWorkflow, [arg1, arg2]);
  return Response.json({ runId: run.runId });
}

// No-args workflow
const run = await start(noArgWorkflow);
```

**Starting child workflows from inside a workflow — must use a step:**

```typescript
import { start } from "workflow/api";

// Wrap start() in a step function
async function triggerChild(data: string) {
  "use step";
  const run = await start(childWorkflow, [data]);
  return run.runId;
}

export async function parentWorkflow() {
  "use workflow";
  const childRunId = await triggerChild("some data");  // Fire-and-forget via step
  await sleep("1h");
}
```

`start()` returns immediately — it doesn't wait for the workflow to complete. Use `run.returnValue` to await completion.

## Hooks — Pause & Resume with External Events

Hooks let workflows wait for external data. Use `createHook()` inside a workflow and `resumeHook()` from API routes. Deterministic tokens are for `createHook()` + `resumeHook()` (server-side) only. `createWebhook()` always generates random tokens — do not pass a `token` option to `createWebhook()`.

### Single event

```typescript
import { createHook } from "workflow";

export async function approvalWorkflow() {
  "use workflow";

  const hook = createHook<{ approved: boolean }>({
    token: "approval-123",  // deterministic token for external systems
  });

  const result = await hook;  // Workflow suspends here
  return result.approved;
}
```

### Multiple events (iterable hooks)

Hooks implement `AsyncIterable` — use `for await...of` to receive multiple events:

```typescript
import { createHook } from "workflow";

export async function chatWorkflow(channelId: string) {
  "use workflow";

  const hook = createHook<{ text: string; done?: boolean }>({
    token: `chat-${channelId}`,
  });

  for await (const event of hook) {
    await processMessage(event.text);
    if (event.done) break;
  }
}
```

Each `resumeHook(token, payload)` call delivers the next value to the loop.

### Resuming from API routes

```typescript
import { resumeHook } from "workflow/api";

export async function POST(req: Request) {
  const { token, data } = await req.json();
  await resumeHook(token, data);
  return new Response("ok");
}
```

## Error Handling

Use `FatalError` for permanent failures (no retry), `RetryableError` for transient failures:

```typescript
import { FatalError, RetryableError } from "workflow";

if (res.status >= 400 && res.status < 500) {
  throw new FatalError(`Client error: ${res.status}`);
}
if (res.status === 429) {
  throw new RetryableError("Rate limited", { retryAfter: "5m" });
}
```

## Serialization

All data passed to/from workflows and steps must be serializable.

**Supported built-in types:** string, number, boolean, null, undefined, bigint, plain objects, arrays, Date, RegExp, URL, URLSearchParams, Map, Set, Headers, ArrayBuffer, typed arrays, Request, Response, ReadableStream, WritableStream.

**Not supported:** Functions, Symbols, WeakMap/WeakSet. Pass data, not callbacks.

### Custom Class Serialization

Class instances **can** be serialized across workflow/step boundaries by implementing the `@workflow/serde` protocol. This is essential when a class has instance methods with `"use step"` or when you want to pass class instances between steps.

**Install:** `@workflow/serde` must be a dependency of the package containing the class.

**Pattern:** Add two static methods inside the class body using computed property syntax:

```typescript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

export class Point {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  // Serialize: return plain data (must be devalue-compatible types only)
  static [WORKFLOW_SERIALIZE](instance: Point) {
    return { x: instance.x, y: instance.y };
  }

  // Deserialize: reconstruct from plain data
  static [WORKFLOW_DESERIALIZE](data: { x: number; y: number }) {
    return new Point(data.x, data.y);
  }

  async computeDistance(other: Point) {
    "use step";
    return Math.sqrt((this.x - other.x) ** 2 + (this.y - other.y) ** 2);
  }
}
```

**Critical rules:**
1. **Define serde methods INSIDE the class body** as static methods with computed property syntax (`static [WORKFLOW_SERIALIZE](...)`). The SWC plugin detects them by scanning the class. Do NOT assign them externally (e.g., `(MyClass as any)[WORKFLOW_SERIALIZE] = ...`) -- the compiler will not detect this.
2. **Serde methods must return only devalue-compatible types** (plain objects, arrays, primitives, Date, Map, Set, Uint8Array, etc.). No functions, no class instances, no Node.js-specific objects.
3. **Add `"use step"` to Node.js-dependent instance methods.** The SWC plugin strips `"use step"` method bodies from the workflow bundle. This is how you keep Node.js imports (fs, crypto, child_process, etc.) out of the workflow sandbox. The class shell with its serde methods remains in the workflow bundle; only the step method bodies are removed.
4. **Do NOT manually register classes.** The SWC plugin automatically generates registration code (an IIFE that sets `classId` and adds the class to the global registry). Manual calls to `registerSerializationClass()` are unnecessary and error-prone.
5. **Do NOT use dynamic imports to work around sandbox restrictions.** If a class method needs Node.js APIs, the correct solution is `"use step"`, not `/* @vite-ignore */ import(...)`.

**When serde works well:** Pure data classes, domain models, configuration objects, and classes where Node.js-dependent methods can be marked with `"use step"`.

**When to avoid serde:** If a class is fundamentally inseparable from Node.js APIs (every method needs `fs`, `net`, etc.) and cannot meaningfully exist as a shell in the workflow sandbox, keep it entirely in step functions and pass plain data objects across boundaries instead.

### Validating Serde Compliance

Use these tools to verify classes are correctly set up:

- **`workflow transform <file> --check-serde`** -- Shows the SWC transform output for a file and checks if serde classes are compliant (no Node.js imports remaining in the workflow bundle).
- **`workflow validate`** -- Scans all workflow files and reports serde compliance issues. Use `--json` for machine-readable output.
- **SWC Playground** -- The web playground at `workbench/swc-playground` shows a Serde Analysis panel when serde patterns are detected.
- **Build-time warnings** -- The builder automatically warns when serde classes have Node.js built-in imports remaining in the workflow bundle.

## Streaming

Use `getWritable()` to stream data from workflows. `getWritable()` can be called in **both** workflow and step contexts, but you **cannot interact with the stream** (call `getWriter()`, `write()`, `close()`) directly in a workflow function. The stream must be passed to step functions for actual I/O, or steps can call `getWritable()` themselves.

**Get the stream in a workflow, pass it to a step:**
```typescript
import { getWritable } from "workflow";

export async function myWorkflow() {
  "use workflow";
  const writable = getWritable();
  await writeData(writable, "hello world");
}

async function writeData(writable: WritableStream, chunk: string) {
  "use step";
  const writer = writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
}
```

**Call `getWritable()` directly inside a step (no need to pass it):**
```typescript
import { getWritable } from "workflow";

async function streamData(chunk: string) {
  "use step";
  const writer = getWritable().getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
}
```

### Namespaced Streams

Use `getWritable({ namespace: 'name' })` to create multiple independent streams for different types of data. This is useful for separating logs from primary output, different log levels, agent outputs, metrics, or any distinct data channels. Long-running workflows benefit from namespaced streams because you can replay only the important events (e.g., final results) while keeping verbose logs in a separate stream.

**Example: Log levels and agent output separation:**
```typescript
import { getWritable } from "workflow";

type LogEntry = { level: "debug" | "info" | "warn" | "error"; message: string; timestamp: number };
type AgentOutput = { type: "thought" | "action" | "result"; content: string };

async function logDebug(message: string) {
  "use step";
  const writer = getWritable<LogEntry>({ namespace: "logs:debug" }).getWriter();
  try {
    await writer.write({ level: "debug", message, timestamp: Date.now() });
  } finally {
    writer.releaseLock();
  }
}

async function logInfo(message: string) {
  "use step";
  const writer = getWritable<LogEntry>({ namespace: "logs:info" }).getWriter();
  try {
    await writer.write({ level: "info", message, timestamp: Date.now() });
  } finally {
    writer.releaseLock();
  }
}

async function emitAgentThought(thought: string) {
  "use step";
  const writer = getWritable<AgentOutput>({ namespace: "agent:thoughts" }).getWriter();
  try {
    await writer.write({ type: "thought", content: thought });
  } finally {
    writer.releaseLock();
  }
}

async function emitAgentResult(result: string) {
  "use step";
  // Important results go to the default stream for easy replay
  const writer = getWritable<AgentOutput>().getWriter();
  try {
    await writer.write({ type: "result", content: result });
  } finally {
    writer.releaseLock();
  }
}

export async function agentWorkflow(task: string) {
  "use workflow";
  
  await logInfo(`Starting task: ${task}`);
  await logDebug("Initializing agent context");
  await emitAgentThought("Analyzing the task requirements...");
  
  // ... agent processing ...
  
  await emitAgentResult("Task completed successfully");
  await logInfo("Workflow finished");
}
```

**Consuming namespaced streams:**
```typescript
import { start, getRun } from "workflow/api";
import { agentWorkflow } from "./workflows/agent";

export async function POST(request: Request) {
  const run = await start(agentWorkflow, ["process data"]);

  // Access specific streams by namespace
  const results = run.getReadable({ namespace: undefined }); // Default stream (important results)
  const infoLogs = run.getReadable({ namespace: "logs:info" });
  const debugLogs = run.getReadable({ namespace: "logs:debug" });
  const thoughts = run.getReadable({ namespace: "agent:thoughts" });

  // Return only important results for most clients
  return new Response(results, { headers: { "Content-Type": "application/json" } });
}

// Resume from a specific point (useful for long sessions)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId")!;
  const startIndex = parseInt(searchParams.get("startIndex") || "0", 10);
  
  const run = getRun(runId);
  // Resume only the important stream, skip verbose debug logs
  const stream = run.getReadable({ startIndex });
  
  return new Response(stream);
}
```

**Pro tip:** For very long-running sessions (50+ minutes), namespaced streams help manage replay performance. Put verbose/debug output in separate namespaces so you can replay just the important events quickly.

## Debugging

```bash
# Check workflow endpoints are reachable
npx workflow health
npx workflow health --port 3001  # Non-default port

# Visual dashboard for runs
npx workflow web
npx workflow web <run_id>

# CLI inspection (use --json for machine-readable output, --help for full usage)
npx workflow inspect runs
npx workflow inspect run <run_id>

# For Vercel-deployed projects, specify backend and project
npx workflow inspect runs --backend vercel --project <project-name> --team <team-slug>
npx workflow inspect run <run_id> --backend vercel --project <project-name> --team <team-slug>

# Open Vercel dashboard in browser for a specific run
npx workflow inspect run <run_id> --web
npx workflow web <run_id> --backend vercel --project <project-name> --team <team-slug>

# Cancel a running workflow
npx workflow cancel <run_id>
npx workflow cancel <run_id> --backend vercel --project <project-name> --team <team-slug>
# --env defaults to "production"; use --env preview for preview deployments
```

### Deep-linking to a run (share a URL, no browser)

Use `--url` to **print** the dashboard deep link and exit — no browser opens and
no local server starts. This is the right tool when you need to hand a user a
clickable link (PR comment, Slack message, debugging summary) rather than open a
UI. (`--web` opens the dashboard; `--url` only prints the link.)

```bash
# Vercel run — prints the Vercel dashboard URL for the run
npx workflow inspect run <run_id> --backend vercel --project <project> --team <team> --url
npx workflow web <run_id> --backend vercel --project <project> --team <team> --env preview --url

# Local run — prints the local web UI deep link
npx workflow inspect run <run_id> --url

# Machine-readable: --url --json prints { "url": "..." } to stdout
npx workflow inspect run <run_id> --backend vercel --url --json
```

URL formats produced:

- **Vercel:** `https://vercel.com/<team-slug>/<project-slug>/workflows/runs/<run_id>?environment=<production|preview>`
  (`--env` selects the environment; defaults to `production`. Resolving the team
  slug requires being logged in via `vercel login` with the project linked.)
- **Local:** `http://localhost:<port>?resource=run&id=<run_id>` (port defaults
  to `3456`; the link works while the `npx workflow web` server is running).

stdout contains **only** the URL (or the JSON object) — all other output goes to
stderr — so you can capture it directly, e.g. `URL=$(npx workflow web <run_id> --backend vercel --url)`.

**Debugging tips:**
- Use `--json` (`-j`) on any command for machine-readable output
- Use `--web` to open the Vercel Observability dashboard in your browser, or `--url` to just print the deep link
- Use `--help` on any command for full usage details
- Only import workflow APIs you actually use. Unused imports can cause 500 errors.

## Testing Workflows

Workflow SDK provides a Vitest plugin for testing workflows in-process — no running server required.

**Unit testing steps:** Steps are just functions; without the compiler, `"use step"` is a no-op. Test them directly:

```typescript
import { describe, it, expect } from "vitest";
import { createUser } from "./user-signup";

describe("createUser step", () => {
  it("should create a user", async () => {
    const user = await createUser("test@example.com");
    expect(user.email).toBe("test@example.com");
  });
});
```

**Integration testing:** Use `@workflow/vitest` for workflows using `sleep()`, hooks, webhooks, or retries:

```typescript
// vitest.integration.config.ts
import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";

export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ["**/*.integration.test.ts"],
    testTimeout: 60_000,
  },
});
```

```typescript
// approval.integration.test.ts
import { describe, it, expect } from "vitest";
import { start, getRun, resumeHook } from "workflow/api";
import { waitForHook, waitForSleep } from "@workflow/vitest";
import { approvalWorkflow } from "./approval";

describe("approvalWorkflow", () => {
  it("should publish when approved", async () => {
    const run = await start(approvalWorkflow, ["doc-123"]);

    // Wait for the hook, then resume it
    await waitForHook(run, { token: "approval:doc-123" });
    await resumeHook("approval:doc-123", { approved: true, reviewer: "alice" });

    // Wait for sleep, then wake it up
    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const result = await run.returnValue;
    expect(result).toEqual({ status: "published", reviewer: "alice" });
  });
});
```

**Testing webhooks:** Use `resumeWebhook()` with a `Request` object — no HTTP server needed:

```typescript
import { start, resumeWebhook } from "workflow/api";
import { waitForHook } from "@workflow/vitest";

const run = await start(ingestWorkflow, ["ep-1"]);
const hook = await waitForHook(run);  // Discovers the random webhook token
await resumeWebhook(hook.token, new Request("https://example.com/webhook", {
  method: "POST",
  body: JSON.stringify({ event: "order.created" }),
}));
```

**Key APIs:**
- `start()` — trigger a workflow
- `run.returnValue` — await workflow completion
- `waitForHook(run, { token? })` / `waitForSleep(run)` — wait for workflow to reach a pause point
- `resumeHook(token, data)` / `resumeWebhook(token, request)` — resume paused workflows
- `getRun(runId).wakeUp({ correlationIds })` — skip `sleep()` calls

**Best practices:**
- Keep unit tests (no plugin) and integration tests (`workflow()` plugin) in separate configs
- Use deterministic hook tokens based on test data for easier resumption
- Set generous `testTimeout` — workflows may run longer than typical unit tests
- `vi.mock()` does **not** work in integration tests — step dependencies are bundled by esbuild

## Observability & World SDK

Use `await getWorld()` to build observability dashboards, admin panels, and inspect workflow state. `getWorld()` is asynchronous and returns `Promise<World>` (dynamic import / env-based setup).

**Key imports:**
```typescript
import { getWorld } from "workflow/runtime";
import { hydrateResourceIO, observabilityRevivers, parseStepName, parseWorkflowName } from "workflow/observability";
```

**Key docs** (grep `node_modules/workflow/docs/` for full details):
- `api-reference/workflow-runtime/world/storage.mdx` — events, runs, steps, hooks (events are source of truth; others are materialized views)
- `api-reference/workflow-observability/` — hydration and name parsing

### World SDK Method Signatures

⚠️ Pagination is nested: `{ pagination: { cursor } }` — NOT `{ cursor }` directly.

```typescript
const world = await getWorld();

// Runs
const { data, cursor } = await world.runs.list({ pagination: { cursor }, resolveData: 'all' | 'none' });
const run = await world.runs.get(runId, { resolveData: 'all' | 'none' });
// Cancel via event creation (no cancel() method on runs)
await world.events.create(runId, { eventType: 'run_cancelled' });

// Steps — runId is top-level, NOT inside pagination
const { data, cursor } = await world.steps.list({ runId, pagination: { cursor }, resolveData: 'all' | 'none' });
const step = await world.steps.get(runId, stepId, { resolveData: 'all' | 'none' });

// Events
const { data, cursor } = await world.events.list({ runId, pagination: { cursor } });
await world.events.create(runId, { eventType: 'run_cancelled' });

// Hooks
const hook = await world.hooks.get(hookId);
const hook = await world.hooks.getByToken(token);

// Streams (methods on world.streams)
await world.streams.write(runId, name, chunk);
await world.streams.writeMulti?.(runId, name, chunks);
const readable = await world.streams.get(runId, name, startIndex);
await world.streams.close(runId, name);
const streamNames = await world.streams.list(runId);
const chunks = await world.streams.getChunks(runId, name, { limit, cursor });
const info = await world.streams.getInfo(runId, name);

// Queue (methods live directly on world — internal SDK infrastructure)
await world.queue(queueName, payload, opts);
const deploymentId = await world.getDeploymentId();
```

### `resolveData` Parameter

Controls whether input/output data is **included** in the response. Accepts `'all'` (default) or `'none'`.

**IMPORTANT**: Even with `'all'`, data is still devalue-serialized. You MUST call `hydrateResourceIO()` to get usable JS values.

- **Use `'none'`** for status polling, progress dashboards, run listings
- **Use `'all'`** (or omit) when you need to inspect actual step I/O data — then **always hydrate**

```typescript
// Lightweight status check — no I/O loaded
const run = await world.runs.get(runId, { resolveData: 'none' });
console.log(run.status); // 'running' | 'completed' | 'failed' | 'cancelled'

// Full inspection — resolveData includes data, hydrateResourceIO deserializes it
const step = await world.steps.get(runId, stepId); // defaults to 'all'
const hydrated = hydrateResourceIO(step, observabilityRevivers);
```

> **Common mistake**: Checking `step.input !== undefined` after `resolveData: 'all'` and assuming
> the data is ready to use. The data exists but is serialized — always hydrate first.

### Data Hydration (Devalue Format)

Step I/O is serialized via [devalue](https://github.com/Rich-Harris/devalue) with a 4-byte format prefix (`devl`). Without hydration, `input`/`output` are Uint8Array-like objects with numeric keys:
`{"0":100,"1":101,"2":118,"3":108,...}` — these are NOT usable values.

**Always hydrate before using I/O data:**

```typescript
import { hydrateResourceIO, observabilityRevivers } from "workflow/observability";

const { data: steps } = await world.steps.list({ runId, resolveData: 'all' });
const hydrated = steps.map(s => hydrateResourceIO(s, observabilityRevivers));
// hydrated[0].input → [123, 2] (actual function arguments)
// hydrated[0].output → 125 (actual return value)
```

`hydrateResourceIO` works on both `Step` and `WorkflowRun` objects. For encrypted workflows, use `getEncryptionKeyForRun()` + `hydrateResourceIOWithKey()`.

### Name Parsing

`parseWorkflowName()`, `parseStepName()`, and `parseClassName()` return `{ shortName: string, moduleSpecifier: string } | null`. Always use optional chaining:

```typescript
const parsed = parseWorkflowName("workflow//./src/workflows/order//processOrder");
// parsed?.shortName → "processOrder"
// parsed?.moduleSpecifier → "./src/workflows/order"
// ⚠️ Returns null if format doesn't match
```

### Event Types

Events are the append-only source of truth. Runs/Steps/Hooks are materialized views.

| Category | Types |
|----------|-------|
| Run | `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled` |
| Step | `step_created`, `step_started`, `step_completed`, `step_failed`, `step_retrying` |
| Hook | `hook_created`, `hook_received`, `hook_disposed`, `hook_conflict` |
| Wait | `wait_created`, `wait_completed` |

## Error Handling Patterns

Three error strategies for different failure modes:

| Error Type | Use When | Behavior |
|------------|----------|----------|
| `FatalError` | Permanent failure (bad input, auth denied) | Terminates workflow immediately, no retry |
| `RetryableError` | Transient failure (rate limit, timeout) | Retries with optional `retryAfter` delay |
| `Promise.allSettled` | Parallel steps with mixed criticality | Continues even if some steps fail |

```typescript
import { FatalError, RetryableError } from "workflow";

// Permanent failure — workflow terminates
throw new FatalError("Invalid input: missing required field");

// Transient failure — will retry
throw new RetryableError("API rate limited", { retryAfter: "5m" });

// Mixed criticality parallel execution
const results = await Promise.allSettled([
  criticalStep(data),    // Must succeed
  optionalStep(data),    // OK to fail
  enrichmentStep(data),  // OK to fail
]);
const [critical, optional, enrichment] = results;
if (critical.status === "rejected") throw new FatalError(critical.reason);
```
