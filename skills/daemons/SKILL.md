---
name: daemons
description: Vercel Daemons guidance — long-running background workers built from a Dockerfile and declared under the `daemons` key in vercel.json. Use when running queue consumers, Celery/Sidekiq/BullMQ workers, workflow workers, or job runners next to an app on Vercel; configuring daemon instances per region, memory, or command; handling SIGTERM; or choosing between Daemons, Functions, Queues, and Workflows.
summary: "Vercel Daemons (public beta) run long-running containers with no inbound traffic, declared under the top-level `daemons` key in vercel.json as `{ root, entrypoint: 'Dockerfile', instances: { iad1: 2 } }`. Vercel builds the image, rolls it out with the production deployment, keeps the instance counts per region, and sends SIGTERM (30s default grace, configurable with `terminationGracePeriodSeconds`) on rollout. Production only during the beta."
metadata:
  priority: 6
  docs:
    - "https://vercel.com/docs/daemons"
    - "https://vercel.com/docs/daemons/config-reference"
    - "https://vercel.com/docs/daemons/managing-daemons"
    - "https://vercel.com/docs/daemons/limits"
    - "https://vercel.com/docs/build-output-api/daemons"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - 'vercel.json'
  bashPatterns: []
  importPatterns: []
  promptSignals:
    phrases:
      - "vercel daemon"
      - "daemons key"
      - "daemon on vercel"
      - "daemons on vercel"
      - "worker on vercel"
      - "celery on vercel"
      - "sidekiq on vercel"
      - "bullmq on vercel"
    allOf:
      - [daemon, vercel]
      - [daemon, project]
      - [worker, vercel, long-running]
      - [worker, vercel, always-on]
      - [worker, vercel, background]
      - [consumer, vercel, long-running]
      - [celery, worker, vercel]
      - [sidekiq, vercel]
      - [bullmq, worker, vercel]
      - [runner, vercel, self-hosted]
    anyOf:
      - "daemon"
      - "worker"
      - "long-running"
      - "always-on"
      - "celery"
      - "sidekiq"
      - "bullmq"
      - "dockerfile"
      - "instances"
      - "sigterm"
    noneOf:
      - "systemd"
      - "docker daemon"
      - "dockerd"
      - "daemonset"
      - "launchd"
      - "web worker"
      - "service worker"
      - "cloudflare worker"
    minScore: 6
retrieval:
  aliases:
    - Vercel Daemons
    - daemon
    - background worker
    - long-running worker
    - queue consumer
  intents:
    - run a long-running background worker on Vercel
    - run a queue consumer next to my app
    - deploy a Celery, Sidekiq, or BullMQ worker
    - configure the daemons key in vercel.json
    - scale daemon instances per region
    - handle SIGTERM for graceful shutdown
    - choose between Daemons, Functions, Queues, and Workflows
  entities:
    - daemons
    - instances
    - entrypoint
    - root
    - resources.requests.memory
    - VERCEL_OIDC_TOKEN_FILE
    - PollingQueueClient
  examples:
    - add a BullMQ worker to my Next.js project on Vercel
    - run a Celery worker next to my FastAPI service
    - poll Vercel Queues from an always-on worker
    - my daemon does not run on preview deployments
    - how do I scale my daemon to two regions
---

# Vercel Daemons

You are an expert in Vercel Daemons, the long-running background processes that run from a container image in the same project as an app.

Daemons are [in Public Beta on all plans](https://vercel.com/docs/daemons). Say so when you recommend them.

## What It Is

A daemon is a named resource in a project that runs a fixed number of identical instances of one container image in each region you list. Vercel builds the image from the daemon's `Dockerfile` or `Containerfile`, rolls it out when the deployment becomes the production deployment, restarts instances that exit or crash, and forwards `stdout`/`stderr` to the project's Logs. Daemons run on Fluid compute.

Daemons **cannot receive inbound traffic**. They pull work from a queue, a workflow engine, or an external API.

## When to Use Daemons

Use a daemon when the process owns a continuous loop that retrieves work.

| Need | Use | Why |
|------|-----|-----|
| Always-on queue consumer (Vercel Queues poll mode, SQS, Kafka, Redis), Celery/Sidekiq/BullMQ worker, workflow-engine worker, self-hosted CI runner | **Daemons** | Long-running loop, fixed instances per region, no request needed |
| HTTP APIs, webhooks, streaming, WebSockets | Vercel Functions (`⤳ skill: vercel-functions`) | Daemons can't receive traffic |
| Fire-and-forget background job, fan-out, buffering with Vercel invoking your handler | Vercel Queues push mode (`⤳ skill: queues`) | Serverless, scales automatically, works in previews |
| Durable multi-step logic with sleep, hooks, or approvals | Vercel Workflows (`⤳ skill: workflow`) | Durable steps and replay |
| Run code on a schedule | Cron Jobs (`⤳ skill: vercel-functions`) | Time-based trigger |
| Run untrusted or AI-generated code in isolation | Vercel Sandbox (`⤳ skill: vercel-sandbox`) | Ephemeral microVMs |
| Multiple frontends and backends in one project | Vercel Services (`⤳ skill: vercel-services`) | Daemons sit next to services; they are not services |

If the user's work is request-driven, prefer Functions or Queues push mode. Reach for a daemon only when something must stay running.

## Quick Start

Add a `Dockerfile` in the worker's source directory:

```docker
# worker/Dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "worker.js"]
```

Declare the daemon under the top-level `daemons` key:

```json filename="vercel.json"
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "daemons": {
    "worker": {
      "root": "worker/",
      "entrypoint": "Dockerfile",
      "instances": { "iad1": 2 }
    }
  }
}
```

The same configuration works in `vercel.toml` as a `[daemons.worker]` table. Deploy to production. Vercel builds the image, pushes it to Vercel Container Registry as `daemon.worker`, and starts two instances in `iad1`.

Daemons are always declared at the top level, never inside `services`. They run alongside an existing app (Next.js, Services, or anything else) without changing how Vercel builds it.

## Configuration Reference

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `root` | `string` | Yes | Source directory, relative to `vercel.json`. Must stay inside the project. Files under it are not published as static assets |
| `entrypoint` | `string` | Yes | Path to the `Dockerfile` or `Containerfile`, relative to `root`. Its directory is the build context |
| `instances` | `Record<region, number>` | Yes | Instances per region ID, each `0`–`100`. Vercel runs only in the listed regions |
| `command` | `string[]` | No | Replaces the image's `ENTRYPOINT` and `CMD`. Not run through a shell |
| `resources` | `{ requests: { memory } }` | No | `1Gi` (1 vCPU), `2Gi` (1 vCPU, default), `4Gi` (2 vCPU), `8Gi` (4 vCPU) |
| `terminationGracePeriodSeconds` | `number` | No | Seconds to wait after `SIGTERM` before terminating, `0`–`3600`, default `30` |

- **`instances` vs `replicas`**: the published `vercel.json` schema and the Build Output API use `instances`. `replicas` is a deprecated alias that is ignored when `instances` is set. If the project already uses `replicas`, leave it working, but write `instances` in new configuration.
- **Names**: lowercase letters only, joined by `_`, `__`, or one or more `-` (`worker`, `email_sender`, `celery-beat`; not `Worker`, `worker1`, `_worker`), 64 characters max. Two names that collapse to the same image repository once repeated hyphens are merged, such as `a-b` and `a--b`, fail the build. A daemon and a service may share a name.
- **Rejected fields**: service fields such as `framework`, `runtime`, `buildCommand`, and `bindings` fail validation on a daemon.
- **Build**: images are built for Linux `amd64`. Deployment environment variables are passed to the image build as build arguments.
- **Shell features**: `command` is exec-form. Use `["sh", "-c", "exec node worker.js --id $WORKER_ID"]` for variable expansion.
- **No `CMD`**: the build fails if the image has neither `ENTRYPOINT` nor `CMD` and `command` is not set.

```json filename="vercel.json"
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "daemons": {
    "celery": {
      "root": "backend/",
      "entrypoint": "Dockerfile",
      "command": ["celery", "-A", "app", "worker", "--loglevel=info"],
      "instances": { "iad1": 2, "cdg1": 1 },
      "resources": { "requests": { "memory": "4Gi" } }
    }
  }
}
```

## Lifecycle and Scaling

- **Production only during the beta.** Daemons run only for the production deployment. Preview deployments do not start daemons; test changes by running the image locally.
- **Rollout**: when a deployment becomes production (deploy, promote, Instant Rollback, or a completed rolling release), Vercel starts the new instances and sends `SIGTERM` to the previous deployment's instances. For a short time both versions run at once, so both must be able to consume the same queue and tolerate the same database schema.
- **Image, command, and environment variables** belong to the deployment. Change them with a new production deployment.
- **Scaling with `vercel.json`**: change `instances` and deploy to production. The map replaces the previous one; regions removed from it stop.
- **Scaling overrides**: in the project dashboard, **Daemons** → select the daemon → **Set Scaling Overrides**. Overrides persist across deployments and win over `instances` until cleared with **Clear scaling overrides**. If a `vercel.json` change to `instances` seems ignored, check for an override first. There is no autoscaling, and scaling from the CLI or API is not available yet.
- **Stop without deleting**: set every region to `0` or `instances` to `{}`, or set a `0` override from the dashboard.
- **Delete**: remove the daemon from `daemons` and deploy to production.
- **Paused projects** stop all daemon instances; they start again when the project resumes.

## Graceful Shutdown

Vercel sends `SIGTERM` on rollout, scale-down, removal, and manual restart, then waits 30 seconds by default (`terminationGracePeriodSeconds`, `0`–`3600`) before terminating the process. Stop taking new work immediately and finish the job in progress. Instances can stop at any time, so jobs must be idempotent and safe to retry; acknowledge a queue message only after processing it.

```ts
// worker/worker.ts
const shutdown = new AbortController();
process.on('SIGTERM', () => shutdown.abort());

async function main(): Promise<void> {
  while (!shutdown.signal.aborted) {
    await processNextJob(shutdown.signal); // bounded poll; back off when there is no work
  }
  process.exit(0);
}

void main();
```

```python
# worker/worker.py
import signal
from threading import Event

shutdown = Event()
signal.signal(signal.SIGTERM, lambda signum, frame: shutdown.set())

while not shutdown.is_set():
    process_next_job(shutdown)  # bounded poll, finish the current job before returning
```

## Consuming Vercel Queues From a Daemon

A daemon is the long-running consumer for [Vercel Queues poll mode](https://vercel.com/docs/queues/poll-mode). Use `PollingQueueClient` from `@vercel/queue` with an explicit region, because messages can only be received from the region they were sent to:

```ts
// worker/worker.ts
import { PollingQueueClient } from '@vercel/queue';

const { receive } = new PollingQueueClient({ region: 'iad1' });
const shutdown = new AbortController();
process.on('SIGTERM', () => shutdown.abort());

while (!shutdown.signal.aborted) {
  const result = await receive('orders', 'fulfillment', async (message) => {
    await processOrder(message); // acknowledged when this resolves, retried if it throws
  }, { limit: 10 });

  if (!result.ok && result.reason === 'empty') {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

Run the daemon in the same region the producer sends to. Topics are partitioned by deployment ID by default; read the poll-mode versioning section before relying on cross-deployment consumption. For the producer side and push-mode consumers, load `⤳ skill: queues`.

## Environment Variables and OIDC

- Each instance receives the deployment's environment variables.
- Each instance receives an OIDC token written to a file whose path is in `VERCEL_OIDC_TOKEN_FILE`, refreshed periodically. Read it with `@vercel/oidc` 4.0.0 or later (Node.js) or `vercel-oidc` 0.10.0 or later (Python). Older SDK versions that only read `VERCEL_OIDC_TOKEN` will not find it.

## Local Development

`vercel dev` does not run daemons; it prints a warning and starts the rest of the project. Run the daemon with Docker instead:

```bash
vercel env pull                       # writes .env.local
docker build -t worker worker/
docker run --env-file .env.local worker
```

## Logs and Observability

Daemon output appears in the project's Logs with source `daemon` and the daemon's name, so you can filter to one daemon. The project dashboard's **Daemons** tab shows each daemon's instances, status, and logs.

## Build Output API

With `vercel build` or a custom builder, `.vercel/output/config.json` lists daemons as `"daemons": { "worker": {} }` (the complete set; omitted daemons are stopped), and each has `.vercel/output/daemons/<name>/.vc-config.json` with `runtime: "container"`, an `image` already in Vercel Container Registry, `instances`, and optional `command`, `resources`, and `terminationGracePeriodSeconds`. `vercel build` builds and pushes the images and writes these files for you.

## Limits

| Limit | Value |
|-------|-------|
| Instances per region | 100 per daemon |
| Memory per instance | 1, 2 (default), 4, or 8 GiB |
| Shutdown grace period | 30 seconds after `SIGTERM` by default, configurable up to 3,600 seconds with `terminationGracePeriodSeconds` |
| CPU architecture | Linux `amd64` |

Default per-team quotas apply during the beta: Hobby is limited to 1–2 GiB instances and a monthly Active CPU-hour allowance (instances stop when it runs out), Pro allows all sizes up to a concurrent vCPU and memory cap, and Enterprise is custom. Check [Daemons limits](https://vercel.com/docs/daemons/limits) for the current numbers before sizing a deployment.

Not supported during the beta: preview deployments, inbound HTTP or TCP traffic, autoscaling, persistent local storage (use Vercel Blob or a Marketplace database), running in `vercel dev`, being the target of a service binding or rewrite, builds without a `Dockerfile`/`Containerfile`, and projects whose root directory is a subfolder such as `apps/web`.

## Common Pitfalls

1. **Expecting traffic**: a daemon that listens on a port receives nothing. Serve requests with Functions or Services, and have the daemon pull work.
2. **Testing on a preview**: daemons never start for preview deployments during the beta. Deploy to production or run the image locally.
3. **Ignored scaling change**: a dashboard scaling override wins over `instances` until it is cleared.
4. **Unsafe overlap**: old and new versions run side by side during a rollout. Keep message formats and schema migrations backward compatible.
5. **No SIGTERM handling**: the process is killed 30 seconds after `SIGTERM` (the default) unless `terminationGracePeriodSeconds` is raised. Make jobs idempotent and acknowledge only after completion.
6. **Shell syntax in `command`**: `$VAR` and `&&` are not expanded. Wrap in `sh -c`.
7. **Monorepo root directory**: projects with a subfolder root directory cannot add daemons yet.
8. **Stale OIDC SDK**: use `@vercel/oidc` ≥ 4.0.0 or `vercel-oidc` ≥ 0.10.0 so the token file is read.

## References

- 📖 docs: https://vercel.com/docs/daemons
- 📖 configuration reference: https://vercel.com/docs/daemons/config-reference
- 📖 managing daemons: https://vercel.com/docs/daemons/managing-daemons
- 📖 limits and quotas: https://vercel.com/docs/daemons/limits
- 📖 Build Output API: https://vercel.com/docs/build-output-api/daemons
- 📖 Queues poll mode: https://vercel.com/docs/queues/poll-mode
- 📖 Functions vs containers vs Daemons: https://vercel.com/kb/guide/vercel-functions-containers-daemons
