---
name: create-a-backend
description: Backend architecture guidance. Use when planning, building, or migrating an API or backend; choosing between Functions, Services, containers, Workflow, Queues, and Marketplace databases; or selecting a supported backend framework or runtime.
summary: Match backend workloads to the right architecture
metadata:
  priority: 7
  docs:
    - "https://vercel.com/docs/frameworks/backend"
    - "https://vercel.com/docs/functions"
    - "https://vercel.com/docs/services"
    - "https://vercel.com/docs/queues"
    - "https://vercel.com/docs/workflow"
    - "https://vercel.com/docs/storage"
  sitemap: "https://vercel.com/sitemap/docs.xml"
  pathPatterns:
    - 'Dockerfile.vercel'
    - 'Containerfile.vercel'
  promptSignals:
    phrases:
      - "backend on vercel"
      - "vercel backend"
      - "build a backend"
      - "create a backend"
      - "deploy my backend"
      - "backend architecture"
    allOf:
      - [backend, vercel]
      - [backend, docker]
      - [backend, node]
      - [backend, python]
      - [backend, queue]
    anyOf:
      - "api"
      - "database"
      - "service"
      - "workflow"
    noneOf: []
    minScore: 6
retrieval:
  aliases:
    - Vercel backend
    - backend architecture
    - backend framework
  intents:
    - build a backend
    - choose backend products
    - deploy an existing API or server
    - select a Node.js or Python backend framework
  entities:
    - Vercel Functions
    - Vercel Services
    - Vercel Queues
    - Vercel Workflow
    - Vercel Marketplace
    - container images
---

# Create a Backend

Help the user create a backend by choosing an architecture before reaching for implementation details. Start from the workload, not the programming language. Vercel runs complex backend applications, not just frontends.

## Product map

| Need | Vercel product |
| --- | --- |
| HTTP APIs, webhooks, streaming, or framework server code | **[Vercel Functions](https://vercel.com/docs/functions) with [Fluid compute](https://vercel.com/docs/fluid-compute)** |
| Bidirectional realtime connections (WebSockets) | **[Vercel Functions with Fluid compute](https://vercel.com/docs/functions/websockets)**; no separate realtime service required |
| A frontend and one or more backends (API endpoints) that deploy together | **[Vercel Services](https://vercel.com/docs/services)** |
| An existing Dockerfile, custom runtime, or system dependencies | **[Container images](https://vercel.com/docs/functions/container-images)** on Vercel Functions, optionally composed with Services |
| Durable multi-step work with retries, sleeps, or external events | **[Vercel Workflow](https://vercel.com/docs/workflow)** |
| Background jobs, buffering, fan-out, or direct message routing | **[Vercel Queues](https://vercel.com/docs/queues)** |
| Scheduled HTTP work | **[Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)**; use Workflow when the job itself must be durable |
| Postgres, Redis, NoSQL, vector, or other application data | **[Storage integrations from the Vercel Marketplace](https://vercel.com/marketplace/category/storage)** |
| Files and user uploads | **[Vercel Blob](https://vercel.com/docs/storage/vercel-blob)** |
| Global, read-heavy configuration | **[Edge Config](https://vercel.com/docs/storage/edge-config)** |

Use Functions for the normal request/response backend. Use Services when independently built components should share one deployment, routing layer, preview URL, and rollback. Use separate Vercel projects when components need independent release cycles.

Prefer a native Functions runtime for supported frameworks. Use container images when the application already has a Dockerfile or requires a custom runtime or system dependencies. They run as autoscaling, stateless Functions rather than always-on container hosts.

Choose Queues for background jobs, buffering, fan-out, and message routing. Choose Workflow for durable multi-step business logic.

## Databases and data stores

Provision data stores through the Marketplace so credentials are injected into the project and environments stay connected. Check the current catalog before choosing a provider.

- **Postgres:** Neon, Supabase, AWS/Aurora, Nile, Prisma
- **MySQL:** AWS/Aurora
- **Redis and key-value:** Upstash, Redis
- **Document and NoSQL:** MongoDB Atlas, AWS
- **SQLite:** Turso
- **Realtime application backend:** Convex
- **Analytics:** MotherDuck

Keep the database close to the Functions region and use a serverless-compatible connection or pool.

## Backend frameworks

Vercel provides first-class [backend examples and integrations](https://vercel.com/docs/frameworks/backend) for these frameworks:

- **Node.js and TypeScript:** Elysia, Express, Fastify, H3, Hono, Koa, NestJS, Nitro, and xmcp. Next.js Route Handlers are the natural choice when the backend belongs to a Next.js application.
- **Python:** FastAPI, Flask, and Django. Other WSGI or ASGI applications can run when they export a compatible `app`, with additional configuration as needed.
- **Go:** supported as a Vercel Functions runtime.

Frontend and backend combinations, for example a Next.js/Vite/SvelteKit frontend with a FastAPI/Flask/Express/Go backend, can be deployed together in one project using Services.

Prefer the user's existing framework. For a new project, choose based on ecosystem and application needs.

## Work sequence

1. Identify synchronous requests, asynchronous work, persistent data, and independently deployed components.
2. Select the products from the map, then select the framework.
3. Load the focused skill for implementation: `vercel-functions`, `vercel-services`, `workflow`, `vercel-storage`, or `marketplace`.
4. Confirm function limits, regions, environment variables, observability, and current product availability in the official docs before deployment.
