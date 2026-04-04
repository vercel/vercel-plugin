---
name: shadcn
registry: vercel-labs/json-render
priority: 6
docs:
  - https://ui.shadcn.com/docs
  - https://ui.shadcn.com/docs/components
pathPatterns:
  - "components.json"
  - "components/ui/**"
  - "src/components/ui/**"
  - "apps/*/components/ui/**"
  - "apps/*/src/components/ui/**"
  - "packages/*/components/ui/**"
  - "packages/*/src/components/ui/**"
bashPatterns:
  - "\\bnpx\\s+shadcn\\b"
  - "\\bnpx\\s+shadcn@latest\\s+(init|add|build|search|list|migrate|info|docs|view)\\b"
  - "\\bnpx\\s+create-next-app\\b"
  - "\\bbunx\\s+create-next-app\\b"
  - "\\bpnpm\\s+create\\s+next-app\\b"
  - "\\bnpm\\s+create\\s+next-app\\b"
validate:
  - pattern: "\"base\"\\s*:\\s*\"base-ui\""
    message: "AI Elements components use Radix-specific APIs (asChild, openDelay) and have type errors with Base UI. If this project uses AI Elements, reinitialize with: npx shadcn@latest init -d --base radix -f"
    severity: warn

  - pattern: "react-markdown|ReactMarkdown|from\\s+[''\"]remark[''\"]"
    targetSkill: ai-elements
    message: "Manual markdown rendering detected — loading AI Elements for streaming-aware MessageResponse that handles code highlighting, math, and mermaid out of the box."
  - pattern: "dangerouslySetInnerHTML"
    targetSkill: ai-elements
    message: "Unsafe HTML injection detected — loading AI Elements for safe, streaming-aware AI content rendering via MessageResponse."
retrieval:
  aliases: ["shadcn ui", "component library", "ui components", "tailwind components"]
  intents: ["add shadcn component", "set up shadcn", "customize theme", "build ui"]
  entities: ["shadcn/ui", "Tailwind CSS", "registry", "theme", "components.json"]
chainTo:
  - pattern: "react-markdown|ReactMarkdown|from\\s+[''\"]remark[''\"]"
    targetSkill: ai-elements
    message: "Manual markdown rendering detected — loading AI Elements for streaming-aware MessageResponse that handles code highlighting, math, and mermaid out of the box."
    skipIfFileContains: "ai-elements|MessageResponse|<Message\\b"
  - pattern: "dangerouslySetInnerHTML"
    targetSkill: ai-elements
    message: "Unsafe HTML injection detected — loading AI Elements for safe, streaming-aware AI content rendering via MessageResponse."
    skipIfFileContains: "ai-elements|MessageResponse|<Message\\b"
---

Guidance for shadcn. Install from registry for full content.
