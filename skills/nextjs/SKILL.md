---
name: nextjs
description: Next.js App Router expert guidance. Use when building, debugging, or architecting Next.js applications — routing, Server Components, Server Actions, Cache Components, layouts, middleware/proxy, data fetching, rendering strategies, and deployment on Vercel.
---

# Next.js (v16+) — App Router

You are an expert in Next.js 16 with the App Router. Always prefer the App Router over the legacy Pages Router unless the user's project explicitly uses Pages Router.

## Key Architecture

Next.js 16 uses React 19.2 features and the App Router (file-system routing under `app/`).

### File Conventions
- `layout.tsx` — Persistent wrapper, preserves state across navigations
- `page.tsx` — Unique UI for a route, makes route publicly accessible
- `loading.tsx` — Suspense fallback shown while segment loads
- `error.tsx` — Error boundary for a segment
- `not-found.tsx` — 404 UI for a segment
- `route.ts` — API endpoint (Route Handler)
- `template.tsx` — Like layout but re-mounts on navigation
- `default.tsx` — Fallback for parallel routes

### Routing
- Dynamic segments: `[id]`, catch-all: `[...slug]`, optional catch-all: `[[...slug]]`
- Route groups: `(group)` — organize without affecting URL
- Parallel routes: `@slot` — render multiple pages in same layout
- Intercepting routes: `(.)`, `(..)`, `(...)`, `(..)(..)` — modal patterns

## Server Components (Default)

All components in the App Router are Server Components by default. They:
- Run on the server only, ship zero JavaScript to the client
- Can directly `await` data (fetch, DB queries, file system)
- Cannot use `useState`, `useEffect`, or browser APIs
- Cannot use event handlers (`onClick`, `onChange`)

```tsx
// app/users/page.tsx — Server Component (default)
export default async function UsersPage() {
  const users = await db.query('SELECT * FROM users')
  return <UserList users={users} />
}
```

## Client Components

Add `'use client'` at the top of the file when you need interactivity or browser APIs.

```tsx
'use client'
import { useState } from 'react'

export function Counter() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>{count}</button>
}
```

**Rule**: Push `'use client'` as far down the component tree as possible. Keep data fetching in Server Components and pass data down as props.

## Server Actions / Server Functions

Async functions marked with `'use server'` that run on the server. Use for mutations.

```tsx
// app/actions.ts
'use server'

export async function createUser(formData: FormData) {
  const name = formData.get('name') as string
  await db.insert('users', { name })
  revalidatePath('/users')
}
```

Use Server Actions for:
- Form submissions and data mutations
- In-app mutations with `revalidatePath` / `revalidateTag`

Use Route Handlers (`route.ts`) for:
- Public APIs consumed by external clients
- Webhooks
- Large file uploads
- Streaming responses

## Cache Components (Next.js 16)

The `'use cache'` directive enables component and function-level caching.

```tsx
'use cache'

export async function CachedUserList() {
  cacheLife('hours') // Configure cache duration
  cacheTag('users')  // Tag for on-demand invalidation
  const users = await db.query('SELECT * FROM users')
  return <UserList users={users} />
}
```

Invalidate with `updateTag('users')` from a Server Action. This replaces PPR from Next.js 15 canaries.

## Proxy (formerly Middleware)

In Next.js 16, `middleware.ts` is renamed to `proxy.ts`. It runs on the Node.js runtime (not Edge).

```ts
// proxy.ts
import type { NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  // Rewrite, redirect, set headers, etc.
}

export const config = { matcher: ['/dashboard/:path*'] }
```

## Breaking Changes in Next.js 16

1. **Async Request APIs**: `cookies()`, `headers()`, `params`, `searchParams` are all async — must `await` them
2. **Proxy replaces Middleware**: Rename `middleware.ts` → `proxy.ts`, runs on Node.js (not Edge)
3. **Turbopack is top-level config**: Move from `experimental.turbopack` to `turbopack` in `next.config`
4. **View Transitions**: Built-in support for animating elements across navigations

## Rendering Strategy Decision

| Strategy | When to Use |
|----------|-------------|
| SSG (`generateStaticParams`) | Content rarely changes, maximum performance |
| ISR (`revalidate: N`) | Content changes periodically, acceptable staleness |
| SSR (Server Components) | Per-request fresh data, personalized content |
| Cache Components (`'use cache'`) | Mix static shell with dynamic parts |
| Client Components | Interactive UI, browser APIs needed |
| Streaming (Suspense) | Show content progressively as data loads |

## OG Image Generation

Next.js supports file-based OG image generation via `opengraph-image.tsx` and `twitter-image.tsx` special files. These use `@vercel/og` (built on Satori) to render JSX to images at the Edge runtime.

### File Convention

Place an `opengraph-image.tsx` (or `twitter-image.tsx`) in any route segment to auto-generate social images for that route:

```tsx
// app/blog/[slug]/opengraph-image.tsx
import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'Blog post'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const post = await fetch(`https://api.example.com/posts/${slug}`).then(r => r.json())

  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 48,
          background: 'linear-gradient(to bottom, #000, #111)',
          color: 'white',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 48,
        }}
      >
        {post.title}
      </div>
    ),
    { ...size }
  )
}
```

### Key Points

- **`ImageResponse`** — Import from `next/og` (re-exports `@vercel/og`). Renders JSX to PNG/SVG images.
- **Edge runtime** — OG image routes run on the Edge runtime by default. Export `runtime = 'edge'` explicitly for clarity.
- **Exports** — `alt`, `size`, and `contentType` configure the generated `<meta>` tags automatically.
- **Static or dynamic** — Without params, the image is generated at build time. With dynamic segments, it generates per-request.
- **Supported CSS** — Satori supports a Flexbox subset. Use inline `style` objects (no Tailwind). `display: 'flex'` is required on containers.
- **Fonts** — Load custom fonts via `fetch` and pass to `ImageResponse` options: `{ fonts: [{ name, data, style, weight }] }`.
- **Twitter fallback** — If no `twitter-image.tsx` exists, `opengraph-image.tsx` is used for Twitter cards too.

### When to Use

| Approach | When |
|----------|------|
| `opengraph-image.tsx` file | Dynamic per-route OG images with data fetching |
| Static `opengraph-image.png` file | Same image for every page in a segment |
| `generateMetadata` with `openGraph.images` | Point to an external image URL |

## Deployment on Vercel

- Zero-config: Vercel auto-detects Next.js and optimizes
- `vercel dev` for local development with Vercel features
- Server Components → Serverless/Edge Functions automatically
- Image optimization via `next/image` (automatic on Vercel)
- Font optimization via `next/font` (automatic on Vercel)

## Common Patterns

### Data Fetching in Server Components
```tsx
// Parallel data fetching
const [users, posts] = await Promise.all([
  getUsers(),
  getPosts(),
])
```

### Streaming with Suspense
```tsx
import { Suspense } from 'react'

export default function Page() {
  return (
    <div>
      <h1>Dashboard</h1>
      <Suspense fallback={<Skeleton />}>
        <SlowDataComponent />
      </Suspense>
    </div>
  )
}
```

### Error Handling
```tsx
// app/dashboard/error.tsx
'use client'

export default function Error({ error, reset }: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div>
      <h2>Something went wrong</h2>
      <button onClick={() => reset()}>Try again</button>
    </div>
  )
}
```

## Official Documentation

- [Next.js Documentation](https://nextjs.org/docs)
- [App Router](https://nextjs.org/docs/app/getting-started)
- [Routing](https://nextjs.org/docs/app/building-your-application/routing)
- [Data Fetching](https://nextjs.org/docs/app/building-your-application/data-fetching)
- [Rendering](https://nextjs.org/docs/app/building-your-application/rendering)
- [Caching](https://nextjs.org/docs/app/building-your-application/caching)
- [Deploying](https://nextjs.org/docs/app/getting-started/deploying)
- [Upgrading](https://nextjs.org/docs/app/guides/upgrading)
- [GitHub: Next.js](https://github.com/vercel/next.js)
