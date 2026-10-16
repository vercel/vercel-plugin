# Next.js instrumentation

Use this reference when the application uses Next.js. Check [SDK ownership](instrumentation.md) before registering OpenTelemetry, and install `@vercel/otel` and `@opentelemetry/api` as described there.

For Next.js, put `instrumentation.ts` at the project root, or in `src` if the application uses it:

```ts
import { registerOTel } from '@vercel/otel';

export function register() {
  registerOTel({ serviceName: 'checkout' });
}
```

Instrumentation is [stable in Next.js 15+](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation#version-history). For older versions, check that version's instrumentation-hook requirements before adding configuration.

Next.js already emits framework spans and, from 14.0.1, extracts incoming trace context. To include additional spans, optionally set this environment variable on the target deployment and redeploy:

```dotenv
NEXT_OTEL_VERBOSE=1
```

This expands span detail; it does not replace SDK setup or Vercel sampling. See [Next.js OpenTelemetry](https://nextjs.org/docs/app/guides/open-telemetry).

Prerendered routes run no server code and produce no server spans. If `next.config` enables `cacheComponents`, call `await connection()` from `next/server` in route handlers and pages you trace, wrapping page content that awaits it in `<Suspense>`. Confirm that `next build` marks the route dynamic (`ƒ`) or partially prerendered (`◐`).

Deploy the change to preview or production, then verify [collection](collection.md) and exercise the affected route.
