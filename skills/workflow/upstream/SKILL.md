---
name: workflow
description: Build or debug durable execution, steps, hooks, and streaming with Vercel Workflow.
metadata:
  author: Vercel Inc.
  version: '1.10'
---

# Vercel Workflow

Use the installed package documentation for API and version-specific details.
Search the relevant area of `node_modules/workflow/docs/` rather than loading the
whole manual. Related packages such as `@workflow/ai` and `@workflow/core` also
ship documentation. A documentation question does not require an SDK upgrade.
Upgrade dependencies only when the requested work requires it and it is authorized.

## Load by task

| Task | Reference |
| --- | --- |
| Imports and framework entry points | [API quick reference](references/api-quick-reference.md) |
| Step boundaries, sandbox errors, DurableAgent, or starting runs | [Steps and agents](references/steps-and-agents.md) |
| External events, retries, errors, or serializable values | [Hooks and serialization](references/hooks-and-serialization.md) |
| Streams, consumers, or resumable output | [Streaming](references/streaming.md) |
| Inspecting failures, run links, or verification | [Debugging and testing](references/debugging-and-testing.md) |
| Storage, streams, hydration, or low-level run data | [World SDK](references/world-sdk.md) |

Keep side effects and non-deterministic work in step functions. Preserve workflow
sandbox and serialization constraints. Use the reference for the actual operation;
do not load every example before a small edit. Check the target environment before
running CLI operations that can affect a deployed workflow.

Implement the requested behavior and run affected checks. Use existing evidence
when still valid. Report any verification that could not be completed. A passing
local test does not prove a deployed workflow succeeded.

Official resources: [Workflow documentation](https://workflow-sdk.dev) and
[Workflow source](https://github.com/vercel/workflow).
