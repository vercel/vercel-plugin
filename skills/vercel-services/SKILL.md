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
  sitemap: "https://vercel.com/sitemap/docs.xml"
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
      - [frontend, backend, vercel]
      - [polyglot, vercel]
      - [multiple, services, vercel]
      - [services, vercel.json]
      - [vercel, service, binding]
    anyOf:
      - "frontend"
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
    - deploy frontend and backend together on Vercel
    - configure multiple services in vercel.json
    - route requests to a service
    - call another service privately
  entities:
    - services
    - bindings
    - destination.service
    - root
  examples:
    - put a Next.js frontend and FastAPI backend in one Vercel project
    - expose one service at /api and keep another service private
    - inject an internal backend URL into the frontend service
---

# Vercel Services

Use the `services` model to define multiple independently built components in one Vercel project.

Services build independently but share one project, domain, preview, deployment, and rollback. Public traffic enters through one ordered route table. Private service-to-service traffic uses explicit bindings.

## Choose the right structure

| Need | Use |
| --- | --- |
| One framework can own the whole app, such as Next.js with Route Handlers | One normal Vercel project without Services |
| Multiple frameworks or backends should deploy and roll back together on one domain | Vercel Services |
| Applications need separate domains or independent deploy lifecycles | Separate Vercel projects in a monorepo |
| Independently deployed frontends must render as one site | Vercel Microfrontends |

Do not introduce Services just to split one framework into arbitrary processes. Use it when an independently built component has a real runtime, framework, dependency, or deployment-boundary reason to exist.

## Define services and public ingress

Each service requires a `root` relative to `vercel.json`. Let Vercel detect the framework unless pinning it is necessary. Set `entrypoint` relative to the service root when the runtime needs one.

```json filename="vercel.json"
{
  "services": {
    "frontend": {
      "root": "apps/web",
      "framework": "nextjs",
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
      "framework": "fastapi",
      "entrypoint": "main:app"
    }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": { "service": "backend" } },
    { "source": "/(.*)", "destination": { "service": "frontend" } }
  ]
}
```

The top-level rewrites expose the services. A service without a matching top-level rewrite is not publicly reachable.

Keep configuration ownership clear:

- Keep public `rewrites`, `redirects`, `headers`, and other URL behavior at the top level.
- Put `functions`, `installCommand`, `buildCommand`, `devCommand`, `ignoreCommand`, `outputDirectory`, and framework settings on the service that owns them.
- Put service-local `headers`, `redirects`, `rewrites`, or `routes` inside a service only when they should run after public ingress selects that service.
- Set `runtime: "container"` when a service must build from a Dockerfile or OCI image. Use `entrypoint` for a nonstandard Dockerfile and `command` to override the image command.

## Route requests correctly

Top-level rewrites are evaluated in order. Put specific rules before the catch-all.

Routing into a service is final. If the selected service returns a 404 or 405, Vercel does not try the next top-level rewrite.

The service receives the original request path. With the example above, `GET /api/users` reaches `backend` as `/api/users`, not `/users`. Define the backend route accordingly.

`destination.path` changes route lookup inside the service, not the path observed by application code. Use a service-level `request.path` transform only when application code must observe a changed path.

## Call services privately with bindings

Declare a binding on the caller service, name the target service, and choose the environment variable that receives the generated URL. Do not hardcode deployment hostnames or manually set binding variables.

```ts
const url = new URL('/api/users', process.env.BACKEND_INTERNAL_URL);
const response = await fetch(url);
```

Bindings are deployment-aware and do not create public routes. They are available to functions at runtime, not during builds or in Routing Middleware. Internal calls skip the public Firewall, Deployment Protection, top-level middleware, and CDN pipeline.

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
- **A backend returns 404:** confirm its routes include the public prefix because Vercel preserves the original request path.
- **A binding variable is missing:** declare the binding on the caller and access it from runtime function code, not build code or middleware.
- **Build settings are ignored or rejected:** move top-level build and runtime fields into the owning service.
- **Framework detection is wrong:** set that service's `framework` or `entrypoint` explicitly instead of changing the whole project.

## Related skills

- Deployment commands and CI: `⤳ skill: deployments-cicd`
- Function runtime behavior and limits: `⤳ skill: vercel-functions`
- Independent frontend deployments: `⤳ skill: microfrontends`
