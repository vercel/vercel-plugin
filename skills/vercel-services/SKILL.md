---
name: vercel-services
description: Configure and troubleshoot Vercel Services for multiple frontends and backends in one project. Use when composing a polyglot or multi-service application on one Vercel deployment; defining the `services` key, service-targeted rewrites, or service bindings in `vercel.json`; or running all services with `vercel dev`.
summary: Compose multiple frontends and backends in one Vercel project
metadata:
  priority: 7
  docs:
    - "https://vercel.com/docs/services"
    - "https://vercel.com/docs/services/routing"
    - "https://vercel.com/docs/services/bindings"
    - "https://vercel.com/docs/services/config-reference"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - 'vercel.json'
    - 'apps/*/vercel.json'
  bashPatterns:
    - '\b(?:vercel|vc)\s+dev\b[^\n]*(?:--local|-L)(?:\s|$)'
  importPatterns: []
  promptSignals:
    phrases:
      - "vercel services"
      - "vercel service binding"
      - "vercel service bindings"
      - "multi-service vercel"
      - "multiple services on vercel"
      - "frontend and backend on vercel"
    allOf:
      - [backend, vercel]
      - [polyglot, vercel]
      - [multiple, services, vercel]
      - [services, vercel.json]
      - [vercel, service, binding]
    anyOf:
      - "backend"
      - "monorepo"
      - "polyglot"
      - "service"
      - "binding"
      - "vercel"
    noneOf: []
    minScore: 6
retrieval:
  aliases:
    - Vercel Services
    - multi-service project
    - polyglot project
    - service binding
    - service rewrite
  intents:
    - deploy frontend and backend together in one project
    - configure the services key in vercel.json
    - configure service rewrites
    - call the backend privately with a service binding
    - keep a service private with no public route
    - serve a service on a subdomain
    - strip a route prefix before it reaches the backend service
    - run all services locally
  entities:
    - services
    - bindings
    - destination.service
    - root
  examples:
    - put a Next.js frontend and a FastAPI backend in one project
    - deploy a Vite SPA with an Express API behind /api
    - add a Go service to an existing Next.js project
    - my frontend cannot reach the backend service
    - the backend returns 404 for every /api route
    - point api.example.com at the backend
---

# Vercel Services

Use the `services` model whenever one application is made of multiple tightly coupled components, such as a frontend plus a backend, that should deploy to one Vercel project.

Services build independently but ship together as one deployment. That buys skew protection between frontend and backend, preview environments where every service is in sync, atomic deployments and rollbacks of the whole app, and private service-to-service communication through bindings. Public traffic enters through one ordered route table.

## Choose the right structure

| Need | Use |
| --- | --- |
| Multiple tightly coupled components, such as a frontend and a backend, that should ship as one app | Vercel Services |
| One framework can own the whole app, such as Next.js with Route Handlers | One normal Vercel project without Services |
| Teams own their services and deploy and roll back on their own cadence | Separate Vercel projects in a monorepo |
| Independently deployed frontends must render as one site | Vercel Microfrontends |

The benefits and the drawback are the same fact: every deployment ships all services together. Reach for separate projects only when you specifically need to deploy or roll back one service independently of the others.

Do not introduce Services just to split one framework into arbitrary processes. Use it when an independently built component has a real runtime, framework, dependency, or ownership reason to exist.

## Define services and public ingress

Each service requires a `root` relative to `vercel.json`. Let Vercel detect the framework unless pinning it is necessary. Set `entrypoint` relative to the service root when the runtime needs one.

```json filename="vercel.json"
{
  "services": {
    "frontend": {
      "root": "apps/web",
      "bindings": [
        {
          "type": "service",
          "service": "backend",
          "format": "url",
          "env": "BACKEND_INTERNAL_URL"
        }
      ]
    },
    "backend": {
      "root": "apps/backend",
      "entrypoint": "main:app"
    }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": { "service": "backend" } },
    { "source": "/(.*)", "destination": { "service": "frontend" } }
  ]
}
```

The top-level rewrites expose the services. A service without a matching top-level rewrite is private: not reachable from the public internet, only through bindings.

Keep configuration ownership clear:

- Keep public `rewrites`, `redirects`, `headers`, and other URL behavior at the top level.
- Put `functions`, `installCommand`, `buildCommand`, `devCommand`, `ignoreCommand`, `outputDirectory`, and framework settings on the service that owns them.
- Put service-local `headers`, `redirects`, `rewrites`, or `routes` inside a service only when they should run after public ingress selects that service.
- Set `runtime: "container"` when a service must build from a Dockerfile or OCI image. Use `entrypoint` for a nonstandard Dockerfile and `command` to override the image command.

## Route requests correctly

Top-level rewrites are evaluated in order. Put specific rules before the catch-all.

Routing into a service is final. If the selected service returns a 404 or 405, Vercel does not try the next top-level rewrite.

Split the URL namespace by what the frontend needs:

- Frontends without their own server routes, such as Vite or Create React App builds, let the backend own all of `/api`.
- Frameworks with their own API routes, such as Next.js, share the namespace: send only a sub-namespace such as `/api/v1/(.*)` or specific prefixes such as `/api/users/(.*)` to the backend, and let the framework keep the rest.

The service receives the original request path. With the example above, `GET /api/users` reaches `backend` as `/api/users`, not `/users`. Either make the backend handle the prefix, such as FastAPI `root_path`, or strip it with a service-scoped rewrite:

```json filename="vercel.json"
{
  "services": {
    "backend": {
      "root": "apps/backend",
      "entrypoint": "main:app",
      "rewrites": [
        { "source": "/api/:path(.*)?", "destination": "/:path" }
      ]
    }
  }
}
```

An SPA service that serves a static `index.html`, such as a Vite build, needs a service-scoped catch-all so deep links resolve:

```json filename="vercel.json"
{
  "services": {
    "frontend": {
      "root": "apps/web",
      "rewrites": [
        { "source": "/(.*)", "destination": "/index.html" }
      ]
    }
  }
}
```

Do not set `path` on a service destination. The field is accepted by the schema but has no effect at request time. Reshape paths with a service-scoped rewrite or a `request.path` transform in the service's own `routes` instead.

## Serve a service on a subdomain

Host-matched top-level rewrites can put a service on its own subdomain, such as `api.example.com`, while the catch-all serves the frontend:

```json filename="vercel.json"
{
  "rewrites": [
    {
      "source": "/(.*)",
      "has": [{ "type": "host", "value": "api.example.com" }],
      "destination": { "service": "backend" }
    },
    { "source": "/api/(.*)", "destination": { "service": "backend" } },
    { "source": "/(.*)", "destination": { "service": "frontend" } }
  ]
}
```

Subdomains resolve only where that domain is attached: production, or a custom environment with a custom domain. Preview deployments get a single generated URL, so keep the subpath rewrite alongside the host rule and point the frontend at the relative path, for example `NEXT_PUBLIC_API_URL=/api`, so every preview calls its own deployment.

## Call services privately with bindings

Declare a binding on the caller service, name the target service, and choose the environment variable that receives the generated URL. Do not hardcode deployment hostnames or manually set binding variables.

```ts
const url = new URL('/api/users', process.env.BACKEND_INTERNAL_URL);
const response = await fetch(url);
```

Bindings are deployment-aware and do not create public routes. They are available to functions at runtime, not during builds or in Routing Middleware. Internal calls skip the public Firewall, Deployment Protection, top-level middleware, and CDN pipeline.

Public exposure is decided only by top-level rewrites. A service with no top-level rewrite is private: it is unreachable from the public internet and only accessible through its bindings. A service with both bindings and a top-level rewrite is also reachable publicly, so do not assume binding-only access implies the routes are protected.

A binding grants network reachability, not application authentication. Add service-level authorization when the target must verify the caller.

Native Go and Rust runtime services cannot currently consume bindings. Build those callers as container services when they need bindings. Node.js and Python services can use bindings directly.

## Develop and deploy

Run every service and inject local binding variables:

```bash
vercel dev
```

Use local-only mode when cloud authentication is unnecessary:

```bash
vercel dev -L
```

Deploy the project normally with `vercel` or Git integration. All services participate in the same preview and production deployment.

## Troubleshoot

- **No public traffic reaches a service:** add a top-level rewrite targeting it.
- **The wrong service receives a request:** reorder rewrites so the most specific rule comes first and the catch-all is last.
- **A backend returns 404:** confirm its routes include the public prefix because Vercel preserves the original request path, or strip the prefix with a service-scoped rewrite.
- **An SPA returns 404 on deep links:** add a service-scoped catch-all rewrite to `/index.html`.
- **A subdomain works in production but not in previews:** preview URLs have a single host, so host rules never match there. Keep a subpath rewrite to the same service and use the relative URL in the frontend.
- **A binding variable is missing:** declare the binding on the caller and access it from runtime function code, not build code or middleware.
- **Build settings are ignored or rejected:** move top-level build and runtime fields into the owning service.
- **Framework detection is wrong:** set that service's `framework` or `entrypoint` explicitly instead of changing the whole project.

## Related skills

- Deployment commands and CI: `⤳ skill: deployments-cicd`
- Function runtime behavior and limits: `⤳ skill: vercel-functions`
- Independent frontend deployments: `⤳ skill: microfrontends`
