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
