---
name: auth
description: Authentication integration guidance — Clerk (native Vercel Marketplace), Better Auth, Descope, and Auth0 setup for Next.js applications, plus Sign in with Vercel, Vercel Passport, and Vercel KMS. Covers server config, route handlers, proxy.ts auth patterns, sign-in/sign-up flows, and Marketplace provisioning. Use when implementing user authentication, sessions, protected routes, or protecting deployments.
metadata:
  priority: 6
  docs:
    - "https://authjs.dev/getting-started"
    - "https://nextjs.org/docs/app/guides/authentication"
    - "https://better-auth.com/llms.txt"
  sitemap: "https://authjs.dev/sitemap.xml"
  pathPatterns:
    - 'proxy.ts'
    - 'proxy.js'
    - 'src/proxy.ts'
    - 'src/proxy.js'
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
    - '\bnpm\s+(install|i|add)\s+[^\n]*@vercel/kms\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@vercel/kms\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@vercel/kms\b'
    - '\byarn\s+add\s+[^\n]*@vercel/kms\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bbetter-auth\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bbetter-auth\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bbetter-auth\b'
    - '\byarn\s+add\s+[^\n]*\bbetter-auth\b'
    - '\b(npx|bunx|pnpm\s+dlx)\s+(auth@latest|@better-auth/cli)\b'
  importPatterns:
    - "@vercel/kms"
    - "better-auth"
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
    - sign in with vercel
    - passport
    - kms
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
    - Vercel Passport
    - Okta
    - Microsoft Entra ID
    - Vercel KMS
    - signToken
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
    message: 'Auth logic in a middleware() export — Next.js 16 uses proxy.ts with a proxy() export. Loading Routing Middleware guidance for the migration.'
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
    pattern: 'from\s+[''"]@clerk/nextjs[''"]'
    targetSkill: auth
    message: 'Clerk import detected — loading Auth guidance for Clerk v7 patterns, middleware setup, organization handling, and Vercel Marketplace integration.'
    skipIfFileContains: 'clerkMiddleware|ClerkProvider'
  -
    pattern: "bcrypt|argon2"
    targetSkill: auth
    message: 'Manual password hashing detected (bcrypt/argon2) — use Clerk, Better Auth, or Auth0 for authentication with built-in password hashing and rate limiting.'
    skipIfFileContains: "@clerk|@auth0|better-auth"
  -
    pattern: 'from\s+[''"]better-auth[''"]|betterAuth\s*\('
    targetSkill: auth
    message: 'Better Auth config detected — loading Auth guidance for the Next.js route handler, nextCookies plugin, cookie-only middleware checks, cookie cache, and Marketplace Postgres/Redis wiring.'
    skipIfFileContains: 'nextCookies|toNextJsHandler'
---

# Authentication Integrations

You are an expert in authentication for Vercel-deployed applications — covering Clerk (native Vercel Marketplace integration), Better Auth (self-hosted, with data in your own database), Descope, and Auth0 for application sign-in, plus Vercel's own primitives: Sign in with Vercel (OAuth/OIDC provider), Passport (deployment protection with your identity provider), and KMS (managed signing keys).

All Next.js examples target Next.js 16, where the request-interception file is `proxy.ts` (exporting `proxy`). On Next.js 15 or earlier the same code lives in `middleware.ts` (exporting `middleware`).

## Clerk (Recommended — Native Marketplace Integration)

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

### Proxy Configuration

```ts
// proxy.ts (Next.js 16; middleware.ts on Next.js 15 and earlier)
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
// proxy.ts — protect specific routes
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
// proxy.ts
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

## Better Auth (Self-Hosted)

Better Auth is a framework-agnostic TypeScript auth library that runs inside your app. Users, sessions, and accounts live in your own database, so the only external dependency is the database itself. Choose it when the user wants auth inside their app with data in their own database, or is building on a framework other than Next.js. Current release line: v1.7.

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

### Provider and Proxy

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
// proxy.ts
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

### Proxy

```ts
// proxy.ts
import { auth0 } from "@/lib/auth0";
import type { NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
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

## Vercel-Native Identity Primitives

These are not replacements for Clerk, Descope, or Auth0. They cover cases where the identity comes from Vercel itself or where you need Vercel to hold the keys.

### Sign in with Vercel

Let users log in with their Vercel account. Vercel's Identity Provider implements OAuth 2.0 and OpenID Connect: register an App in the dashboard, redirect to `https://vercel.com/oauth/authorize` with PKCE (`code_challenge_method: 'S256'`), `state`, and `nonce`, then exchange the `code` at `https://api.vercel.com/login/oauth/token`. Access tokens last 1 hour; refresh tokens last 30 days and rotate on use. Never hand-roll the token exchange without PKCE, state, and nonce checks. Docs: https://vercel.com/docs/sign-in-with-vercel/getting-started

### Vercel Passport (deployment protection)

Passport protects whole deployments behind your own OIDC identity provider (Okta, Microsoft Entra ID, Auth0, or any OIDC-compatible provider). Vercel Connect stores the OAuth application configuration, and Vercel redirects unauthenticated visitors before any request reaches your code. Use it for internal tools and previews instead of application-level auth. Your app can read the verified visitor identity server-side or verify a forwarded Passport token as a JWT. Enterprise plan; GA since July 2026. Docs: https://vercel.com/docs/passport

### Vercel KMS (managed signing keys)

KMS signs JWTs and messages with keys that never leave Vercel. Create an issuer in the team's Key Management settings, install `@vercel/kms`, and call `signToken({ issuerId, claims, ttl })` inside a route handler or Server Component; the function's OIDC token authorizes the request automatically. Relying parties verify against the published JWKS at `https://kms.vercel.com/<issuerId>/jwks.json`. Use it instead of storing private signing keys in environment variables. Docs: https://vercel.com/docs/kms

## Decision Matrix

| Need | Recommended | Why |
|------|------------|-----|
| Fastest setup on Vercel | Clerk | Native Marketplace, auto-provisioned env vars |
| Passwordless / social login flows | Descope | Visual flow builder, Marketplace native |
| Enterprise SSO / SAML / multi-tenant | Auth0 | Deep enterprise identity support |
| Pre-built UI components | Clerk | Drop-in `<SignIn />`, `<UserButton />` |
| Vercel unified billing | Clerk or Descope | Both are native Marketplace integrations |
| Auth in your own database, no hosted vendor | Better Auth | Runs in your app, data in your own database, no vendor dashboard to configure |
| Not Next.js (SvelteKit, Nuxt, Hono, Expo, plain Node) | Better Auth | Framework-agnostic handler + client adapters |
| Orgs, 2FA, passkeys, SSO, Stripe as code | Better Auth | Plugin system with generated schema |
| "Log in with Vercel" for a developer tool | Sign in with Vercel | Vercel is the identity provider |
| Restrict a deployment to employees behind Okta/Entra | Vercel Passport | Platform-level, no app code |
| Sign JWTs without storing private keys | Vercel KMS | Managed keys, OIDC-authorized signing |

## Clerk Core 3 Breaking Changes (March 2026)

Clerk provides an upgrade CLI that scans your codebase and applies codemods: `npx @clerk/upgrade`. Requires **Node.js 20.9.0+**.

- **`SignedIn`/`SignedOut`/`Protect` replaced by `Show`** — e.g. `<Protect role="admin">` → `<Show when={{ role: 'admin' }}>`
- **Package renames** — `@clerk/clerk-react` → `@clerk/react`, `@clerk/clerk-expo` → `@clerk/expo`
- **`ClerkProvider` must be inside `<body>`, not wrapping `<html>`** — the CLI handles this automatically
- **`@clerk/types` removed** — import types from the SDK's own `/types` entry point, or `@clerk/shared/types` for framework-agnostic code
- **Redirect props renamed** — `afterSignInUrl`/`afterSignUpUrl`/`redirectUrl` → `fallbackRedirectUrl`/`signUpFallbackRedirectUrl`/`forceRedirectUrl`
- **Minimum Next.js version: 15.2.3** — Next.js 13 and 14 are no longer supported
- **Satellite domains** — apps no longer auto-redirect on first visit; set `satelliteAutoSync: true` in middleware and `ClerkProvider` to restore Core 2 behavior
- **`getToken()` throws `ClerkOfflineError` when offline** — previously returned `null`; still returns `null` when signed out

## Cross-References

- **Marketplace install and env var provisioning** → `⤳ skill: marketplace`
- **Proxy and Routing Middleware patterns** → `⤳ skill: routing-middleware`
- **Accessing protected deployments from CLI or tests** → `⤳ skill: access-protected-vercel-deployment`
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
- [Sign in with Vercel](https://vercel.com/docs/sign-in-with-vercel)
- [Vercel Passport](https://vercel.com/docs/passport)
- [Vercel KMS](https://vercel.com/docs/kms)
