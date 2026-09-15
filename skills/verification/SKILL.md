---
name: verification
description: "Verify a requested user flow across its relevant browser, API, and data boundaries, including rechecking an authorized repair."
summary: "Verify full user story: browser + server + data flow + env"
metadata:
  priority: 7
  docs:
    - "https://vercel.com/docs/projects/project-configuration"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns: []
  bashPatterns:
    - '\bnext\s+dev\b'
    - '\bnpm\s+run\s+dev\b'
    - '\bpnpm\s+dev\b'
    - '\bbun\s+run\s+dev\b'
    - '\byarn\s+dev\b'
    - '\bvite\s*(dev)?\b'
    - '\bvercel\s+dev\b'
    - '\bastro\s+dev\b'
  importPatterns: []
  promptSignals:
    phrases:
      - "verify the flow"
      - "verify everything works"
      - "test the whole thing"
      - "does it actually work"
      - "check end to end"
      - "end to end test"
      - "why isn't it working right"
      - "why doesn't it work"
      - "it's not working correctly"
      - "something's off"
      - "not quite right"
      - "almost works but"
      - "works locally but"
      - "verify the feature"
      - "make sure it works"
      - "full verification"
    allOf:
      - [verify, flow]
      - [verify, works]
      - [check, everything]
      - [test, end, end]
      - [not, working, right]
      - [something, off]
      - [almost, works]
      - [make, sure, works]
    anyOf:
      - "verify"
      - "verification"
      - "end-to-end"
      - "full flow"
      - "works"
      - "working"
    noneOf:
      - "unit test"
      - "jest"
      - "vitest"
      - "playwright test"
      - "cypress test"
    minScore: 6
retrieval:
  aliases:
    - end to end test
    - full stack verify
    - flow test
    - integration check
  intents:
    - verify full flow
    - test end to end
    - check if app works
    - validate implementation
  entities:
    - browser
    - API
    - data flow
    - end-to-end
    - verification
chainTo:
  -
    pattern: 'process\.env\.\w+|NEXT_PUBLIC_\w+'
    targetSkill: env-vars
    message: 'Environment variable references detected during verification — loading Env Vars guidance for proper configuration, vercel env pull, and branch scoping.'
    skipIfFileContains: 'vercel\s+env\s+pull|\.env\.local'
  -
    pattern: 'middleware\.(ts|js)|proxy\.(ts|js)|clerkMiddleware|NextResponse\.redirect'
    targetSkill: routing-middleware
    message: 'Middleware/proxy detected during verification — loading Routing Middleware guidance for request interception, auth checks, and proxy.ts migration.'
  -
    pattern: 'streamText\s*\(|generateText\s*\(|useChat\s*\('
    targetSkill: ai-sdk
    message: 'AI SDK calls detected during verification — loading AI SDK v6 guidance for streaming, transport, and error handling patterns.'
    skipIfFileContains: 'toUIMessageStreamResponse|DefaultChatTransport'

---

# Full-Story Verification

You are a verification orchestrator. Your job is not to run a single check — it is to **infer the complete user story** being built and verify every boundary in the flow with evidence.

Your focus is the **end-to-end story**, not any single layer.

## When This Triggers

- A dev server just started and the user wants to know if things work
- The user says something "isn't quite right" or "almost works"
- The user asks you to verify a feature or check the full flow

## Step 1 — Infer the User Story

Before checking anything, determine **what is being built**:

1. Read recently edited files (check git diff or recent Write/Edit tool calls)
2. Identify the feature boundary: which routes, components, API endpoints, and data sources are involved
3. Scan `package.json` scripts, route structure (`app/` or `pages/`), and environment files (`.env*`)
4. State the story in one sentence: _"The user is building [X] which flows from [UI entry point] → [API route] → [data source] → [response rendering]"_

**Do not skip this step.** Every subsequent check must be anchored to the inferred story.

## Step 2 — Establish Evidence Baseline

Gather the current state across all layers:

| Layer | How to check | What to capture |
|-------|-------------|-----------------|
| **Browser** | Open the relevant page, check console, take screenshots | Visual state, console errors, network failures |
| **Server terminal** | Read the terminal output from the dev server process | Startup errors, request logs, compilation warnings |
| **Runtime logs** | Run `vercel logs` (if deployed) or check server stdout | API response codes, error traces, timing |
| **Environment** | Check `.env.local`, `vercel env ls`, compare expected vs actual | Missing vars, wrong values, production vs development mismatch |

Report what you find at each layer before proceeding. Use this reporting contract:

> **Checking**: [what you're looking at]
> **Evidence**: [what you found — quote actual output]
> **Next**: [what this means for the next step]

## Step 3 — Walk the Data Flow

Trace the feature's data path from trigger to completion:

1. **UI trigger** — What user action initiates the flow? (button click, page load, form submit)
2. **Client → Server** — What request is made? Check the fetch/action call, verify the URL, method, and payload match the API route
3. **API route handler** — Read the route file. Does it handle the method? Does it validate input? Does it call the right service/database?
4. **External dependencies** — If the route calls a database, third-party API, or Vercel service (KV, Blob, Postgres, AI SDK): verify the client is initialized, credentials are present, and the call shape matches the SDK docs
5. **Response → UI** — Does the response format match what the client expects? Is error handling present on both sides?

At each boundary, check for these common breaks:
- **Missing `await`** on async operations
- **Wrong HTTP method** (GET handler but POST fetch)
- **Env var absent** in runtime but present in `.env.local`
- **Import mismatch** (server module imported in client component or vice versa)
- **Type mismatch** between API response and client expectation
- **Missing error boundary** — unhandled rejection crashes the page silently

## Step 4 — Report With Evidence

Summarize findings in a structured report:

```
## Verification Report: [Feature Name]

**Story**: [one-sentence description of the user story]

### Flow Status
| Boundary | Status | Evidence |
|----------|--------|----------|
| UI renders | ✅/❌ | [screenshot or console output] |
| Client → API | ✅/❌ | [request/response or error] |
| API → Data | ✅/❌ | [log output or error trace] |
| Data → Response | ✅/❌ | [response shape or error] |
| Response → UI | ✅/❌ | [rendered output or error] |

### Issues Found
1. [Issue]: [evidence] → [fix]

### Verified Working
- [What was confirmed working with evidence]
```

## Scope

A dev server starting or a generic troubleshooting signal does not expand the user's requested scope. Choose the relevant boundaries and authorized environment before testing.

## Completion and blocked boundaries

Keep verification scoped to the requested story and authorized environment.

- When every relevant boundary has evidence, report success and identify any layers that were not exercised.
- At a broken boundary, capture the failure and its likely cause. For an audit-only request, report findings without changing code. For an authorized fix-and-verify request, repair the boundary, recheck it, and resume the remaining flow checks.
- If a layer provides no useful signal, choose another proportionate check or improve observability when that is in scope. Report a blocker when a needed dependency, credential, environment, or decision has no safe authorized alternative.
- Repeat a check after a relevant change or when it resolves an uncertainty. Do not repeat an unchanged check that provides no new evidence.
- Keep unrelated features and cosmetic work outside the verification scope unless requested.

## Verification after implementation

Complete proportionate checks as part of the requested implementation. Do not defer already-authorized verification to another user prompt. Additional hosted mutations or tests in another environment require their own authorization; report any such untested layer clearly.
