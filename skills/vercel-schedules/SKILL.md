---
name: vercel-schedules
description: Vercel Schedules guidance — run a private function, route, or Vercel Queues topic on a cron cadence or once at a set time. Covers static schedules in vercel.json, dynamic per-user schedules with @vercel/schedules, handleSchedule, the vercel schedules CLI, environments, jitter, and migrating from Cron Jobs. Use when adding scheduled or recurring work, one-time reminders, or replacing `crons`.
summary: "Vercel Schedules (beta) replaces Cron Jobs. Static schedules go in vercel.json under `schedules` and target a private `function` (with an `experimentalTriggers: [{ type: 'schedule/v1beta' }]` trigger), a public `path`, or a queue `topic`. Dynamic schedules come from `Schedules.create()` in `@vercel/schedules@alpha` or `vercel schedules create`, target queue topics only, and support one-time runs, payloads, and namespaces. Wrap function handlers in `handleSchedule`; make handlers idempotent with `executionId`."
metadata:
  priority: 6
  docs:
    - "https://vercel.com/docs/schedules"
    - "https://vercel.com/docs/schedules/quickstart"
    - "https://vercel.com/docs/schedules/handle-runs"
    - "https://vercel.com/docs/schedules/configuration"
    - "https://vercel.com/docs/schedules/sdk"
    - "https://vercel.com/docs/cli/schedules"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns:
    - 'vercel.json'
    - 'app/api/schedules/**'
    - 'src/app/api/schedules/**'
    - 'api/schedules/**'
    - 'lib/schedules.*'
    - 'src/lib/schedules.*'
    - 'lib/schedules/**'
    - 'src/lib/schedules/**'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*@vercel/schedules\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@vercel/schedules\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@vercel/schedules\b'
    - '\byarn\s+add\s+[^\n]*@vercel/schedules\b'
    - '\b(vercel|vc)\s+schedules\b'
  importPatterns:
    - "@vercel/schedules"
  promptSignals:
    phrases:
      - "vercel schedules"
      - "@vercel/schedules"
      - "handleSchedule"
      - "scheduled job"
      - "scheduled jobs"
      - "scheduled task"
      - "recurring job"
      - "one-time schedule"
      - "migrate cron jobs"
    allOf:
      - [vercel, schedule]
      - [vercel, cron]
      - [run, every, hour]
      - [run, every, day]
      - [run, every, night]
      - [send, reminder, later]
      - [per, user, schedule]
      - [schedule, each, user]
      - [vercel, every]
    anyOf:
      - "schedule"
      - "cron"
      - "recurring"
      - "nightly"
      - "hourly"
      - "timezone"
      - "reminder"
    noneOf:
      - "schedule a meeting"
      - "calendar event"
      - "deployment schedule"
      - "release schedule"
    minScore: 6
retrieval:
  aliases:
    - schedules
    - cron
    - cron jobs
    - scheduled functions
    - recurring jobs
    - one-time jobs
  intents:
    - run code on a schedule
    - run a function every hour
    - send a reminder at a specific time
    - create a schedule for each user
    - migrate cron jobs to schedules
    - pause or run a schedule now
  entities:
    - Vercel Schedules
    - "@vercel/schedules"
    - handleSchedule
    - schedule/v1beta
    - Schedules.create
    - vercel schedules
chainTo:
  -
    pattern: 'from\s+[''"](node-cron|cron|croner|node-schedule|agenda)[''"]|cron\.schedule\('
    targetSkill: vercel-schedules
    message: 'In-process cron scheduling detected — it never runs on Vercel, because functions are not long-lived. Loading Vercel Schedules guidance.'
    skipIfFileContains: '@vercel/schedules'
  -
    pattern: '"crons"\s*:'
    targetSkill: vercel-schedules
    message: 'Cron Jobs config detected — Schedules replaces Cron Jobs and adds timezones, private targets, and per-environment state. Loading Vercel Schedules guidance.'
    skipIfFileContains: '"schedules"\s*:'

---

# Vercel Schedules

You are an expert in Vercel Schedules, which runs code on a recurring cron cadence or once at a specific time.

Schedules is in **beta** and replaces Cron Jobs. During the beta, deployments that declare schedules fail unless the team has access, and the SDK is published under the `alpha` tag (`@vercel/schedules@alpha`). Check https://vercel.com/docs/schedules when details matter. Behavior and limits can change before GA.

## Choose static or dynamic

| | Static | Dynamic |
|---|---|---|
| **Defined in** | `vercel.json` `schedules` (or Build Output API `config.json`) | `@vercel/schedules` SDK or `vercel schedules` CLI |
| **Takes effect** | When the deployment becomes current for its environment/branch | Immediately |
| **Targets** | `function`, `path`, or `topic` | `topic` only |
| **One-time runs** | No | Yes |
| **Payload / namespace** | No / always `default` | Optional JSON (≤ 8 KB) / any namespace |
| **Update or delete** | Edit config and redeploy | SDK or CLI |

Use **static** for jobs that belong to the app (nightly cleanup, hourly sync). Use **dynamic** for jobs the app creates for users (a reminder per customer, a report at 09:00 in each tenant's timezone).

## Choose a target

| Target | Use when | Retries |
|---|---|---|
| **`function`** (default choice) | Private work nobody else should call. No public URL, no secret needed. | No |
| **`path`** | Migrating an existing Cron Job, or the route must stay public. Protect it with `CRON_SECRET`. | No |
| **`topic`** | Failed runs must be retried, you need a payload, or the schedule is dynamic. | Yes, via Queues |

If a failed run must be retried, target a queue topic.

## Quickstart: private function on a static schedule

```bash
npm i @vercel/schedules@alpha
```

```ts
// api/cleanup.ts
import { handleSchedule } from '@vercel/schedules';

export const POST = handleSchedule(async (metadata) => {
  console.log(`${metadata.name} run ${metadata.executionId} for ${metadata.scheduledAt.toISOString()}`);
  await deleteExpiredRecords();
});
```

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/cleanup.ts": {
      "experimentalTriggers": [{ "type": "schedule/v1beta" }]
    }
  },
  "schedules": {
    "cleanup": {
      "schedule": "0 * * * *",
      "function": "api/cleanup"
    }
  }
}
```

Test locally, then deploy:

```bash
vercel dev                                 # starts a local scheduler
vercel schedules invoke cleanup --local    # second terminal: run it now
vercel deploy --prod
vercel schedules invoke cleanup            # run once in production
```

### Rules that break deployments

- `function` is the **build output path** relative to `.vercel/output/functions`, without `.func` — not the source filename. `api/jobs/report.ts` → `api/jobs/report`. When unsure, run `vercel build` and look in `.vercel/output/functions`.
- The target function must declare `{ "type": "schedule/v1beta" }`, and it must be its **only** trigger. It can't also have a `queue/v2beta` trigger.
- Don't add routes or rewrites to a `schedule/v1beta` function. It is private by design.
- For a function in a [service](https://vercel.com/docs/services), set `service` plus `function` relative to `.vercel/output/services/<name>/functions`. `vercel dev` can't run these yet (`DEV_SCHEDULE_SERVICE_FUNCTION_UNSUPPORTED`).
- Set exactly one of `function`, `path`, or `topic`.
- A framework's Build Output API schedules and `vercel.json` schedules with the same name fail with `SCHEDULE_NAME_CONFLICT`.

## Static schedule properties

| Property | Notes |
|---|---|
| `schedule` | Required. Five-field cron, evaluated in `timezone`. |
| `timezone` | IANA name such as `America/New_York`. Defaults to `UTC`. Follows DST. |
| `jitter` | Minutes, 1–15. Defaults to 1 on Pro/Enterprise. Hobby is always 15. |
| `function` / `service` | Private function target (see rules above). |
| `path` / `requestMethod` | Public route target. Path must start with `/`. Method defaults to **`POST`**. |
| `topic` | Vercel Queues topic. Letters, digits, `_`, `-`. |

The object key is the schedule name: 1–256 chars of ASCII letters, digits, `.`, `_`, `-`, starting with a letter or digit. **Keep names stable.** Renaming deletes the schedule and creates a new one with fresh state and history. A project can have up to 100 static schedules.

Cron syntax: digits, `*`, `,`, `-`, `/` only. No `MON`/`JAN` names, and don't set both day-of-month and day-of-week.

## Path targets

```json
{
  "schedules": {
    "daily-report": { "schedule": "0 9 * * *", "path": "/api/daily-report", "requestMethod": "GET" }
  }
}
```

```ts
// api/daily-report.ts
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  await sendReport();
  return new Response(null, { status: 200 });
}
```

`CRON_SECRET` should be a random string of at least 16 characters. `handleSchedule` also works on path routes (`GET` or `POST`), but it does **not** check `CRON_SECRET`, so keep the check. Function targets never receive `authorization` or Cron Job headers, so don't require them there.

## Queue targets and dynamic schedules

The consumer is a normal Vercel Queues consumer (`⤳ skill: queues`):

```ts
// api/reminders.ts
import { handleCallback } from '@vercel/queue';

interface ScheduleQueueMessage {
  scheduleId: string;
  executionId: string;
  name: string;
  namespace: string;
  scheduledAt: string; // ISO 8601, excludes jitter
  source: 'static' | 'dynamic';
  payload?: { userId: string };
}

export const POST = handleCallback(async (message: ScheduleQueueMessage) => {
  await sendReminder(message.payload!.userId, message.executionId);
});
```

```json
{
  "functions": {
    "api/reminders.ts": {
      "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "reminders" }]
    }
  }
}
```

Create schedules at runtime from app code. The SDK authenticates with the deployment's OIDC token and acts on that deployment's environment or branch:

```ts
import { Schedules, SchedulesApiError } from '@vercel/schedules';

// Recurring, per tenant
await Schedules.create({
  namespace: `tenant-${tenantId}`,
  name: 'daily-digest',
  target: { topic: 'digests' },
  expression: { type: 'cron', cron: '0 9 * * *' },
  timezone: tenant.timezone,
  payload: { tenantId },
});

// One-time, local date and time in `timezone` (no Z, no offset)
await Schedules.create({
  name: `reminder-${reminderId}`,
  target: { topic: 'reminders' },
  expression: { type: 'single', at: '2026-11-01T09:00' },
  timezone: 'America/New_York',
  payload: { userId },
});

// Idempotent create
try {
  await Schedules.create({ /* ... */ });
} catch (error) {
  if (!(error instanceof SchedulesApiError && error.code === 'schedule_already_exists')) throw error;
}
```

Other methods: `get`, `list` (paginate with `cursor`), `update` (dynamic only, can't switch cron ↔ one-time), `enable` (optionally `until`), `disable`, `invoke` (run now), `delete` (dynamic only). Use one namespace per tenant so a tenant's schedules can be listed and cleaned up together.

## Handlers must be idempotent

- A run can be delivered more than once, and queue targets retry. `executionId` is the same for every delivery of an occurrence. Record it and skip repeats.
- After an outage, every unexpired occurrence is delivered, so a frequent schedule can fire several times in a row. If the work only makes sense near its scheduled time, compare `scheduledAt` to now and return early.
- Runs are independent. A slow run doesn't delay the next one, so runs can overlap. Guard shared resources.
- Function and path targets are **not retried**. A thrown error becomes a `500` in execution history, and that's it.

## Environments

Vercel keeps separate schedules for production, each custom environment, each Preview branch, and CLI deployments per user.

- Static schedules apply when a deployment becomes current, including promotions and rollbacks.
- New static schedules start **active in production** and **inactive in Preview and custom environments**. Enable them in the dashboard or with `vercel schedules enable <name> --git-branch <branch> --for 2h`.
- Enabled/disabled state persists across later deployments.
- The CLI defaults to production. Use `--environment`, `--git-branch`, `--user`, or `--local` to pick another set.

## Jitter and plan limits

| | Hobby | Pro / Enterprise |
|---|---|---|
| Jitter window | Always 15 min | 1–15 min, default 1 |
| Most frequent cron | Every 15 min | Every minute |
| Schedules per team | 1,000 | 10,000 / 100,000 |

The shortest interval between runs must be at least the jitter window (`jitter_exceeds_cadence`). On Hobby, omit `jitter` or set it to `15`. Downgrading to Hobby deletes schedules that run more often than every 15 minutes or set `jitter` below 15.

## Migrate from Cron Jobs

Replace each `crons` entry with a named `schedules` entry. Keep `path` and `schedule`, and add `"requestMethod": "GET"`, because Cron Jobs send `GET` and path schedules default to `POST`. **Remove `crons` in the same change**, or the route runs twice. Existing `CRON_SECRET` checks and `vercel-cron/1.0` headers keep working. Leave `timezone` unset to keep UTC run times. Later, switch to a private `function` target with the **same name** so the schedule keeps its state.

## Never do this on Vercel

- `node-cron`, `setInterval`, or any in-process scheduler. Functions aren't long-lived, so they never fire reliably.
- A public route with no `CRON_SECRET` check as a schedule target. Use a `function` target instead.
- Renaming a schedule to "fix" it. That resets its state and history.

## Manage and debug

```bash
vercel schedules list
vercel schedules inspect cleanup --json
vercel schedules executions list cleanup --since 7d
vercel schedules disable cleanup
vercel schedules enable cleanup --for 2h
vercel schedules invoke cleanup
vercel schedules create send-reminder --at 2026-11-01T09:00 --timezone America/New_York --topic reminders
```

In the dashboard, open the project and select **Schedules** to see next run times, execution history, and **Run Schedule**.

Common SDK error codes: `not_enabled` (team lacks beta access), `invalid_cron_expression`, `invalid_jitter`, `jitter_exceeds_cadence`, `single_at_in_past`, `payload_too_large`, `static_schedule` (tried to update/delete a static one), `rate_limited` (wait `retryAfter` seconds).

## Related

- `⤳ skill: queues` for queue consumers, retries, and idempotency
- `⤳ skill: workflow` for multi-step durable logic triggered by a schedule
- `⤳ skill: vercel-functions` for function runtime and duration limits
- [Schedules docs](https://vercel.com/docs/schedules)
