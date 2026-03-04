---
name: vercel-storage
description: Vercel storage expert guidance — Blob, Edge Config, and Marketplace storage (Neon Postgres, Upstash Redis). Use when choosing, configuring, or using data storage with Vercel applications.
---

# Vercel Storage

You are an expert in Vercel's storage options. Know which products are active, which are sunset, and when to use each.

## Active First-Party Storage

### Vercel Blob — File Storage

Fast, scalable storage for unstructured data (images, videos, documents, any files).

```bash
npm install @vercel/blob
```

```ts
import { put, del, list, get } from '@vercel/blob'

// Upload from server
const blob = await put('images/photo.jpg', file, {
  access: 'public',
})
// blob.url → public URL

// Client upload (up to 5 TB)
import { upload } from '@vercel/blob/client'
const blob = await upload('video.mp4', file, {
  access: 'public',
  handleUploadUrl: '/api/upload', // Your token endpoint
})

// List blobs
const { blobs } = await list()

// Conditional get with ETags
const response = await get('images/photo.jpg', {
  ifNoneMatch: previousETag,
})
if (response.statusCode === 304) {
  // Not modified, use cached version
}

// Delete
await del('images/photo.jpg')
```

**Use when**: Media files, user uploads, documents, any large unstructured data.

### Vercel Edge Config — Global Configuration

Ultra-low-latency key-value store for application configuration. Not a database — designed for config data that must be read instantly at the edge.

```bash
npm install @vercel/edge-config
```

```ts
import { get, getAll, has } from '@vercel/edge-config'

// Read a single value (< 1ms at the edge)
const isFeatureEnabled = await get('feature-new-ui')

// Read multiple values
const config = await getAll(['feature-new-ui', 'ab-test-variant', 'redirect-rules'])

// Check existence
const exists = await has('maintenance-mode')
```

**Use when**: Feature flags, A/B testing config, dynamic routing rules, maintenance mode toggles. Anything that must be read at the edge with near-zero latency.

**Do NOT use for**: User data, session state, frequently written data. Edge Config is optimized for reads, not writes.

## Marketplace Storage (Partner-Provided)

### IMPORTANT: @vercel/postgres and @vercel/kv are SUNSET

These packages no longer exist as first-party Vercel products. Use the marketplace replacements:

### Neon Postgres (replaces @vercel/postgres)

Serverless Postgres with branching, auto-scaling, and connection pooling.

```bash
npm install @neondatabase/serverless
```

```ts
// Direct Neon usage
import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL!)
const users = await sql`SELECT * FROM users WHERE id = ${userId}`

// With Drizzle ORM
import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL!)
const db = drizzle(sql)
```

Install via Vercel Marketplace for automatic environment variable provisioning.

### Upstash Redis (replaces @vercel/kv)

Serverless Redis with same Vercel billing integration.

```bash
npm install @upstash/redis
```

```ts
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv() // Uses UPSTASH_REDIS_REST_URL & TOKEN

// Basic operations
await redis.set('session:abc', { userId: '123' }, { ex: 3600 })
const session = await redis.get('session:abc')

// Rate limiting
import { Ratelimit } from '@upstash/ratelimit'
const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '10s'),
})
const { success } = await ratelimit.limit('user:123')
```

Install via Vercel Marketplace for automatic environment variable provisioning.

## Storage Decision Matrix

| Need | Use | Package |
|------|-----|---------|
| File uploads, media, documents | Vercel Blob | `@vercel/blob` |
| Feature flags, A/B config | Edge Config | `@vercel/edge-config` |
| Relational data, SQL queries | Neon Postgres | `@neondatabase/serverless` |
| Key-value cache, sessions, rate limiting | Upstash Redis | `@upstash/redis` |
| Full-text search | Neon Postgres (pg_trgm) or Elasticsearch (Marketplace) | varies |
| Vector embeddings | Neon Postgres (pgvector) or Pinecone (Marketplace) | varies |

## Migration Guide

### From @vercel/postgres → Neon
```diff
- import { sql } from '@vercel/postgres'
+ import { neon } from '@neondatabase/serverless'
+ const sql = neon(process.env.DATABASE_URL!)

```

### From @vercel/kv → Upstash Redis
```diff
- import { kv } from '@vercel/kv'
- await kv.set('key', 'value')
- const value = await kv.get('key')
+ import { Redis } from '@upstash/redis'
+ const redis = Redis.fromEnv()
+ await redis.set('key', 'value')
+ const value = await redis.get('key')
```

## Installing Marketplace Storage

Use the Vercel CLI or Marketplace dashboard:

```bash
# Install a storage integration (auto-provisions env vars)
vercel integration add neon
vercel integration add upstash

# List installed integrations
vercel integration list
```

Browse additional storage options at the [Vercel Marketplace](https://vercel.com/marketplace). Installing via the CLI or dashboard automatically provisions accounts, creates databases, and sets environment variables.

## Official Documentation

- [Vercel Storage](https://vercel.com/docs/storage)
- [Vercel Blob](https://vercel.com/docs/storage/vercel-blob)
- [Edge Config](https://vercel.com/docs/storage/edge-config)
- [Vercel Marketplace](https://vercel.com/marketplace) — Neon, Upstash, and other storage integrations
- [Integrations](https://vercel.com/docs/integrations)
- [GitHub: Vercel Storage](https://github.com/vercel/storage)
