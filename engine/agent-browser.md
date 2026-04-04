---
name: agent-browser
registry: vercel-labs/agent-browser
priority: 3
docs: https://docs.anthropic.com/en/docs/claude-code/sub-agents
pathPatterns:
  - "agent-browser.json"
  - "playwright.config.*"
  - "e2e/**"
  - "tests/e2e/**"
  - "test/e2e/**"
  - "cypress/**"
  - "cypress.config.*"
bashPatterns:
  - "\\bagent-browser\\b"
  - "\\bnext\\s+dev\\b"
  - "\\bnpm\\s+run\\s+dev\\b"
  - "\\bpnpm\\s+dev\\b"
  - "\\bbun\\s+run\\s+dev\\b"
  - "\\byarn\\s+dev\\b"
  - "\\bvite\\b"
  - "\\bnuxt\\s+dev\\b"
  - "\\bvercel\\s+dev\\b"
  - "\\blocalhost:\\d+"
  - "\\b127\\.0\\.0\\.1:\\d+"
  - "\\bcurl\\s+.*localhost"
  - "\\bopen\\s+https?://"
  - "\\bplaywright\\b"
  - "\\bcypress\\b"
chainTo:
  - pattern: "localhost:\\d+|127\\.0\\.0\\.1:\\d+"
    targetSkill: agent-browser-verify
    message: "Dev server URL detected — loading browser verification skill to run a visual gut-check (page loads, console errors, key UI elements)."
  - pattern: "playwright\\.config|cypress\\.config|\\.spec\\.(ts|js)|\\.test\\.(ts|js).*browser"
    targetSkill: nextjs
    message: "End-to-end test configuration detected — loading Next.js guidance for framework-aware test setup and dev server integration."
retrieval:
  aliases: ["browser automation", "puppeteer", "playwright", "web scraping"]
  intents: ["automate browser", "take screenshot", "test web app", "fill form", "click button"]
  entities: ["Puppeteer", "Playwright", "screenshot", "browser", "headless"]
---

Guidance for agent-browser. Install from registry for full content.
