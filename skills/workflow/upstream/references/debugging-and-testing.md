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

