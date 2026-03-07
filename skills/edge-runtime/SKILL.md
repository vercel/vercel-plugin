---
name: edge-runtime
description: Expert guidance for Vercel's Edge Runtime — the lightweight JavaScript runtime for Vercel Edge Functions and Middleware. Use when building or configuring edge functions, edge middleware, or working with the Edge Runtime API and its packages.
metadata:
  priority: 4
  pathPatterns:
    - 'edge-runtime.config.*'
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
---

# Edge Runtime — Vercel's Edge JavaScript Runtime

You are an expert in Vercel's Edge Runtime, the lightweight JavaScript runtime that powers Vercel Edge Functions and Middleware. It provides a subset of Web APIs optimized for low-latency execution at the edge.

## Overview

The Edge Runtime is designed for:
- **Edge Functions** — serverless functions that run at the network edge
- **Middleware** — intercept and transform requests before they reach your application
- **Local development** — test edge behavior locally with the same runtime

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

## Edge Middleware Pattern (Next.js)

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
2. **Cold start < 1ms** — no VM boot overhead at the edge
3. **Size limits** — edge functions have a 1-4 MB size limit (varies by platform)
4. **No file system** — use fetch, KV, or external storage instead
5. **Streaming supported** — use `ReadableStream` for streaming responses
6. **`export const runtime = 'edge'`** — opt into Edge Runtime in Next.js route handlers

## Official Resources

- [Edge Runtime GitHub](https://github.com/vercel/edge-runtime)
- [Vercel Edge Functions Docs](https://vercel.com/docs/functions/edge-functions)
- [Next.js Edge Runtime](https://nextjs.org/docs/app/api-reference/edge)
