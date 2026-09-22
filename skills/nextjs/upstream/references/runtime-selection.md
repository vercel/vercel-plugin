# Runtime Selection

## Use Node.js Runtime by Default

Use the default Node.js runtime for new routes and pages. The Edge Runtime for pages, layouts, and route handlers is deprecated — remove the `runtime` export from route files instead of adding it.

```tsx
// Good: Default - no runtime config needed (uses Node.js)
export default function Page() { ... }

// Deprecated: 'edge' is deprecated for pages/layouts/route handlers
export const runtime = 'edge'
```

## When to Use Each

### Node.js Runtime (Default)

- Full Node.js API support
- File system access (`fs`)
- Full `crypto` support
- Database connections
- Most npm packages work

### Edge Runtime (Deprecated for routes)

- Deprecated for pages, layouts, and route handlers — remove the `runtime` export instead of setting `'edge'`
- Limited API (no `fs`, limited `crypto`)
- Smaller cold start
- Still used internally by Proxy (`proxy.ts`), which defaults to the Node.js runtime and does not accept a `runtime` export

## Detection

**Before adding `runtime = 'edge'`**, check:
1. Is `'edge'` deprecated for this file type? (pages, layouts, and route handlers: yes — remove the export instead)
2. Does the project already use Edge runtime for another reason?
3. Are all dependencies Edge-compatible?

If unsure, use Node.js runtime (the default).
