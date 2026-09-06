# API quick reference

Use only the imports needed for the task. Confirm signatures against the installed package documentation.

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

