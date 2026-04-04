---
name: vercel-sandbox
registry: vercel-labs/agent-browser
priority: 4
docs: https://vercel.com/docs/sandbox
sitemap: https://vercel.com/sitemap/docs.xml
bashPatterns:
  - "\\bnpm\\s+(install|i|add)\\s+[^\\n]*@vercel/sandbox\\b"
  - "\\bpnpm\\s+(install|i|add)\\s+[^\\n]*@vercel/sandbox\\b"
  - "\\bbun\\s+(install|i|add)\\s+[^\\n]*@vercel/sandbox\\b"
  - "\\byarn\\s+add\\s+[^\\n]*@vercel/sandbox\\b"
importPatterns:
  - "@vercel/sandbox"
promptSignals:
  phrases:
    - "@vercel/sandbox"
    - "sandbox"
    - "code sandbox"
    - "vercel sandbox"
    - "isolated environment"
    - "sandboxed execution"
  allOf:
    - ["sandbox", "code"]
    - ["sandbox", "execute"]
    - ["sandbox", "run"]
    - ["sandbox", "isolated"]
    - ["sandbox", "safe"]
    - ["sandbox", "environment"]
    - ["isolated", "execute"]
    - ["isolated", "code"]
    - ["isolated", "environment"]
    - ["isolated", "run"]
    - ["safe", "execute"]
    - ["safe", "code"]
    - ["untrusted", "code"]
    - ["untrusted", "execute"]
    - ["code", "runner"]
    - ["code", "playground"]
    - ["execute", "safely"]
    - ["run", "safely"]
    - ["run", "isolation"]
    - ["execute", "isolation"]
    - ["ffmpeg", "process"]
    - ["ffmpeg", "convert"]
    - ["ffmpeg", "compress"]
    - ["student", "code"]
    - ["student", "execute"]
    - ["student", "run"]
  anyOf:
    - "sandbox"
    - "isolated"
    - "isolation"
    - "untrusted"
    - "safely"
    - "microvm"
    - "ffmpeg"
    - "playground"
  noneOf:
    - "iframe sandbox"
    - "sandbox attribute"
    - "codesandbox.io"
    - "stackblitz"
  minScore: 4
chainTo:
  - pattern: "from\\s+[''\"\"]vm2[''\"\"]|require\\s*\\(\\s*[''\"\"]vm2[''\"\"\\)]|new\\s+VM\\("
    targetSkill: vercel-sandbox
    message: "vm2 detected — it has known security vulnerabilities. Reloading Vercel Sandbox guidance for Firecracker microVM-based safe execution."
  - pattern: "child_process.*exec\\(|execSync\\(|spawn\\(.*\\{.*shell:\\s*true"
    targetSkill: ai-sdk
    message: "Shell exec for code execution detected — loading AI SDK guidance for tool-calling patterns that pair with Vercel Sandbox for safe agent execution."
retrieval:
  aliases: ["code sandbox", "microvm", "isolated execution", "safe code runner"]
  intents: ["run untrusted code", "execute code safely", "create sandbox", "isolate code execution"]
  entities: ["Vercel Sandbox", "Firecracker", "microVM", "isolated execution"]
---

Guidance for vercel-sandbox. Install from registry for full content.
