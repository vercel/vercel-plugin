---
name: turborepo
registry: vercel/turborepo
priority: 5
docs: https://turborepo.dev/docs
sitemap: https://turborepo.dev/sitemap.xml
pathPatterns:
  - "turbo.json"
  - "turbo/**"
bashPatterns:
  - "\\bturbo\\s+(run|build|test|lint|dev)\\b"
  - "\\bnpx\\s+turbo\\b"
  - "\\bbunx\\s+turbo\\b"
validate:
  - pattern: "\"pipeline\"\\s*:"
    message: "turbo.json \"pipeline\" was renamed to \"tasks\" in Turborepo v2 — update to \"tasks\" key. Run `npx @turbo/codemod migrate` for automatic migration."
    severity: error
    skipIfFileContains: "\"tasks\"\\s*:"
    upgradeToSkill: turborepo
    upgradeWhy: "Reload Turborepo skill for v2 migration guidance — \"pipeline\" → \"tasks\" rename and other breaking changes."
chainTo:
  - pattern: "from\\s+[''\"\"]@vercel/(postgres|kv)[''\"\"]"
    targetSkill: vercel-storage
    message: "@vercel/postgres and @vercel/kv are sunset — loading Vercel Storage guidance for Neon and Upstash migration."
retrieval:
  aliases: ["monorepo", "turbo", "workspace builds", "task runner"]
  intents: ["set up monorepo", "configure turbo", "optimize build caching", "run tasks in parallel"]
  entities: ["Turborepo", "turbo.json", "remote caching", "--affected", "pipeline"]
---

Guidance for turborepo. Install from registry for full content.
