# Next.js instrumentation

Use this reference when the application uses Next.js. Check [SDK ownership](instrumentation.md) before registering OpenTelemetry, and install `@vercel/otel` and `@opentelemetry/api` as described there.

Projects created on or after November 5, 2026 that build on Vercel (not `--prebuilt`) with Next.js 16.5+, include a Node.js function, and haven't turned tracing off get default tracing: after the first successful build, Vercel adds one sampling rule tracing 100% of requests in all environments and adds `@vercel/otel` to each build for framework spans. Vercel does not add it when the project has its own `instrumentation` file (in the project, `src`, or a monorepo parent folder), uses `@opentelemetry/api` 1.10+ directly or through another package, or sets `instrumentationInject` in its Next.js config; tracing then still collects infrastructure spans, but framework spans need your own `@vercel/otel` setup. Check `vercel traces config ls` before adding rules. Custom spans still need your own `instrumentation.ts`; set `serviceName: process.env.VERCEL_PROJECT_NAME` to keep the default service name. Removing every sampling rule turns tracing off and stops the injection from the next deployment; Vercel doesn't re-add the default rule, but adding any sampling rule turns tracing back on and resumes the injection from the next deployment. See [default tracing](https://vercel.com/docs/tracing/configure-tracing#default-tracing-for-new-next.js-projects).

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
