---
name: next-cache-components
registry: vercel-labs/next-skills
priority: 6
docs:
  - https://nextjs.org/docs/app/getting-started/cache-components
  - https://nextjs.org/docs/app/api-reference/directives/use-cache
pathPatterns:
  - "next.config.*"
  - "app/**"
  - "src/app/**"
  - "apps/*/app/**"
  - "apps/*/src/app/**"
bashPatterns:
  - "\\bnext\\s+(dev|build)\\b"
importPatterns:
  - "next/cache"
promptSignals:
  phrases:
    - "use cache"
    - "cache components"
    - "partial prerendering"
    - "PPR"
    - "cacheLife"
    - "cacheTag"
    - "updateTag"
    - "unstable_cache"
  allOf:
    - ["cache", "component"]
    - ["cache", "directive"]
    - ["partial", "prerender"]
  anyOf:
    - "revalidateTag"
    - "stale"
    - "revalidate"
    - "cache profile"
  minScore: 6
retrieval:
  aliases: ["cache components", "partial prerendering", "PPR", "use cache"]
  intents: ["enable partial prerendering in Next.js", "cache async data with use cache directive", "invalidate cache with cacheTag", "migrate from unstable_cache"]
  entities: ["use cache", "cacheLife", "cacheTag", "updateTag", "revalidateTag", "PPR"]
chainTo:
  - pattern: "use cache"
    targetSkill: nextjs
    message: "Cache component detected — loading Next.js best practices for RSC boundaries and data patterns alongside caching."
    skipIfFileContains: "next-best-practices"
---

Guidance for next-cache-components. Install from registry for full content.
