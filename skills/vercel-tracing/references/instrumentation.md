# Application SDK setup

Use this reference when framework and custom spans are needed, or when SDK registrations conflict. Infrastructure and outbound-fetch spans need no application OpenTelemetry setup; see [collection](collection.md).

## Check existing setup

Check framework and adapter versions, SDK registration, and tracing flags. Enable built-in framework spans where available; they still need SDK and exporter setup to reach Vercel. Extend the existing provider rather than registering a second one.

Install `@vercel/otel` and `@opentelemetry/api` with the application's package manager as needed. If the package manager does not install peer dependencies automatically, also install the peers listed by `npm view @vercel/otel peerDependencies`. Follow [Next.js](nextjs.md) or [SvelteKit](sveltekit.md) setup for those frameworks.

## Integrate another framework

1. Identify the installed framework and adapter versions, target runtime, and how the affected route executes. Verify that the operation runs on the server for the requests being investigated; prerendered or cached responses may skip application code. Custom spans require a supported runtime.
2. Find the framework's native tracing flags and documented server startup, preload, or initialization hook. Use version-appropriate official docs; inspect adapter source when the integration is unclear. Record which entrypoint loads initialization and when it runs. A special filename alone does not prove it is loaded.
3. Wire one server-only SDK setup module, such as the one below, into that verified hook. Initialize automatic instrumentations before loading the libraries they instrument. See [OpenTelemetry initialization order](https://opentelemetry.io/docs/languages/js/instrumentation/#initialize-the-sdk).
4. Check whether the framework already establishes incoming trace context. When it does not, map its request headers and handler or middleware continuation to [context propagation](context-propagation.md#incoming-requests). Preserve existing middleware and configuration.
5. Build and verify the expected spans using the checks below. If no supported initialization path can be established, report the missing integration and source evidence before proceeding.

For a new SDK setup, a module such as `telemetry.ts` can contain:

```ts
import { registerOTel } from '@vercel/otel';

registerOTel({ serviceName: 'checkout' });
```

Import it from the verified server entrypoint or hook, adapting the relative path:

```ts
import './telemetry';
```

This import must execute in the deployed server runtime and register once per runtime instance. Keep it out of client bundles, using the framework's server-only file convention when it has one. See [Vercel instrumentation](https://vercel.com/docs/tracing/instrumentation).

Some adapters supply a default server entry when the project has none. Before creating that file to add the import, start from the adapter's documented template for Vercel so streaming and response handling keep working; a generic framework template can differ. If the file exists, add only the import line.

Without native framework spans, a slow loader or handler appears as one long function span; add [custom spans](custom-spans.md) around its operations.

## Coexist with Sentry

Sentry v8+ initializes OpenTelemetry automatically, which can conflict with `@vercel/otel`. Decide which integration owns setup before changing it. When Vercel owns OpenTelemetry setup, merge `skipOpenTelemetrySetup: true` into the existing Sentry initialization:

```ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  skipOpenTelemetrySetup: true,
});
```

Use the application's existing Sentry package and preserve its other options. If Sentry tracing must also use the shared provider, follow [Sentry's custom OpenTelemetry integration](https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/custom-setup/); disabling its automatic setup alone does not implement that integration. See [Vercel's Sentry guidance](https://vercel.com/docs/tracing#using-custom-opentelemetry-setup-with-sentry).

## Deploy and verify

1. Run the application's framework or adapter build and available type checks. A prompt to install a checker is not a completed check. When startup loading is uncertain, inspect emitted server output to confirm the setup module executes before the instrumented operation.
2. Verify the expected operation's span. Use native framework spans where available, or add a small [custom span](custom-spans.md). An isolated local exporter check can verify SDK initialization and parent context; it does not prove Vercel collection.
3. Deploy to preview or production and choose a [collection mode](collection.md). Exercise a server-executed operation, then [inspect its collected trace](inspection.md) in the same project and environment. Confirm the span's name, service, timing, and parent relationships; verify error status when reproducing a failure.
