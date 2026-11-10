# Measure and improve performance with custom spans

Use this reference when a user wants to make a server route, API, function, or server-rendered page faster. Measure first: wrap each suspected operation in a custom span, deploy, read exact durations from traces, change the slowest operation on the critical path, then measure again. Do not optimize from intuition or from total request time alone.

This only works for routes that run server code on each request. Static and prerendered pages and CDN cache hits produce no server spans, so tracing cannot speed them up. Browser rendering, bundle size, and Core Web Vitals need browser profiling, not server spans.

## 1. Pick the request and list its operations

1. Identify the slow route or function, its environment, and an example input. Find recent slow requests with [search](search.md) when collection is already on:

   ```bash
   vercel traces search --scope my-team --project my-app --environment production --query 'span.duration > 1000' --kind server --since 1h --json
   ```

2. Read the handler and list each awaited operation that could cost time: database queries, external API calls, cache reads, file or blob I/O, rendering, serialization, and CPU-heavy loops. Note which run sequentially and which run in parallel.
3. Check what is already measured. Automatic outbound-fetch spans time the function's outbound HTTP requests; Next.js emits route and render spans once [instrumented](instrumentation.md). Turn on [library spans](library-spans.md) for installed libraries that are missing them, such as AI SDK calls or database queries. Add custom spans only for operations that are not already visible.

## 2. Wrap each operation in a span

Add the `measure` helper from [custom spans](custom-spans.md), then wrap the operations in the existing handler, keeping their order and concurrency:

```ts
import { measure } from './lib/measure';

const user = await measure('checkout.load-user', { 'user.id': userId }, () => getUser(userId));
const [cart, prices] = await Promise.all([
  measure('checkout.load-cart', { 'cart.id': cartId }, () => getCart(cartId)),
  measure('checkout.fetch-prices', { 'price.count': skus.length }, () => fetchPrices(skus)),
]);
const order = await measure('checkout.create-order', {}, () => createOrder(user, cart, prices));
```

Adapt names and calls to the application, following the naming and attribute rules in [custom spans](custom-spans.md). For measurement:

- Add attributes that explain cost, such as row counts, payload bytes, or item counts.
- Wrap operations, not tight inner loops; time the whole loop once instead.

## 3. Collect durations from deployed traffic

Local timing does not reflect Vercel regions, cold starts, or network distance. Deploy to preview, or production when authorized, then capture requests:

```bash
vercel traces create /api/checkout --deployment https://my-app-abc123.vercel.app --scope my-team --json
```

Repeat the capture several times with the same input to see variance, or let always-on tracing gather real traffic. Then read the measured spans. `span.duration` is in milliseconds:

```bash
vercel traces search --scope my-team --project my-app --query 'span.name:checkout.*' --since 1h --limit 500 --json \
  | jq -r 'select(.type == "span") | [.data.span.name, .data.span.duration] | @tsv'
```

The final `summary` line reports `pagination.hasMore`; when it is `true`, continue with `--next` before treating the durations as complete. See [search](search.md#read-the-output).

For one request, start with the default [summary](inspection.md#output-formats):

```bash
vercel traces inspect 0870e4ead46aafba39ccfbcb001835db --scope my-team --project my-app
```

To sort every span by duration, use `--json`, which reports durations as `[seconds, nanoseconds]`:

```bash
vercel traces inspect 0870e4ead46aafba39ccfbcb001835db --scope my-team --project my-app --json 2>/dev/null \
  | jq -r '.spans[] | [((.duration[0] * 1000) + (.duration[1] / 1e6)), .name] | @tsv' | sort -rn
```

To see which spans are sequential, add `--open --view=waterfall`; see [inspection](inspection.md#choose-the-view).

## 4. Find the operation to change

- Fix the critical path. A slow span that overlaps a slower one does not shorten the request.
- Compare each span with its parent. A large gap between the parent's duration and its children means unmeasured work: add another span there and measure again before changing code.
- Look for these common causes: sequential awaits that could run in parallel, the same query or fetch repeated per item (N+1), uncached repeated calls, large payloads, and cold connections to a database or API.
- Write down a baseline for each key span from equivalent requests: route, input, environment, and request count. A few samples are not a full latency distribution; say how many you used.

## 5. Change one thing and compare

Change the slowest operation on the critical path, keep its span in place, deploy, and capture equivalent requests with the same input and collection settings. Report before and after durations for that span and for the whole request, the sample counts, and any errors. If the fix ships before deployed numbers exist, name the spans to compare and the expected result, for example "`checkout.handler` should drop from about the sum of the three child spans to about the longest one." If the time moved to another span instead of disappearing, say so.

Keep spans that will be useful later. Remove only noisy, temporary spans after the investigation.
