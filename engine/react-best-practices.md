---
name: react-best-practices
registry: vercel-labs/agent-skills
registrySlug: vercel-react-best-practices
priority: 4
docs:
  - https://react.dev/reference/react
  - https://react.dev/learn
pathPatterns:
  - "src/components/**/*.tsx"
  - "src/components/**/*.jsx"
  - "app/components/**/*.tsx"
  - "app/components/**/*.jsx"
  - "components/**/*.tsx"
  - "components/**/*.jsx"
  - "src/ui/**/*.tsx"
  - "lib/components/**/*.tsx"
importPatterns:
  - "react"
  - "react-dom"
validate:
  - pattern: "from\\s+[''\"](styled-components|@emotion/styled|@emotion/react|@mui/material|@chakra-ui/react)[''\"]|styled\\."
    message: "Legacy CSS-in-JS or component library detected. Consider shadcn/ui + Tailwind for modern Vercel-native UI."
    severity: warn
    skipIfFileContains: "@/components/ui|shadcn|tailwindcss"
    upgradeToSkill: shadcn
    upgradeWhy: "Migrate from CSS-in-JS/MUI/Chakra to shadcn/ui + Tailwind CSS for better SSR performance and Vercel ecosystem alignment."
chainTo:
  - pattern: "from\\s+[''\\\"](styled-components|@emotion/styled|@emotion/react|@mui/material|@chakra-ui/react)[''\"]|styled\\."
    targetSkill: shadcn
    message: "Legacy CSS-in-JS or component library detected — loading shadcn/ui guidance for modern Vercel-native UI."
retrieval:
  aliases: ["react review", "component quality", "tsx linter", "react patterns"]
  intents: ["review react code", "improve component quality", "check accessibility", "optimize react"]
  entities: ["hooks", "accessibility", "React", "TSX", "component"]
---

Guidance for react-best-practices. Install from registry for full content.
