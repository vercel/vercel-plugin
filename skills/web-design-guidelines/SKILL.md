---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  priority: 5
  docs:
    - "https://github.com/vercel-labs/web-interface-guidelines"
  pathPatterns:
    - 'app/**/page.tsx'
    - 'app/**/layout.tsx'
    - 'src/app/**/page.tsx'
    - 'src/app/**/layout.tsx'
    - 'pages/**/*.tsx'
    - 'src/pages/**/*.tsx'
    - 'components/ui/**'
    - 'src/components/ui/**'
  promptSignals:
    phrases:
      - "web interface guidelines"
      - "review my UI"
      - "review my ui"
      - "check accessibility"
      - "audit design"
      - "review UX"
      - "review ux"
      - "check my site against best practices"
      - "UI review"
      - "ui review"
      - "UX review"
      - "ux review"
      - "design review"
      - "accessibility audit"
      - "a11y audit"
      - "a11y review"
      - "UI best practices"
      - "ui best practices"
      - "web design guidelines"
      - "interface guidelines"
    allOf:
      - [review, UI]
      - [review, ui]
      - [review, design]
      - [review, accessibility]
      - [review, a11y]
      - [audit, UI]
      - [audit, ui]
      - [audit, design]
      - [audit, accessibility]
      - [check, accessibility]
      - [check, a11y]
      - [check, design]
      - [best, practices, UI]
      - [best, practices, ui]
    anyOf:
      - "accessibility"
      - "a11y"
      - "UI review"
      - "UX review"
      - "design audit"
    noneOf:
      - "backend"
      - "API design"
      - "database schema"
    minScore: 6
retrieval:
  aliases:
    - UI review
    - design audit
    - accessibility check
    - UX review
  intents:
    - review UI code
    - check accessibility
    - audit design quality
    - verify web best practices
  entities:
    - Web Interface Guidelines
    - accessibility
    - a11y

---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Fetch the latest guidelines from the source URL below
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the fetched guidelines
4. Output findings in the terse `file:line` format

## Guidelines Source

Fetch fresh guidelines before each review:

```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Use WebFetch to retrieve the latest rules. The fetched content contains all the rules and output format instructions.

## Usage

When a user provides a file or pattern argument:

1. Fetch guidelines from the source URL above
2. Read the specified files
3. Apply all rules from the fetched guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.
