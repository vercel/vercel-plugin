---
name: env-vars
greenfield: true
priority: 7
docs: https://vercel.com/docs/environment-variables
sitemap: https://vercel.com/sitemap/docs.xml
pathPatterns:
  - ".env"
  - ".env.*"
  - ".env.local"
  - ".env.production"
  - ".env.development"
  - ".env.test"
  - ".env.production.local"
  - ".env.development.local"
  - ".env.test.local"
  - ".env.example"
bashPatterns:
  - "\\bvercel\\s+env\\s+pull\\b"
  - "\\bvercel\\s+env\\s+add\\b"
  - "\\bvercel\\s+env\\s+rm\\b"
  - "\\bvercel\\s+env\\s+ls\\b"
chainTo:
  - pattern: "\\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY)\\b"
    targetSkill: ai-gateway
    message: "Direct provider API key detected — loading AI Gateway guidance for OIDC auth (no manual keys needed on Vercel)."
retrieval:
  aliases: ["environment variables", "env file", "secrets", "config vars"]
  intents: ["set env var", "manage secrets", "pull env vars", "configure environment"]
  entities: [".env", "vercel env", "OIDC", "environment variable"]
---

Guidance for env-vars. Install from registry for full content.
