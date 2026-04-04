---
name: ai-elements
registry: vercel/ai-elements
priority: 5
docs: https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-with-tool-calling
sitemap: https://sdk.vercel.ai/sitemap.xml
pathPatterns:
  - "components/ai-elements/**"
  - "src/components/ai-elements/**"
  - "components/**/chat*"
  - "components/**/*chat*"
  - "components/**/message*"
  - "components/**/*message*"
  - "src/components/**/chat*"
  - "src/components/**/*chat*"
  - "src/components/**/message*"
  - "src/components/**/*message*"
bashPatterns:
  - "\\bnpx\\s+ai-elements\\b"
  - "\\bnpm\\s+(install|i|add)\\s+[^\\n]*\\bai-elements\\b"
  - "\\bpnpm\\s+(install|i|add)\\s+[^\\n]*\\bai-elements\\b"
  - "\\bbun\\s+(install|i|add)\\s+[^\\n]*\\bai-elements\\b"
  - "\\byarn\\s+add\\s+[^\\n]*\\bai-elements\\b"
  - "\\bnpx\\s+shadcn@latest\\s+add\\s+[^\\n]*elements\\.ai-sdk\\.dev\\b"
  - "\\bnpm\\s+(install|i|add)\\s+[^\\n]*\\b@ai-sdk/react\\b"
  - "\\bpnpm\\s+(install|i|add)\\s+[^\\n]*\\b@ai-sdk/react\\b"
  - "\\bbun\\s+(install|i|add)\\s+[^\\n]*\\b@ai-sdk/react\\b"
  - "\\byarn\\s+add\\s+[^\\n]*\\b@ai-sdk/react\\b"
importPatterns:
  - "ai"
  - "@ai-sdk/*"
  - "@ai-sdk/react"
  - "@/components/ai-elements/*"
promptSignals:
  phrases:
    - "ai elements"
    - "ai components"
    - "chat components"
    - "chat ui"
    - "chat interface"
    - "voice elements"
    - "code elements"
    - "voice agent"
    - "speech input"
    - "transcription component"
    - "code editor component"
    - "streaming markdown"
    - "streaming ui"
    - "streaming response"
    - "markdown formatting"
  allOf:
    - ["message", "component"]
    - ["conversation", "component"]
    - ["markdown", "stream"]
    - ["markdown", "render"]
    - ["chat", "ui"]
    - ["chat", "interface"]
    - ["stream", "response"]
    - ["ai", "component"]
  anyOf:
    - "message component"
    - "conversation component"
    - "tool call display"
    - "reasoning display"
    - "voice conversation"
    - "speech to text"
    - "text to speech"
    - "mic selector"
    - "voice selector"
    - "ai code editor"
    - "file tree component"
    - "terminal component"
    - "stack trace component"
    - "test results component"
    - "react-markdown"
    - "chat ui"
    - "terminal"
    - "useChat"
    - "streamText"
  noneOf:
    - "vue"
    - "svelte"
    - "readme"
    - "markdown file"
    - "changelog"
  minScore: 6
validate:
  - pattern: "part\\.text\\b"
    message: "You are rendering AI message text as raw strings — use <MessageResponse> from @/components/ai-elements/message to render markdown, code blocks, and rich formatting. Install with: npx shadcn@latest add https://elements.ai-sdk.dev/api/registry/message.json"
    severity: warn
    skipIfFileContains: "ai-elements/message"
    upgradeToSkill: ai-elements
    upgradeWhy: "Guides migration from raw text rendering to AI Elements MessageResponse for streaming-aware markdown display."
  - pattern: "react-markdown"
    message: "Use <MessageResponse> from @/components/ai-elements/message instead of react-markdown — it handles streaming, code highlighting, and AI SDK message parts out of the box"
    severity: warn
    skipIfFileContains: "ai-elements/message"
    upgradeToSkill: ai-elements
    upgradeWhy: "Guides migration from react-markdown to AI Elements MessageResponse with streaming, code highlighting, and math support."
  - pattern: "dangerouslySetInnerHTML"
    message: "Do not render AI responses with dangerouslySetInnerHTML — use <MessageResponse> from @/components/ai-elements/message for safe, styled markdown rendering"
    severity: error
    skipIfFileContains: "ai-elements/message"
    upgradeToSkill: ai-elements
    upgradeWhy: "Guides migration from dangerouslySetInnerHTML to AI Elements MessageResponse for safe, streaming-aware AI content rendering."
  - pattern: "@ts-nocheck"
    message: "Do not add @ts-nocheck — this means you installed an AI Elements component with a type conflict. Delete unused components, or reinstall the broken one: npx shadcn@latest add https://elements.ai-sdk.dev/api/registry/<component>.json --overwrite"
    severity: error
chainTo:
  - pattern: "\\{message\\.content\\}"
    targetSkill: ai-sdk
    message: "Raw message.content rendering detected — loading AI SDK guidance for UIMessage parts migration (message.parts)."
  - pattern: "dangerouslySetInnerHTML"
    targetSkill: ai-sdk
    message: "Unsafe HTML rendering of AI content — loading AI SDK guidance for proper streaming and MessageResponse rendering."
  - pattern: "from\\s+[''\\\"](react-markdown|marked|markdown-it|showdown|commonmark)[''\"]|require\\s*\\(\\s*[''\\\"](react-markdown|marked|markdown-it|showdown|commonmark)[''\"]"
    targetSkill: ai-elements
    message: "Generic markdown library detected for AI content — use <MessageResponse> from AI Elements instead. It handles streaming, code highlighting, math, mermaid, and CJK out of the box."
retrieval:
  aliases: ["ai components", "chat components", "ai ui kit", "ai interface"]
  intents: ["build chat ui", "render tool calls", "show streaming response", "add reasoning panel"]
  entities: ["AIMessage", "ToolCallDisplay", "StreamingMessage", "ReasoningPanel", "shadcn"]
---

Guidance for ai-elements. Install from registry for full content.
