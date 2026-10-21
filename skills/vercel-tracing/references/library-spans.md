# Library spans

Use this reference when the application depends on libraries that can emit their own spans, such as the AI SDK, the Flags SDK, Workflow, or database clients. Library spans reach Vercel through the provider that `registerOTel` registers; complete [SDK setup](instrumentation.md) first.

## Check dependencies

Match `dependencies` in the application's `package.json`, or in each server app's `package.json` in a monorepo, against this table, and apply the row for each match. Registering `@vercel/otel` is enough only for the first two rows; the others emit no spans until they are turned on.

| Library | After `registerOTel` alone | Turn on |
| --- | --- | --- |
| Workflow (`workflow`) | Workflow runtime spans | Nothing to add; `WORKFLOW_TRACE_MODE` only changes how step traces link |
| SDKs that call HTTP APIs (OpenAI, Stripe, Upstash, Supabase) | Outbound HTTP spans | Nothing to add; they have no spans of their own |
| AI SDK 7 (`ai`) | No AI SDK spans | `registerTelemetry(new OpenTelemetry())` from `@ai-sdk/otel` |
| AI SDK 6 and earlier | No AI SDK spans | `experimental_telemetry: { isEnabled: true }` on each call |
| Flags SDK (`flags`) on Next.js | No flag spans | `setTracerProvider(trace)` |
| Database and cache clients (`pg`, `mysql2`, `ioredis`, `mongodb`, Prisma) | No query spans | An OpenTelemetry instrumentation package; Prisma 4.2 to 6.0 also needs `previewFeatures = ["tracing"]` in `schema.prisma` |

For other installed server libraries, check their docs or published `dist` for a telemetry option, a tracer setter, or an instrumentation package, and turn on any that exist. A dependency on `@opentelemetry/api` does not prove the library emits spans by default.

Report which library spans were turned on and which installed libraries have none.

## Turn on built-in spans

When `ai` 7 is installed, install `@ai-sdk/otel`. Call each opt-in once in the same startup hook, after `registerOTel`. On Next.js, with both the AI SDK and the Flags SDK installed:

```ts
import { trace } from '@opentelemetry/api';
import { OpenTelemetry } from '@ai-sdk/otel';
import { registerOTel } from '@vercel/otel';
import { registerTelemetry } from 'ai';
import { setTracerProvider } from 'flags';

export function register() {
  registerOTel({ serviceName: 'checkout' });
  registerTelemetry(new OpenTelemetry());
  setTracerProvider(trace);
}
```

AI SDK 7 then traces every call; pass `telemetry: { functionId: 'checkout-assistant' }` to name a call, or `telemetry: { isEnabled: false }` to skip one.

## Add instrumentation packages

When a database or cache client is installed, install its instrumentation package: `@opentelemetry/instrumentation-<client>` for `pg`, `mysql2`, `ioredis`, and `mongodb`, or `@prisma/instrumentation` for Prisma. Pick the release whose `@opentelemetry/instrumentation` dependency fits the range in `npm view @vercel/otel peerDependencies`; the latest release can need a newer OpenTelemetry API than `@vercel/otel` supports and fail `next build`. Check a release with `npm view @opentelemetry/instrumentation-pg@<version> dependencies`. Pass it to `registerOTel` and keep `'auto'` in the list; the option replaces the default, so a list without `'auto'` or `'fetch'` drops outbound fetch spans:

```ts
import { registerOTel } from '@vercel/otel';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { PgInstrumentation } = await import('@opentelemetry/instrumentation-pg');
    registerOTel({ serviceName: 'checkout', instrumentations: ['auto', new PgInstrumentation()] });
  } else {
    registerOTel({ serviceName: 'checkout' });
  }
}
```

These packages run only in the Node.js runtime, and they patch a library when it loads, so the library must not be bundled. Next.js leaves `pg`, `mongodb`, `mongoose`, and `@prisma/client` unbundled by default; add other clients, such as `ioredis` and `mysql2`, to `serverExternalPackages` in `next.config`.

## Verify after deployment

Deploy, exercise a route that calls the library, and [inspect its trace](inspection.md). Confirm the library's spans appear beneath the request and that outbound fetch spans are still present.
