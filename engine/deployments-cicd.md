---
name: deployments-cicd
registry: vercel-labs/agent-skills
registrySlug: vercel-deploy
priority: 6
docs:
  - https://vercel.com/docs/deployments/overview
  - https://vercel.com/docs/git
sitemap: https://vercel.com/sitemap/docs.xml
pathPatterns:
  - ".github/workflows/*.yml"
  - ".github/workflows/*.yaml"
  - ".gitlab-ci.yml"
  - "bitbucket-pipelines.yml"
  - "vercel.json"
  - "apps/*/vercel.json"
bashPatterns:
  - "\\bvercel\\s+deploy\\b"
  - "\\bvercel\\s+--prod\\b"
  - "\\bvercel\\s+promote\\b"
  - "\\bvercel\\s+rollback\\b"
  - "\\bvercel\\s+inspect\\b"
  - "\\bvercel\\s+build\\b"
  - "\\bvercel\\s+deploy\\s+--prebuilt\\b"
validate:
  - pattern: "cron:\\s*[''\"]|from\\s+[''\"](node-cron)[''\"]|cron\\.schedule\\("
    message: "Manual cron scheduling detected. Use Vercel Cron Jobs (vercel.json crons) for platform-native scheduled tasks."
    severity: recommended
    skipIfFileContains: "vercel\\.json.*crons|@vercel/cron"
    upgradeToSkill: cron-jobs
    upgradeWhy: "Replace node-cron or CI-based schedules with Vercel Cron Jobs in vercel.json for managed, observable scheduled execution."
chainTo:
  - pattern: "cron:\\s*[''\"]|from\\s+[''\\\"](node-cron)[''\"]|cron\\.schedule\\("
    targetSkill: cron-jobs
    message: "Manual cron scheduling detected — loading Vercel Cron Jobs guidance for platform-native scheduling."
retrieval:
  aliases: ["deploy", "ci cd", "continuous deployment", "release pipeline"]
  intents: ["deploy to vercel", "set up ci cd", "promote deployment", "rollback deploy"]
  entities: ["vercel deploy", "preview", "production", "rollback", "promote", "CI workflow"]
---

Guidance for deployments-cicd. Install from registry for full content.
