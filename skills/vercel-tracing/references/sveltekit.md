# SvelteKit instrumentation

Use this reference when the application uses SvelteKit. Check [SDK ownership](instrumentation.md) before registering OpenTelemetry.

With `tracing.server` enabled, SvelteKit emits `sveltekit.handle.root`, `sveltekit.resolve`, `sveltekit.load`, `sveltekit.form_action`, and `sveltekit.remote.*` spans; `+server` handlers run inside `sveltekit.resolve`. It also extracts incoming trace context. Without `tracing.server`, custom spans start separate traces instead of joining the request.

On SvelteKit 3, merge `tracing` into the existing `sveltekit()` plugin options in `vite.config.js`, preserving the adapter and other settings. SvelteKit loads `src/instrumentation.server.ts` automatically when it exists:

```js
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit({ tracing: { server: true } })],
});
```

On SvelteKit 2.31+, both options are experimental and live in `svelte.config.js`:

```js
export default {
  kit: {
    experimental: {
      tracing: { server: true },
      instrumentation: { server: true },
    },
  },
};
```

Initialize Vercel's SDK in `src/instrumentation.server.ts`:

```ts
import { registerOTel } from '@vercel/otel';

registerOTel({ serviceName: 'checkout' });
```

`instrumentation.server.ts` loads before application code. `@sveltejs/adapter-vercel` 7, for SvelteKit 3, no longer supports the Edge runtime and picks the Node.js runtime from the build's Node version; build with Node 22 or 24, or set `adapter({ runtime: 'nodejs24.x' })`. See [SvelteKit observability](https://svelte.dev/docs/kit/observability) and [migrating to SvelteKit 3](https://svelte.dev/docs/kit/migrating-to-sveltekit-3#Observability).

Deploy the change to preview or production, then verify [collection](collection.md) and exercise the affected route.
