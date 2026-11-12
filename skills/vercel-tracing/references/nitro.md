# Nitro instrumentation

Use this reference when the server is Nitro 2, including a Nuxt 4 server. Check [SDK ownership](instrumentation.md) before registering OpenTelemetry. [Nuxt](nuxt.md) adds the Vue and `useFetch` notes on top of this setup.

Nitro 2 emits no framework spans and does not extract incoming trace context. Register the SDK in the Nitro `plugins/` directory. For Nuxt that file is `server/plugins/telemetry.ts`. Nitro runs server plugins once per instance when the server module loads, before lazily loaded route handlers. `defineNitroPlugin` is auto-imported. Import `getRequestHeaders` from `h3`. Nuxt also auto-imports that name, so the import is optional there. See [Nitro plugins](https://v2.nitro.build/guide/plugins).

```ts
import { registerOTel } from '@vercel/otel';
import { context, propagation } from '@opentelemetry/api';
import { getRequestHeaders } from 'h3';

export default defineNitroPlugin((nitroApp) => {
  registerOTel({ serviceName: 'checkout' });
  const handler = nitroApp.h3App.handler;
  nitroApp.h3App.handler = (event) => {
    const parent = propagation.extract(context.active(), getRequestHeaders(event));
    return context.with(parent, () => handler(event));
  };
});
```

A `request` hook and server middleware return before the route handler. `context.with` in those hooks does not cover later spans. Replacing `h3App.handler` runs route handlers inside the extracted context. See [incoming requests](context-propagation.md#incoming-requests).

Put the `measure` helper from [custom spans](custom-spans.md) in `server/utils/measure.ts`. Nitro auto-imports files in `server/utils`.

Keep the default `vercel` preset. It runs on Node.js. Do not set the preset to `vercel-edge`. Custom spans need the Node.js runtime. See [custom spans](custom-spans.md). Prerendered routes run no server code. Do not set `isr` or `swr` on a route you need to trace. Nitro 2 maps a `swr` route rule to `isr` on Vercel unless `future.nativeSWR` is set. Vercel serves an ISR cache hit without running the handler.

This is the Nitro 2 API that Nuxt 4 ships. Nitro 3's `definePlugin` was not checked. Do not follow the current nitro.build plugin page for this setup.

Deploy the change to preview or production, then verify [collection](collection.md) and exercise a dynamic server route.
