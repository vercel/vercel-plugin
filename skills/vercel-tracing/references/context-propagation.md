# Context propagation

Use this reference when related operations appear in disconnected traces or beneath an unexpected parent. Propagation needs both sides: the caller injects `traceparent` into the outgoing request, and the receiver extracts it. If either side is missing, each service produces its own trace.

## Outgoing requests

`@vercel/otel` instruments global `fetch` and Node's `http`/`https` modules, so libraries built on them, such as axios on Node, are covered too. By default it sends context only to the deployment's own host (`VERCEL_URL`, `VERCEL_BRANCH_URL`, or the incoming request's host). Calls to another Vercel project, a custom domain, or an external service need an explicit allow rule.

Merge fetch settings into the existing `registerOTel` call, using the application's actual destinations:

```ts
import { registerOTel } from '@vercel/otel';

registerOTel({
  serviceName: 'checkout',
  instrumentationConfig: {
    fetch: {
      propagateContextUrls: ['https://api.example.com/', /^https:\/\/[a-z0-9-]+\.example\.com\//],
      dontPropagateContextUrls: ['https://api.example.com/public/'],
      ignoreUrls: ['https://health.example.com/'],
    },
  },
});
```

String matchers are prefixes of the full URL, including the scheme. `'api.example.com'` never matches `https://api.example.com/orders`, so headers are silently not sent. Use a full origin such as `'https://api.example.com/'` or a regular expression. Use `'*'` only when every destination is trusted.

- `propagateContextUrls` sends context headers to matching URLs.
- `dontPropagateContextUrls` blocks headers and wins over `propagateContextUrls`; the call is still traced.
- `ignoreUrls` skips tracing the call entirely.

To override one call, pass `fetch(url, { opentelemetry: { propagateContext: true } })`. Next.js needs version 14.1.1 or later for this option. See the [`@vercel/otel` options](https://github.com/vercel/otel/blob/main/packages/otel/README.md).

Avoid sending `traceparent` to third parties that do not need it; it exposes trace IDs and can make their tracing join yours.

## Clients and transports that are not instrumented

Inject the context manually for clients that do not use `fetch` or `node:http`, such as gRPC, WebSocket messages, queue messages (including Vercel Queues), and workflow steps:

```ts
import { context, propagation } from '@opentelemetry/api';

const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
await queue.send({ payload, trace: carrier });
```

Adapt `queue.send` to the actual client. Put the carrier where the transport carries metadata: message attributes, gRPC metadata, or a field in the payload. Inject while the active span is the one that should become the parent. The consumer extracts the carrier with `propagation.extract` and runs its work inside `context.with`, as shown below.

## Incoming requests

Next.js 14.0.1+ and SvelteKit with `tracing.server` enabled extract incoming context automatically. Prefer the framework's tracing integration when it already does this. Otherwise, extract the headers and run the existing handler inside that context:

```ts
import { context, propagation } from '@opentelemetry/api';
import { handleCheckout } from './checkout-handler';

export function handleRequest(request: Request): Promise<Response> {
  const parent = propagation.extract(
    context.active(),
    Object.fromEntries(request.headers),
  );
  return context.with(parent, () => handleCheckout(request));
}
```

Adapt the handler and the header carrier to the framework; not every framework exposes a Web `Headers` object. For middleware, call the framework's `next()` or equivalent inside the `context.with` callback, keeping awaited work and the existing middleware chain inside it, so later handlers and their spans inherit the extracted parent.

## Sampling across services

When a request arrives with `traceparent`, Vercel combines the inbound decision with its own sampling rules. An unsampled parent drops the trace. A sampled parent is still dropped unless a Vercel rule also samples the request. Both services need matching collection rules for a connected trace. Manual SDK setup without `@vercel/otel` lacks session tracing and Trace Drains support. See [Vercel sampling behavior](https://vercel.com/docs/tracing/instrumentation#sampling-behavior).

## Verify

Deploy both services, send one request through the caller, and inspect it with [inspection](inspection.md). The receiver's server span should share the caller's trace ID and sit under the caller's outbound span. If it starts a new trace, check the URL matcher first, then that the receiver extracts the context.
