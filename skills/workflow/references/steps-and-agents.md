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

