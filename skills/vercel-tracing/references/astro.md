# Astro instrumentation

Use this reference when the application uses Astro with `@astrojs/vercel`. Check [SDK ownership](instrumentation.md) before registering OpenTelemetry.

Astro emits no framework spans and does not extract incoming trace context. It does not load an `instrumentation.ts` file. Custom spans stay in a separate trace unless you extract the incoming headers before `next()`.

Initialize Vercel's SDK in `src/telemetry.ts`:

```ts
import { registerOTel } from '@vercel/otel';

registerOTel({ serviceName: 'checkout' });
```

Astro loads `src/middleware.ts` or `src/middleware.js` before `src/middleware/index.ts` or `src/middleware/index.js`. A middleware file wins over the directory, and `.js` is tried before `.ts`. Use the file the app already has. Creating `src/middleware.ts` next to any of those other files stops the existing middleware from loading, or is ignored, with no warning. Import the telemetry module first in that file. From `src/middleware.ts` the specifier is `./telemetry`. From `src/middleware/index.ts` it is `../telemetry`. The import runs before `next()`, and Node loads the module once per function instance. Import OpenTelemetry's context as `otelContext`. Astro's middleware argument is also named `context`. Rename the current `export const onRequest` to `const existing` and call that handler from `run`. Do not replace its body. If the file has no handler yet, define `const existing = defineMiddleware((context, next) => next())`.

```ts
import './telemetry';
import { context as otelContext, propagation } from '@opentelemetry/api';
import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware((context, next) => {
  const run = () => existing(context, next);
  if (context.isPrerendered) return run();
  const parent = propagation.extract(
    otelContext.active(),
    Object.fromEntries(context.request.headers),
  );
  return otelContext.with(parent, run);
});
```

The prerender branch skips only the extract. Do not add `src/fetch.ts` only to register OpenTelemetry. Astro 7 uses that file as the request pipeline. If `src/fetch.ts` or the configured `fetchFile` already exists, keep it and make sure it calls `middleware()` from `astro/fetch`. Otherwise this extract never runs.

Leave `middlewareMode` and `edgeMiddleware` as the app set them. Either `middlewareMode: 'edge'` or the older `edgeMiddleware: true` also runs this file in the Edge runtime, which does not collect custom spans. The Node function still runs this file, and that is where `next()` renders the route, so keep the extract here. Removing those settings moves an ISR route off `_middleware`, so a cache hit skips this file. See [Astro middleware](https://docs.astro.build/en/guides/middleware/) and the [Vercel adapter](https://docs.astro.build/en/guides/integrations-guide/vercel/).

Traced routes must render on demand. Set `export const prerender = false` on the route you trace. Do not set `output: 'server'` to trace one route. That server-renders every page. Prerendered pages produce no application spans. Middleware also runs while those pages prerender, so skip the extract when `context.isPrerendered` is true and still call the existing handler. With classic middleware, an ISR cache hit does not run this file. With `middlewareMode: 'edge'`, this file runs on the cache hit too, but the Edge runtime does not collect its spans.

Add operation spans as in [custom spans](custom-spans.md).

Deploy the change to preview or production, then verify [collection](collection.md) and exercise an on-demand route.
