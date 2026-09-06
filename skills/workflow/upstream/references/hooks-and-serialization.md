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

