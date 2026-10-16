# Custom spans

Use this reference when framework spans do not expose the operation being investigated. Complete [SDK setup](instrumentation.md) first. To find which operation makes a request slow, follow [performance](performance.md).

Add one helper so every measured operation uses the same pattern. It uses `startActiveSpan`, so nested calls inherit the span's context:

```ts
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

const tracer = trace.getTracer('checkout');

export function measure<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

Wrap an existing operation without changing it:

```ts
import { measure } from './lib/measure';
import { chargePayment } from './payments';

export function checkout(orderId: string) {
  return measure('checkout.charge-payment', { 'order.id': orderId }, () => chargePayment(orderId));
}
```

Adapt the names, attributes, and imports to the application. Keep `await` inside the `try` so the span covers the full operation and catches rejected promises. The helper records exceptions, marks failed spans as errors with the error message, rethrows the original value, and ends the span in `finally`. `inspect` shows that message as `[error: <message>]`; the recorded exception is only in search JSON.

- Name spans `<area>.<operation>` with stable, low-cardinality names. Put IDs and sizes in attributes, not names.
- For CPU-bound synchronous work, wrap it in an `async` callback; the span still measures the full blocking time.
- Never record secrets, tokens, or personal data, and keep attributes small to avoid [truncation](troubleshooting.md#oversized-telemetry).

`startSpan` inherits the current context without becoming active. Use it when nested operations should keep their existing parent. Edge runtime functions do not support custom spans; use the Node.js runtime.

## Verify after deployment

Deploy the change and exercise the operation using the chosen [collection mode](collection.md). Find the span through [search](search.md) and [inspect the trace](inspection.md) to confirm awaited calls appear beneath it. For a reproduced failure, confirm the error status with `inspect` and the recorded exception in search JSON at `.data.span.events`. See [Vercel custom spans](https://vercel.com/docs/tracing/instrumentation#adding-custom-spans).
