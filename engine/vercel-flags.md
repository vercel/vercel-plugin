---
name: vercel-flags
registry: vercel/flags
registrySlug: flags-sdk
priority: 6
docs:
  - https://vercel.com/docs/workflow-collaboration/feature-flags
  - https://flags-sdk.dev
sitemap: https://vercel.com/sitemap/docs.xml
pathPatterns:
  - "flags.ts"
  - "flags.js"
  - "src/flags.ts"
  - "src/flags.js"
  - "lib/flags/**"
  - "src/lib/flags/**"
  - "lib/flags.*"
  - "src/lib/flags.*"
  - ".well-known/vercel/flags/**"
  - "app/.well-known/vercel/flags/**"
  - "src/app/.well-known/vercel/flags/**"
bashPatterns:
  - "\\bnpm\\s+(install|i|add)\\s+[^\\n]*\\bflags\\b"
  - "\\bpnpm\\s+(install|i|add)\\s+[^\\n]*\\bflags\\b"
  - "\\bbun\\s+(install|i|add)\\s+[^\\n]*\\bflags\\b"
  - "\\byarn\\s+add\\s+[^\\n]*\\bflags\\b"
  - "\\bnpm\\s+(install|i|add)\\s+[^\\n]*@vercel/flags\\b"
  - "\\bpnpm\\s+(install|i|add)\\s+[^\\n]*@vercel/flags\\b"
  - "\\bbun\\s+(install|i|add)\\s+[^\\n]*@vercel/flags\\b"
  - "\\byarn\\s+add\\s+[^\\n]*@vercel/flags\\b"
  - "\\bnpm\\s+(install|i|add)\\s+[^\\n]*@flags-sdk/"
  - "\\bpnpm\\s+(install|i|add)\\s+[^\\n]*@flags-sdk/"
  - "\\bbun\\s+(install|i|add)\\s+[^\\n]*@flags-sdk/"
  - "\\byarn\\s+add\\s+[^\\n]*@flags-sdk/"
importPatterns:
  - "flags"
  - "flags/next"
  - "flags/sveltekit"
  - "@vercel/flags"
  - "@vercel/flags/next"
  - "@vercel/flags/sveltekit"
  - "@flags-sdk/*"
chainTo:
  - pattern: "process\\.env\\.(FEATURE_|FLAG_|ENABLE_|DISABLE_)\\w+"
    targetSkill: vercel-storage
    message: "Environment variable feature flags detected — loading Vercel Storage guidance for Edge Config, which provides ultra-low-latency flag reads at the edge."
  - pattern: "from\\s+[''\"\"]launchdarkly-node-server-sdk[''\"\"]|from\\s+[''\"\"]@launchdarkly/"
    targetSkill: vercel-flags
    message: "Direct LaunchDarkly SDK detected — Vercel Flags provides a unified adapter layer. Reloading Flags guidance for provider integration."
retrieval:
  aliases: ["feature flags", "feature toggles", "ab testing", "gradual rollout"]
  intents: ["add feature flag", "set up ab test", "configure rollout", "manage feature toggles"]
  entities: ["Flags Explorer", "feature flag", "A/B test", "rollout", "provider adapter"]
---

Guidance for vercel-flags. Install from registry for full content.
