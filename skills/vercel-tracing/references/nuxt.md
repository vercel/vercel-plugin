# Nuxt instrumentation

Use this reference when the application uses Nuxt. Check [SDK ownership](instrumentation.md) before registering OpenTelemetry.

Nuxt 4 builds its server with Nitro 2. Follow [Nitro](nitro.md) for the server plugin, the `h3App.handler` wrap, and the Vercel preset. Do not copy that plugin into this file.

Do not import the `measure` helper from a Vue page. That pulls server code into the client bundle. A server-rendered page that calls a relative API route with `useFetch` runs that route in-process. Its spans join the page request under the function span. See [Nuxt server utilities](https://nuxt.com/docs/4.x/directory-structure/server#server-utilities).

Nuxt 4.6's experimental `tracingChannel` emits diagnostics-channel events that `@vercel/otel` does not read. It adds no spans to Vercel traces, so leave it unset.

Deploy the change to preview or production, then verify [collection](collection.md) and exercise a dynamic server-rendered route.
