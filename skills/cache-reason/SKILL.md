---
name: cache-reason
description: Explain the per-request Vercel cache reason (cold, collapsed, stale_tag, draft_mode, crawler…) — why a single request was a MISS, STALE, or BYPASS.
metadata:
  priority: 6
  docs:
    - 'https://vercel.com/docs/caching'
    - 'https://vercel.com/docs/caching/cdn-cache/debug-cache-issues'
    - 'https://vercel.com/docs/cli/logs'
  bashPatterns:
    - '\bvercel\s+logs\b'
  promptSignals:
    phrases:
      - 'cache reason'
      - 'x-vercel-cache-reason'
      - 'why is it stale'
      - 'why is my page stale'
      - 'stale_tag'
      - 'stale_time'
      - 'stale_error'
      - 'prerender bypass'
      - 'request collapsed'
    allOf:
      - [why, bypass]
      - [why, stale]
      - [cache, reason]
    anyOf:
      - 'draft mode'
      - 'crawler'
      - 'revalidation'
      - 'cold cache'
    minScore: 6
retrieval:
  aliases:
    - cache reason
    - x-vercel-cache-reason
    - stale reason
    - bypass reason
    - cache miss reason
  intents:
    - why is my page stale
    - why is this request a bypass
    - why was this a cache miss
    - explain the cache status of a request
    - debug why a request was not cached
  entities:
    - cacheReason
    - stale_tag
    - stale_time
    - stale_error
    - draft_mode
    - prerender_bypass
    - crawler
    - request collapsed
    - cold cache
chainTo:
  -
    pattern: 'revalidateTag|invalidateByTag|updateTag|dangerouslyDeleteByTag'
    targetSkill: cdn-caching
    message: 'Tag invalidation detected — loading cdn-caching for blast-radius and ISR write-cost analysis.'
---

# Vercel Cache Reason

You are an expert in Vercel's per-request **cache reason** — the field that explains *why* a single request produced the cache status it did.

## What cache reason is

Every proxied request carries two related signals:

- **Cache status** (`x-vercel-cache` / the `cache` field, and the `cache_result` metrics dimension) — the *outcome*: `HIT`, `MISS`, `STALE`, `PRERENDER`, `REVALIDATED`, `BYPASS`.
- **Cache reason** (`cacheReason`) — the *explanation* that refines that outcome for one request: `cold`, `collapsed`, `error`, `draft_mode`, `prerender_bypass`, `crawler`, `stale_time`, `stale_tag`, `stale_error`.

Cache reason is **per-request**, not aggregate. The `cache_result` metrics bucket lumps every `STALE` together; the reason tells you whether that stale served because a timer elapsed, a tag was invalidated, or a revalidation errored — the distinction you actually need to fix stale-content and ISR-cost problems. For aggregate hit-rate and ISR read/write **cost** analysis, use the `cdn-caching` skill; this skill is for *why one request behaved the way it did*.

## The nine reasons

Grouped by the status each one refines.

### MISS — nothing cacheable was served

| `cacheReason` | Label | Meaning | Typical fix |
| --- | --- | --- | --- |
| `cold` | Cold | Cache empty for this key/variant — first request, or the entry was evicted. The function ran to generate it. | Expected on first hit. Persistent `cold` on low-traffic paths usually means **too many cache-key variants** (flag/experiment precomputation, dynamic params) that never stay warm — collapse the variant matrix. |
| `collapsed` | Request Collapsed | Many concurrent requests hit the same uncached path at once; Vercel collapsed them into **one** origin invocation per region. The waiters report `collapsed`. | This is origin protection working as intended. Only a concern if a single hot path is constantly cold (see `cold`). |
| `error` | Error | An error path (e.g. an internal cache-layer error) prevented serving from cache. | Investigate the function/origin logs for that request — pair with `vercel logs`. |

### BYPASS — caching intentionally skipped

A raw status of `MISS` is **displayed as `BYPASS`** when the reason is one of these three. All are usually expected, not misconfiguration:

| `cacheReason` | Label | Meaning | Typical fix |
| --- | --- | --- | --- |
| `draft_mode` | Draft Mode | Next.js **Draft Mode** is active, so cache is bypassed and editors see live content. | Expected for preview/editing sessions. If unexpected in production, a Draft Mode cookie is leaking to real users. |
| `prerender_bypass` | Prerender Bypass | A prerender-bypass cookie/token is present, so prerendered content is bypassed. | Expected during on-demand preview. Check for a stale/leaked bypass cookie if seen broadly. |
| `crawler` | Crawler | An SEO-crawler user-agent was detected; the prerender fallback is skipped so the bot receives the **full** response (important on PPR routes). | Expected. Manage verified crawlers with the `vercel-firewall` skill. |

### STALE — served last-good copy while revalidating (SWR)

The status is `STALE` for all three; the reason is the only way to tell them apart:

| `cacheReason` | Label | Meaning | Typical fix |
| --- | --- | --- | --- |
| `stale_time` | Time-based revalidation | The time-based `revalidate` interval elapsed; the stale copy served while a fresh one regenerates in the background. | If write cost is high, the interval is too short for how often content actually changes — prefer tag-based on-demand invalidation. |
| `stale_tag` | Tag-based invalidation | A cache tag was invalidated (`revalidateTag` / `invalidateByTag`); stale served while regenerating. | If **unrelated** routes go `stale_tag` together, a broad tag has a large blast radius — scope tags to specific IDs (`product-${id}`). |
| `stale_error` | Revalidation error | A revalidation attempt **failed**; Vercel keeps serving the last-good copy rather than an error. | This is a real bug signal — the regeneration is throwing. Read the function logs for that route. |

> **Key rule:** `MISS` + `draft_mode` / `prerender_bypass` / `crawler` → shown as `BYPASS`. So a "BYPASS" in the dashboard is one of those three reasons; the "Debugging BYPASS traffic" section of `cdn-caching` covers the aggregate view.

## How to see the cache reason

Cache reason is available to **every** Vercel user through logs — you do **not** need any special access.

**1. Dashboard (fastest for one request).** Observability → **Logs** → open a request → the **Reason** row (under the Cache event) shows the human-readable label and a "Learn more" link.

**2. `vercel logs` (agent-friendly).** The CLI surfaces `cacheReason` per request. Use JSON so it can be parsed:

```bash
# Cache reason for recent requests to a deployment
vercel logs <deployment-url> --json | jq -r '{path: .requestPath, cache: .cache, reason: .cacheReason}'

# Only the requests that carry a reason, tallied
vercel logs <deployment-url> --json \
  | jq -r 'select(.cacheReason != null and .cacheReason != "") | .cacheReason' \
  | sort | uniq -c | sort -rn
```

> **Do not tell users to `curl` for it.** The `x-vercel-cache-reason` **response header** is an internal debug header — it is gated (only emitted to allowlisted teams/builds) and will **not** appear in a normal `curl -I`. Use the Logs panel or `vercel logs` instead. Cache reason is also **not** a `vercel metrics` dimension (metrics exposes `cache_result` = status only); reason is per-request, so it lives in logs.

## From reason to action

- Repeated `stale_tag` across many unrelated routes → an over-broad cache tag. Grep the invalidation call site (`revalidateTag(`, `invalidateByTag(`, `updateTag(`) and scope it; then quantify write cost with `cdn-caching` → "Analyzing ISR costs".
- Persistent `cold` on many distinct variants → cache-key explosion (feature-flag/experiment precomputation, unbounded dynamic params). Collapse the matrix or retire finished experiments.
- Any `stale_error` → revalidation is failing; the page is silently frozen on old content. Read the route's function logs (`vercel logs --json`) for the throwing regeneration.
- Unexpected `draft_mode` / `prerender_bypass` in production → a preview/bypass cookie is reaching real users; audit where it's set.

## Related skills

- `cdn-caching` — aggregate cache hit rate, stale content, and ISR read/write **cost** via `vercel metrics` (`cache_result`, `isr_operation.*`). Use it once cache reason tells you *which* behavior to quantify.
- `next-cache-components` — Next.js `use cache`, `cacheLife`, `cacheTag`, and `revalidate` tuning (where `stale_time` / `stale_tag` originate in a Next.js app).
- `runtime-cache` — per-region data cache between your function and a backend (a different layer from CDN/ISR).
- `vercel-firewall` — manage verified SEO crawlers and abusive bots behind `crawler` BYPASS traffic.

## References

- Caching overview: https://vercel.com/docs/caching
- Diagnosing and fixing cache issues (full runbook): https://vercel.com/docs/caching/cdn-cache/debug-cache-issues
- Incremental Static Regeneration: https://vercel.com/docs/incremental-static-regeneration
- vercel logs CLI: https://vercel.com/docs/cli/logs
