---
name: auth
description: Authentication integration guidance — Clerk (native Vercel Marketplace), Descope, and Auth0 setup for Next.js applications, plus Sign in with Vercel, Vercel Passport, and Vercel KMS. Covers proxy.ts auth patterns, sign-in/sign-up flows, and Marketplace provisioning. Use when implementing user authentication or protecting deployments.
metadata:
  priority: 6
  docs:
    - "https://authjs.dev/getting-started"
    - "https://nextjs.org/docs/app/building-your-application/authentication"
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
  importPatterns:
    - "@vercel/kms"
validate:
  -
    pattern: 'VERCEL_CLIENT_(ID|SECRET)|vercel\.com/oauth/(authorize|access_token|token)'
    message: 'Hand-rolled Vercel OAuth detected. Use the Sign in with Vercel OIDC provider instead of manual token exchange.'
    severity: recommended
    skipIfFileContains: 'signInWithVercel|@vercel/auth'
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
chainTo:
  -
    pattern: 'export\s+(default\s+)?function\s+middleware'
    targetSkill: routing-middleware
    message: 'Auth logic in a middleware() export — Next.js 16 uses proxy.ts with a proxy() export. Loading Routing Middleware guidance for the migration.'
  -
    pattern: 'from\s+[''\"](jsonwebtoken)[''"]|require\s*\(\s*[''\"](jsonwebtoken)[''"]|jwt\.sign\s*\('
    targetSkill: auth
    message: 'Manual JWT handling with jsonwebtoken detected — use Clerk or Auth.js for managed auth with built-in JWT session handling, CSRF protection, and token rotation.'
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
    message: 'Manual password hashing detected (bcrypt/argon2) — use Clerk or Auth0 for managed authentication with built-in password hashing, rate limiting, and breach detection.'
    skipIfFileContains: "@clerk|@auth0"
---

# Authentication Integrations

You are an expert in authentication for Vercel-deployed applications — covering Clerk (native Vercel Marketplace integration), Descope, and Auth0 for application sign-in, plus Vercel's own primitives: Sign in with Vercel (OAuth/OIDC provider), Passport (deployment protection with your identity provider), and KMS (managed signing keys).

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
| "Log in with Vercel" for a developer tool | Sign in with Vercel | Vercel is the identity provider |
| Restrict a deployment to employees behind Okta/Entra | Vercel Passport | Platform-level, no app code |
| Sign JWTs without storing private keys | Vercel KMS | Managed keys, OIDC-authorized signing |

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
- **Proxy and Routing Middleware patterns** → `⤳ skill: routing-middleware`
- **Accessing protected deployments from CLI or tests** → `⤳ skill: access-protected-vercel-deployment`
- **Environment variable management** → `⤳ skill: env-vars`

## Official Documentation

- [Clerk + Vercel Marketplace](https://clerk.com/docs/deployments/vercel)
- [Clerk Next.js Quickstart](https://clerk.com/docs/quickstarts/nextjs)
- [Descope Next.js SDK](https://docs.descope.com/getting-started/nextjs)
- [Auth0 Next.js SDK](https://auth0.com/docs/quickstart/webapp/nextjs)
- [Sign in with Vercel](https://vercel.com/docs/sign-in-with-vercel)
- [Vercel Passport](https://vercel.com/docs/passport)
- [Vercel KMS](https://vercel.com/docs/kms)
