---
name: edge-runtime
description: Expert guidance for Vercel's Edge Runtime — the lightweight JavaScript runtime for Vercel Edge Functions and Middleware. Use when building or configuring edge functions, edge middleware, or working with the Edge Runtime API and its packages.
metadata:
  priority: 4
  pathPatterns:
    - 'edge-runtime.config.*'
    - 'middleware.ts'
    - 'middleware.js'
    - 'src/middleware.ts'
    - 'src/middleware.js'
  importPatterns:
    - 'edge-runtime'
    - '@edge-runtime/*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bedge-runtime\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bedge-runtime\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bedge-runtime\b'
    - '\byarn\s+add\s+[^\n]*\bedge-runtime\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@edge-runtime/'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@edge-runtime/'
    - '\bbun\s+(install|i|add)\s+[^\n]*@edge-runtime/'
    - '\byarn\s+add\s+[^\n]*@edge-runtime/'
  promptSignals:
    phrases:
      - 'edge runtime'
      - 'edge function'
      - 'run at the edge'
validate:
  -
    pattern: from\s+['"](node:)?fs['"]
    message: 'fs module is not available in Edge Runtime — use fetch or KV storage instead'
    severity: error
  -
    pattern: from\s+['"](node:)?child_process['"]
    message: 'child_process is not available in Edge Runtime'
    severity: error
  -
    pattern: from\s+['"](node:)?(net|dns)['"]
    message: 'Node.js net/dns modules are not available in Edge Runtime'
    severity: error
  -
    pattern: \brequire\s*\(
    message: 'require() is not available in Edge Runtime — use ESM import instead'
    severity: error
  -
    pattern: \beval\s*\(
    message: 'eval() is not allowed in Edge Runtime — refactor to avoid dynamic code evaluation'
    severity: error
  -
    pattern: new\s+Function\s*\(
    message: 'new Function() is not allowed in Edge Runtime — refactor to avoid dynamic code evaluation'
    severity: error
retrieval:
  aliases:
    - edge functions
    - edge middleware
    - lightweight runtime
    - edge computing
  intents:
    - run code at edge
    - create edge function
    - configure edge middleware
    - use edge runtime
  entities:
    - Edge Runtime
    - Edge Functions
    - middleware
    - EdgeFunction

---

# Edge Runtime — Vercel's Edge JavaScript Runtime

You are an expert in Vercel's Edge Runtime (v4.0+), the lightweight JavaScript runtime based on V8 isolates. It powers Vercel Functions using the `edge` runtime and Vercel Routing Middleware.

## Overview

The Edge Runtime is designed for:
- **Vercel Functions (edge runtime)** — functions that run on V8 isolates at the network edge
- **Vercel Routing Middleware** — intercept and transform requests before cache
- **Local development** — test edge behavior locally with the same runtime

**Important**: The standalone "Edge Functions" and "Edge Middleware" products are **deprecated** and unified under **Vercel Functions** (powered by Fluid Compute). Edge Middleware is now **Vercel Routing Middleware**. Edge Functions are now **Vercel Functions using the `edge` runtime**. Vercel recommends **migrating to the Node.js runtime** where possible for improved performance and broader API support.

**Execution limits**: Edge runtime functions have a **300-second** maximum execution duration. Streaming responses must begin within **25 seconds** to maintain streaming capabilities.

## Packages

| Package | Description |
|---|---|
| `edge-runtime` | Core runtime for local development and testing |
| `@edge-runtime/primitives` | Web API primitives (Request, Response, fetch, etc.) |
| `@edge-runtime/cookies` | Cookie parsing and serialization |
| `@edge-runtime/format` | Pretty-print Edge Runtime values |
| `@edge-runtime/vm` | VM-based Edge Runtime sandbox |

## Installation

```bash
npm install edge-runtime

# Individual packages
npm install @edge-runtime/cookies
npm install @edge-runtime/primitives
```

## Local Development with Edge Runtime

```ts
import { EdgeRuntime } from 'edge-runtime'

const runtime = new EdgeRuntime()

const result = await runtime.evaluate(`
  const response = new Response('Hello from the edge!')
  response.text()
`)

console.log(result) // "Hello from the edge!"
```

## Available Web APIs

The Edge Runtime provides a subset of standard Web APIs:

- **Fetch API**: `fetch`, `Request`, `Response`, `Headers`
- **Streams**: `ReadableStream`, `WritableStream`, `TransformStream`
- **Encoding**: `TextEncoder`, `TextDecoder`
- **URL**: `URL`, `URLSearchParams`, `URLPattern`
- **Crypto**: `crypto.subtle`, `crypto.getRandomValues`
- **Timers**: `setTimeout`, `setInterval` (limited)
- **Cache**: `CacheStorage`, `Cache`
- **Structured Clone**: `structuredClone`

## Routing Middleware Pattern (Next.js 15 and earlier)

In Next.js 16+, `middleware.ts` is renamed to `proxy.ts` and runs on Node.js (not Edge). For Next.js 15 and earlier, or for Vercel Routing Middleware (non-Next.js):

```ts
// middleware.ts
import { NextRequest, NextResponse } from 'next/server'

export const config = {
  matcher: ['/api/:path*', '/dashboard/:path*'],
}

export default function middleware(request: NextRequest) {
  // Check auth
  const token = request.cookies.get('session')
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Add headers
  const response = NextResponse.next()
  response.headers.set('x-edge-powered', 'true')
  return response
}
```

## Edge Function Pattern (Next.js)

```ts
// app/api/hello/route.ts
export const runtime = 'edge'

export async function GET(request: Request) {
  return new Response(JSON.stringify({ hello: 'world' }), {
    headers: { 'content-type': 'application/json' },
  })
}
```

## @edge-runtime/cookies

```ts
import { ResponseCookies, RequestCookies } from '@edge-runtime/cookies'

// Parse request cookies
const cookies = new RequestCookies(request.headers)
const session = cookies.get('session')

// Set response cookies
const responseCookies = new ResponseCookies(response.headers)
responseCookies.set('theme', 'dark', {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 7, // 1 week
})
```

## Limitations

The Edge Runtime does **not** support:
- Node.js built-in modules (`fs`, `path`, `child_process`, etc.)
- Native/binary modules
- `eval()` and `new Function()` (security restriction)
- Long-running processes (execution time limits apply)
- Full Node.js `Buffer` (use `Uint8Array` instead)

## Key Points

1. **Web Standards first** — uses standard Web APIs, not Node.js APIs
2. **Cold start < 1ms** — no VM boot overhead at the edge (9x faster than traditional serverless)
3. **Size limits** — edge functions have a 1-4 MB size limit (varies by platform)
4. **No file system** — use fetch, KV, or external storage instead
5. **Streaming supported** — use `ReadableStream` for streaming responses (300s max duration, 25s to first byte)
6. **`export const runtime = 'edge'`** — opt into Edge Runtime in Next.js route handlers
7. **Migration recommended** — Vercel recommends Node.js runtime for most use cases; edge runtime is best only when ultra-low latency at the edge is critical

## Official Resources

- [Edge Runtime GitHub](https://github.com/vercel/edge-runtime)
- [Vercel Edge Functions Docs](https://vercel.com/docs/functions/edge-functions)
- [Next.js Edge Runtime](https://nextjs.org/docs/app/api-reference/edge)
