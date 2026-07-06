---
name: cdn-caching
description: Debug Vercel CDN caching — cache hit rate, stale content, revalidation, ISR + PPR, per-request cache reasons (cacheReason), and ISR cost.
metadata:
  priority: 6
  docs:
    - 'https://vercel.com/docs/caching'
    - 'https://vercel.com/docs/incremental-static-regeneration'
    - 'https://vercel.com/docs/cli/metrics'
    - 'https://vercel.com/docs/cli/logs'
  bashPatterns:
    - '\bvercel\s+cache\s+(purge|invalidate|dangerously-delete)\b'
  promptSignals:
    phrases:
      - 'cache hit rate'
      - 'isr cost'
      - 'stale content'
      - 'x-vercel-cache'
      - 'cache reason'
      - 'stale_tag'
      - 'request collapsed'
    allOf:
      - [cache, debug]
      - [stale, cache]
      - [why, stale]
      - [why, bypass]
      - [cache, miss]
      - [cache, reason]
    anyOf:
      - 'revalidate'
      - 'invalidate'
      - 'crawler'
      - 'cold cache'
    minScore: 6
retrieval:
  aliases:
    - cache reason
    - cache hit rate
    - stale content
  intents:
    - why is my page stale
    - why is this request a bypass
    - why was this a cache miss
  entities:
    - cacheReason
    - stale_tag
    - stale_error
    - draft_mode
    - prerender_bypass
    - crawler
    - cold
chainTo:
  -
    pattern: 'use cache|cacheLife|cacheTag'
    targetSkill: next-cache-components
    message: 'Next.js cache directives detected — loading Cache Components guidance.'
---

# Vercel Caching

Expert guidance on Vercel's CDN Cache, ISR, and PPR: hit rate, stale content, revalidation, per-request cache reasons, and ISR cost. ISR/PPR are framework features (Next.js, SvelteKit, Nuxt, Astro) — the layers, metrics, and CLI below apply to all.

## How caching works

A request reaches the nearest PoP → a Vercel region; the CDN checks each layer in order and returns the first cached copy, so your function runs only on a full miss.

- **CDN cache** — regional, ephemeral, free reads/writes. A HIT returns with no function call.
- **ISR cache** — durable, single region. Read on a CDN miss before invoking your function (shielding); billed in 8 KB units; survives deploys 31 days or until revalidated.
- **Function** — runs only if neither cache has a valid copy; its result is stored in ISR.
- **Request collapsing** — concurrent requests to one uncached path collapse into a single origin invocation per region.
- **PPR** — the static shell lives in the ISR cache; the function fills dynamic holes per request. A holeless route is plain ISR (a `prerender` HIT).

## Cache status vs. cache reason

**Status** (`x-vercel-cache`) is the _outcome_; **reason** (`cacheReason`, in logs) is _why_. The reason is the only way to tell three `STALE`s — or three `MISS`es — apart, since the `cache_result` metric lumps them together.

| Status | Meaning |
| --- | --- |
| `HIT` | Served from cache; no function ran |
| `MISS` | Not cached; origin/function ran |
| `STALE` | Served stale while revalidating in background (SWR) |
| `PRERENDER` | Served a prerendered ISR/PPR shell |
| `REVALIDATED` | Foreground regen after a delete (or `Pragma: no-cache`) |
| `BYPASS` | Caching skipped (`no-store`, `private`, cookies, etc.) |

| `cacheReason` | Refines | Meaning |
| --- | --- | --- |
| `cold` | MISS | Cache empty for this key/variant (first request or evicted) |
| `collapsed` | MISS | Concurrent requests collapsed into one origin invocation |
| `error` | MISS | An error prevented serving from cache |
| `draft_mode` | → BYPASS | Next.js Draft Mode active — bypassed so editors see live content |
| `prerender_bypass` | → BYPASS | Prerender-bypass cookie/token present |
| `crawler` | → BYPASS | SEO-crawler UA — full response served so bots index real content |
| `stale_time` | STALE | Time-based `revalidate` interval elapsed; regenerating (SWR) |
| `stale_tag` | STALE | Tag invalidated (`revalidateTag`/`invalidateByTag`); regenerating |
| `stale_error` | STALE | Revalidation **failed**; serving last-good copy (a bug signal) |

A raw `MISS` with `draft_mode` / `prerender_bypass` / `crawler` is **displayed as `BYPASS`** (all usually expected). The `stale_*` reasons separate a healthy time refresh (`stale_time`) from a broad-tag blast (`stale_tag`) from a failing regen (`stale_error`).

## Investigating

`vercel metrics` gives aggregates (needs Observability Plus); `vercel logs` shows per-request behavior. Query metrics by `-S <team> -p <project>`, filter prod with `-f "environment eq 'production'"`, add `-F json` for machine output.

- **Hit rate** — group `vercel.request.count` by `cache_result` (HIT/STALE/PRERENDER = served; focus `MISS`; exclude `BYPASS`). Split `MISS` by `path_type`, then `request_path`.
- **ISR cost** — focus `vercel.isr_operation.write_units` (charged on every regen); the CDN shields ISR so `read_units` run far below request count. Group write_units by `cache_tags` — unrelated routes with near-identical counts mean a shared broad tag firing in lockstep. Confirm by grepping the `revalidateTag(` / `invalidateByTag(` / `updateTag(` call site.
- **BYPASS** — mostly Draft Mode + crawlers (expected); group by `bot_category` / `user_agent` to see what's left. Manage bots with the `vercel-firewall` skill.

```bash
vercel metrics vercel.request.count -S <team> -p <project> --group-by cache_result --since 24h
vercel metrics vercel.isr_operation.write_units -S <team> -p <project> -a sum --group-by cache_tags --since 24h
```

**One request** — `curl -sSI <url>` shows `x-vercel-cache`, `x-matched-path` (reveals experiment precompute), `vary`, and `set-cookie` (forces BYPASS). For the reason, read logs — the `x-vercel-cache-reason` header is internal-only and not visible via curl:

```bash
vercel logs <url> --json | jq -r 'select(.cacheReason!="") | .cacheReason' | sort | uniq -c | sort -rn
```

## Reducing ISR cost

- Prefer tag-based on-demand revalidation over short time intervals (which regen whether content changed or not).
- Scope tags to IDs (`product-${id}`), not broad `page` / `blogPost` tags with a large blast radius.
- Tune the revalidate interval where the framework declares it; for Next.js `use cache` / `cacheLife`, see `next-cache-components`.

## Related skills

- `next-cache-components` — Next.js `use cache`, `cacheLife`, `cacheTag`, `revalidate` tuning.
- `runtime-cache` — per-region key-value cache between a function and a backend.
- `vercel-firewall` — verified crawlers, bot blocking, rate limits.

## References

- https://vercel.com/docs/caching · /incremental-static-regeneration · /partial-prerendering · /cli/metrics · /cli/logs
