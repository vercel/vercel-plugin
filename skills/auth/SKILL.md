---
name: auth
description: Authentication integration guidance — Better Auth, Clerk (native Vercel Marketplace), Descope, and Auth0 setup for Next.js applications. Covers server config, route handlers, middleware/proxy session checks, sign-in/sign-up flows, and Marketplace provisioning. Use when implementing user authentication, sessions, or protected routes.
metadata:
  priority: 6
  docs:
    - "https://authjs.dev/getting-started"
    - "https://nextjs.org/docs/app/building-your-application/authentication"
    - "https://better-auth.com/llms.txt"
  sitemap: "https://authjs.dev/sitemap.xml"
  pathPatterns:
    - 'middleware.ts'
    - 'middleware.js'
    - 'src/middleware.ts'
    - 'src/middleware.js'
    - 'clerk.config.*'
    - 'app/sign-in/**'
    - 'app/sign-up/**'
    - 'src/app/sign-in/**'
    - 'src/app/sign-up/**'
    - 'app/(auth)/**'
    - 'src/app/(auth)/**'
    - 'auth.config.*'
    - 'auth.ts'
    - 'auth.js'
    - 'lib/auth.ts'
    - 'src/lib/auth.ts'
    - 'lib/auth-client.ts'
    - 'src/lib/auth-client.ts'
    - 'app/api/auth/[...all]/**'
    - 'src/app/api/auth/[...all]/**'
    - 'proxy.ts'
    - 'src/proxy.ts'
  importPatterns:
    - 'better-auth'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*@clerk/nextjs\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@clerk/nextjs\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@clerk/nextjs\b'
    - '\byarn\s+add\s+[^\n]*@clerk/nextjs\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@descope/nextjs-sdk\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@descope/nextjs-sdk\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@descope/nextjs-sdk\b'
    - '\byarn\s+add\s+[^\n]*@descope/nextjs-sdk\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@auth0/nextjs-auth0\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@auth0/nextjs-auth0\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@auth0/nextjs-auth0\b'
    - '\byarn\s+add\s+[^\n]*@auth0/nextjs-auth0\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bbetter-auth\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bbetter-auth\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bbetter-auth\b'
    - '\byarn\s+add\s+[^\n]*\bbetter-auth\b'
    - '\b(npx|bunx|pnpm\s+dlx)\s+(auth@latest|@better-auth/cli)\b'
validate:
  -
    pattern: 'VERCEL_CLIENT_(ID|SECRET)|vercel\.com/oauth/(authorize|access_token|token)'
    message: 'Hand-rolled Vercel OAuth detected. Use the Sign in with Vercel OIDC provider (or the built-in `vercel` social provider in Better Auth) instead of manual token exchange.'
    severity: recommended
    skipIfFileContains: 'signInWithVercel|@vercel/auth|better-auth|socialProviders'
retrieval:
  aliases:
    - authentication
    - login system
    - sign in
    - auth flow
  intents:
    - add auth
    - protect routes
    - manage sessions
    - implement login
    - secure api endpoints
  entities:
    - NextAuth
    - Auth.js
    - Better Auth
    - betterAuth
    - authClient
    - JWT
    - OAuth
    - session
    - middleware
    - getServerSession
  examples:
    - add login to my app
    - protect this route with auth
    - set up NextAuth
    - set up Better Auth
    - add better auth to my next app
chainTo:
  -
    pattern: 'export\s+(default\s+)?function\s+middleware'
    targetSkill: routing-middleware
    message: 'Auth logic in middleware.ts — loading Routing Middleware guidance for proxy.ts migration in Next.js 16.'
  -
    pattern: 'from\s+[''\"](jsonwebtoken)[''"]|require\s*\(\s*[''\"](jsonwebtoken)[''"]|jwt\.sign\s*\('
    targetSkill: auth
    message: 'Manual JWT handling with jsonwebtoken detected — use Clerk, Better Auth, or Auth.js for built-in session handling, CSRF protection, and token rotation.'
    skipIfFileContains: 'better-auth|@clerk|next-auth'
  -
    pattern: 'from\s+[''\"](next-auth)[''"]|NextAuthOptions|authOptions\s*:'
    targetSkill: auth
    message: 'Legacy next-auth (v4) pattern detected — loading auth guidance for Auth.js v5 migration with the new universal auth() helper.'
  -
    pattern: "from\\s+['\"]@clerk/nextjs['\"]"
    targetSkill: auth
    message: 'Clerk import detected — loading Auth guidance for Clerk v7 patterns, middleware setup, organization handling, and Vercel Marketplace integration.'
    skipIfFileContains: 'clerkMiddleware|ClerkProvider'
  -
    pattern: "bcrypt|argon2"
    targetSkill: auth
    message: 'Manual password hashing detected (bcrypt/argon2) — use Clerk, Better Auth, or Auth0 for authentication with built-in password hashing and rate limiting.'
    skipIfFileContains: "@clerk|@auth0|better-auth"
  -
    pattern: "from\\s+['\"]better-auth['\"]|betterAuth\\s*\\("
    targetSkill: auth
    message: 'Better Auth config detected — loading Auth guidance for the Next.js route handler, nextCookies plugin, cookie-only middleware checks, cookie cache, and Marketplace Postgres/Redis wiring.'
    skipIfFileContains: 'nextCookies|toNextJsHandler'
---

# Authentication Integrations

You are an expert in authentication for Vercel-deployed applications — covering Better Auth (recommended), Clerk (native Vercel Marketplace integration), Descope, and Auth0.

## Better Auth (Recommended)

Better Auth is a framework-agnostic TypeScript auth library that runs inside your app. Users, sessions, and accounts live in your own database, so the only external dependency is the database itself. Default to it unless the user asks for a hosted provider. Current release line: v1.7.

### Agent Workflow

1. **Detect** framework (Next.js App/Pages Router, SvelteKit, Nuxt, Hono…), database/ORM (`prisma/schema.prisma`, `drizzle.config.ts`, `pg`, `@neondatabase/serverless`), and package manager from the lockfile.
2. **Install** `better-auth` plus the DB driver. Provision Postgres from the Marketplace if the project has no database.
3. **Create** `lib/auth.ts` (server) and `lib/auth-client.ts` (client).
4. **Mount** the route handler at `app/api/auth/[...all]/route.ts`.
5. **Migrate** with `npx auth@latest migrate` (built-in adapter) or `generate` + the ORM's migrate (Prisma/Drizzle).
6. **Protect** routes: cookie check in `proxy.ts`, real `getSession()` in pages/route handlers.
7. **Verify** `GET /api/auth/ok` returns `{ "status": "ok" }`, then run a sign-up → sign-in → `getSession()` pass.
8. **Re-run migrate** after every plugin change.

### Install

```bash
npm install better-auth pg
# Postgres from the Marketplace (auto-provisions DATABASE_URL)
vercel integration add neon
```

### Environment Variables

```env
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
```

- **Production:** set `BETTER_AUTH_URL` to your production domain.
- **Preview:** leave `BETTER_AUTH_URL` unset for the Preview environment. Better Auth infers the base URL from the incoming request, so every preview URL works without config. `VERCEL_URL` is **not** read automatically.
- OAuth providers need registered redirect URIs (`<base>/api/auth/callback/<provider>`), so social login on previews needs a stable branch alias.

### Server Config

```ts
// lib/auth.ts
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    // Sign in with Vercel — create a Vercel App in the dashboard for credentials
    vercel: {
      clientId: process.env.VERCEL_CLIENT_ID!,
      clientSecret: process.env.VERCEL_CLIENT_SECRET!,
    },
  },
  session: {
    // Signed cookie cache: most getSession() calls skip the database
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  plugins: [nextCookies()], // keep last — sets cookies from Server Actions
});
```

Prisma / Drizzle / MongoDB users pass an adapter instead of a pool: `prismaAdapter(prisma, { provider: "postgresql" })` from `better-auth/adapters/prisma`, `drizzleAdapter(db, { provider: "pg" })` from `better-auth/adapters/drizzle`.

### Route Handler

```ts
// app/api/auth/[...all]/route.ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

### Database Schema

```bash
npx auth@latest migrate    # built-in adapter (pg / mysql / sqlite): applies directly
npx auth@latest generate   # Prisma / Drizzle: writes the schema, then run your ORM's migrate
```

Re-run after adding or removing plugins. Verify with `GET /api/auth/ok` → `{ "status": "ok" }`.

### Client

```ts
// lib/auth-client.ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
```

```tsx
"use client";
import { authClient } from "@/lib/auth-client";

// Sign in
await authClient.signIn.email({ email, password, callbackURL: "/dashboard" });
await authClient.signIn.social({ provider: "github", callbackURL: "/dashboard" });
await authClient.signUp.email({ email, password, name });
await authClient.signOut();

// Reactive session
const { data: session, isPending } = authClient.useSession();
```

### Access Session Data (Server)

```tsx
// Server Component, Server Action, or Route Handler
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  return <p>Hello, {session.user.name}</p>;
}
```

Every endpoint (including plugin endpoints) is callable server-side via `auth.api.*` — no HTTP round-trip.

### Protect Routes

Only check for the session **cookie** in middleware/proxy — never call the database there. Do the real check in the page or route handler.

```ts
// proxy.ts (Next.js 16) — rename to middleware.ts on Next.js 15
import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };
```

### Keep It Fast on Vercel

- **Cookie cache on** (`session.cookieCache`) — avoids a DB read per request in Fluid Compute functions.
- **Redis for shared state** — `vercel integration add upstash`, then pass a `secondaryStorage` adapter. Sessions and rate-limit counters move to Redis; the default in-memory rate limiter does not share state across function instances. Set `rateLimit.storage: "secondary-storage"`.
- **Import plugins from subpaths** for tree-shaking: `import { twoFactor } from "better-auth/plugins/two-factor"`, not `"better-auth/plugins"`.
- **Cookie check only in middleware** — `getSessionCookie()` is synchronous and works on the Edge runtime; `auth.api.getSession()` in middleware requires the Node.js runtime and costs a DB hit per request.
- **Separate frontend origin?** Add it to `trustedOrigins` (wildcards allowed: `"https://*.vercel.app"`). Same-origin apps need nothing.

### Common Mistakes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Cookies not set from a Server Action | `nextCookies()` missing or not last in `plugins` | Add it as the last plugin |
| Middleware slow or fails on Edge | `auth.api.getSession()` in middleware | Use `getSessionCookie()`; verify in the page |
| "Invalid origin" on a separate frontend | Origin not trusted | Add it to `trustedOrigins` |
| Type errors or missing tables after adding a plugin | Schema not regenerated | Re-run `npx auth@latest migrate` / `generate` |
| Adapter can't find a model | Config uses the DB table name | Use the ORM **model** name (`modelName: "user"`, not `"users"`) |
| Rate limits reset per request in production | Default in-memory rate-limit storage | Use `secondaryStorage` (Redis) or `rateLimit.storage: "database"` |
| Callback URL wrong on Vercel | `BETTER_AUTH_URL` points at localhost or a preview | Set the production domain in Production; leave unset for Preview |

### Plugins

Server plugin + matching client plugin + re-run migrations.

| Feature | Server import | Client plugin |
|---------|--------------|---------------|
| Two-factor (TOTP/OTP) | `twoFactor` from `better-auth/plugins/two-factor` | `twoFactorClient` |
| Organizations / teams | `organization` from `better-auth/plugins/organization` | `organizationClient` |
| Magic link | `magicLink` from `better-auth/plugins/magic-link` | `magicLinkClient` |
| Admin / user management | `admin` from `better-auth/plugins/admin` | `adminClient` |
| Passkeys (WebAuthn) | `passkey` from `@better-auth/passkey` | `passkeyClient` |
| Enterprise SSO (SAML/OIDC) | `sso` from `@better-auth/sso` | — |
| Stripe subscriptions | `stripe` from `@better-auth/stripe` | `stripeClient` |
| Third-party tokens via Vercel Connect | `genericOAuth` + `connect` from `@vercel/connect/betterauth` | — |

### Agent Tooling

Install the official Better Auth skills for deeper, version-aware guidance (planning questionnaire, adapters, migrations, best practices):

```bash
npx skills add better-auth/skills
```

Docs are versioned. Match the `better-auth` version in the lockfile, then start from [better-auth.com/llms.txt](https://better-auth.com/llms.txt) or the docs MCP server (`https://mcp.better-auth.com/mcp`, or `npx auth@latest mcp --cursor` to register it).

## Clerk (Native Marketplace Integration)

Clerk is a native Vercel Marketplace integration with auto-provisioned environment variables and unified billing. Current SDK: `@clerk/nextjs` v7 (Core 3, March 2026).

### Install via Marketplace

```bash
# Install Clerk from Vercel Marketplace (auto-provisions env vars)
vercel integration add clerk
```

Auto-provisioned environment variables:
- `CLERK_SECRET_KEY` — server-side API key
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — client-side publishable key

### SDK Setup

```bash
# Install the Clerk Next.js SDK
npm install @clerk/nextjs
```

### Middleware Configuration

```ts
// middleware.ts
import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
```

### Protect Routes

```ts
// middleware.ts — protect specific routes
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/api(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});
```

### Frontend API Proxy (Core 3)

Proxy Clerk's Frontend API through your own domain to avoid third-party requests:

```ts
// middleware.ts
export default clerkMiddleware({
  frontendApiProxy: { enabled: true },
});
```

### Provider Setup

```tsx
// app/layout.tsx
import { ClerkProvider } from "@clerk/nextjs";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

### Sign-In and Sign-Up Pages

```tsx
// app/sign-in/[[...sign-in]]/page.tsx
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return <SignIn />;
}
```

```tsx
// app/sign-up/[[...sign-up]]/page.tsx
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return <SignUp />;
}
```

Add routing env vars to `.env.local`:

```env
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
```

### Access User Data

```tsx
// Server component
import { currentUser } from "@clerk/nextjs/server";

export default async function Page() {
  const user = await currentUser();
  return <p>Hello, {user?.firstName}</p>;
}
```

```tsx
// Client component
"use client";
import { useUser } from "@clerk/nextjs";

export default function UserGreeting() {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return null;
  return <p>Hello, {user?.firstName}</p>;
}
```

### API Route Protection

```ts
// app/api/protected/route.ts
import { auth } from "@clerk/nextjs/server";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json({ userId });
}
```

## Descope

Descope is available on the Vercel Marketplace with native integration support.

### Install via Marketplace

```bash
vercel integration add descope
```

### SDK Setup

```bash
npm install @descope/nextjs-sdk
```

### Provider and Middleware

```tsx
// app/layout.tsx
import { AuthProvider } from "@descope/nextjs-sdk";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider projectId={process.env.NEXT_PUBLIC_DESCOPE_PROJECT_ID!}>
      <html lang="en">
        <body>{children}</body>
      </html>
    </AuthProvider>
  );
}
```

```ts
// middleware.ts
import { authMiddleware } from "@descope/nextjs-sdk/server";

export default authMiddleware({
  projectId: process.env.DESCOPE_PROJECT_ID!,
  publicRoutes: ["/", "/sign-in"],
});
```

### Sign-In Flow

```tsx
"use client";
import { Descope } from "@descope/nextjs-sdk";

export default function SignInPage() {
  return <Descope flowId="sign-up-or-in" />;
}
```

## Auth0

Auth0 provides a mature authentication platform with extensive identity provider support.

### SDK Setup

```bash
npm install @auth0/nextjs-auth0
```

### Configuration

```ts
// lib/auth0.ts
import { Auth0Client } from "@auth0/nextjs-auth0/server";

export const auth0 = new Auth0Client();
```

Required environment variables:

```env
AUTH0_SECRET=<random-secret>
AUTH0_BASE_URL=http://localhost:3000
AUTH0_ISSUER_BASE_URL=https://your-tenant.auth0.com
AUTH0_CLIENT_ID=<client-id>
AUTH0_CLIENT_SECRET=<client-secret>
```

### Middleware

```ts
// middleware.ts
import { auth0 } from "@/lib/auth0";
import { NextRequest, NextResponse } from "next/server";

export async function middleware(request: NextRequest) {
  return await auth0.middleware(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
```

### Access Session Data

```tsx
// Server component
import { auth0 } from "@/lib/auth0";

export default async function Page() {
  const session = await auth0.getSession();
  return session ? (
    <p>Hello, {session.user.name}</p>
  ) : (
    <a href="/auth/login">Log in</a>
  );
}
```

## Decision Matrix

| Need | Recommended | Why |
|------|------------|-----|
| Fastest setup on Vercel | Clerk | Native Marketplace, auto-provisioned env vars |
| Passwordless / social login flows | Descope | Visual flow builder, Marketplace native |
| Enterprise SSO / SAML / multi-tenant | Auth0 | Deep enterprise identity support |
| Pre-built UI components | Clerk | Drop-in `<SignIn />`, `<UserButton />` |
| Vercel unified billing | Clerk or Descope | Both are native Marketplace integrations |
| Default choice | Better Auth | Runs in your app, data in your own database, no vendor dashboard to configure |
| Not Next.js (SvelteKit, Nuxt, Hono, Expo, plain Node) | Better Auth | Framework-agnostic handler + client adapters |
| Orgs, 2FA, passkeys, SSO, Stripe as code | Better Auth | Plugin system with generated schema |

## Clerk Core 3 Breaking Changes (March 2026)

Clerk provides an upgrade CLI that scans your codebase and applies codemods: `npx @clerk/upgrade`. Requires **Node.js 20.9.0+**.

- **`auth()` is async** — always use `const { userId } = await auth()`, not synchronous
- **`auth.protect()` moved** — use `await auth.protect()` directly, not from the return value of `auth()`
- **`clerkClient()` is async** — use `await clerkClient()` in middleware handlers
- **`authMiddleware()` removed** — migrate to `clerkMiddleware()`
- **`@clerk/types` deprecated** — import types from SDK subpath exports: `import type { UserResource } from '@clerk/react/types'` (works from any SDK package)
- **`ClerkProvider` no longer forces dynamic rendering** — pass the `dynamic` prop if needed
- **Cache components** — when using Next.js cache components, place `<ClerkProvider>` inside `<body>`, not wrapping `<html>`
- **Satellite domains** — new `satelliteAutoSync` option skips handshake redirects when no session cookies exist
- **Smaller bundles** — React is now shared across framework SDKs (~50KB gzipped savings)
- **Better offline handling** — `getToken()` now correctly distinguishes signed-out from offline states

## Cross-References

- **Marketplace install and env var provisioning** → `⤳ skill: marketplace`
- **Middleware routing patterns** → `⤳ skill: routing-middleware`
- **Environment variable management** → `⤳ skill: env-vars`
- **Neon Postgres / Upstash Redis for Better Auth** → `⤳ skill: vercel-storage`
- **Third-party OAuth tokens through Better Auth (`@vercel/connect/betterauth`)** → `⤳ skill: vercel-connect`

## Official Documentation

- [Better Auth Docs](https://better-auth.com/docs) · [Next.js integration](https://better-auth.com/docs/integrations/next) · [Sign in with Vercel](https://better-auth.com/docs/authentication/vercel)
- [Better Auth agent skills](https://github.com/better-auth/skills)
- [Clerk + Vercel Marketplace](https://clerk.com/docs/deployments/vercel)
- [Clerk Next.js Quickstart](https://clerk.com/docs/quickstarts/nextjs)
- [Descope Next.js SDK](https://docs.descope.com/getting-started/nextjs)
- [Auth0 Next.js SDK](https://auth0.com/docs/quickstart/webapp/nextjs)
