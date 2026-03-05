# Skill-Map Maintainer Guide

This document covers everything needed to add, modify, or debug skill mappings
in `hooks/skill-map.json` without reading the hook source code.

## How the Hook Works (30-second overview)

When Claude uses a Read/Edit/Write/Bash tool, the PreToolUse hook:

1. Loads `hooks/skill-map.json`
2. Matches the tool target (file path or bash command) against every skill's patterns
3. Sorts matches by **priority DESC**, then **skill name ASC** (deterministic)
4. Caps at **3 skills** per invocation
5. Reads each matched skill's `skills/<name>/SKILL.md` and injects it as `additionalContext`
6. Deduplicates per session — a skill is only injected once

---

## Skill Entry Schema

Each key under `"skills"` maps a skill name to a config object:

```jsonc
{
  "skills": {
    "my-skill": {
      "priority": 6,            // number, required in practice (defaults to 0)
      "pathPatterns": [          // string[], globs matched against file paths
        "lib/my-feature/**"
      ],
      "bashPatterns": [          // string[], regexes matched against bash commands
        "\\bmy-tool\\s+run\\b"
      ]
    }
  }
}
```

| Field          | Type       | Default | Description                                              |
|----------------|------------|---------|----------------------------------------------------------|
| `priority`     | `number`   | `0`     | Higher = injected first when multiple skills match        |
| `pathPatterns` | `string[]` | `[]`    | Glob patterns matched against Read/Edit/Write file paths  |
| `bashPatterns` | `string[]` | `[]`    | Regex patterns matched against Bash tool commands         |

No other keys are recognized. Unknown keys produce a validation warning.

### Metadata Version

The hook emits a `skillInjection` metadata block (currently **version 1**) alongside
`additionalContext`. The schema:

```jsonc
{
  "version": 1,
  "toolName": "Read",           // which tool triggered the match
  "toolTarget": "src/app/...",  // file path or bash command
  "matchedSkills": ["nextjs"],  // all skills that matched (before cap)
  "injectedSkills": ["nextjs"], // skills actually injected (after cap + dedup)
  "droppedByCap": []            // skills matched but dropped by the 3-skill cap
}
```

---

## Choosing a Priority

Priority determines which skills get injected when more than 3 match.

| Range | Use For                           | Examples                                    |
|-------|-----------------------------------|---------------------------------------------|
| 8     | Domain-specific, high-signal      | `ai-sdk`, `vercel-functions`                |
| 7     | Important integrations            | `ai-gateway`, `vercel-storage`, `vercel-api`, `env-vars` |
| 6     | Feature-area skills               | `routing-middleware`, `vercel-flags`, `cron-jobs`, `observability`, `deployments-cicd` |
| 5     | Framework / broad matching        | `nextjs`, `turborepo`, `shadcn`, `v0-dev`   |
| 4     | CLI tools, low-specificity        | `vercel-cli`, `turbopack`, `json-render`    |
| 3     | Rare / niche                      | `marketplace`                               |

**Rules of thumb:**

- If the skill covers a narrow, well-defined API surface, use **7-8**.
- If the skill covers a broad framework or many file types, use **5-6**.
- If the skill is a fallback or rarely triggered, use **3-4**.
- When two skills share the same path (e.g., `vercel.json` triggers both `cron-jobs` and `vercel-functions`), the higher-priority skill is injected first.
- **Tie-breaking is alphabetical by skill name** — so same-priority skills produce deterministic ordering across platforms.

---

## Glob Syntax for `pathPatterns`

Patterns use a simplified glob syntax (not full minimatch):

| Pattern     | Meaning                                        | Example Match                |
|-------------|------------------------------------------------|------------------------------|
| `*`         | Any characters except `/`                      | `next.config.*` matches `next.config.js`, `next.config.mjs` |
| `**`        | Zero or more path segments (must use `**/`)    | `app/**/route.*` matches `app/api/users/route.ts` |
| `?`         | Any single character except `/`                | `middleware.?s` matches `middleware.ts`, `middleware.js` |
| Literal     | Exact match                                    | `vercel.json` matches only `vercel.json` |

### Matching behavior

Paths are matched three ways (first match wins):

1. **Full path** — the glob is tested against the entire file path
2. **Basename** — the glob is tested against just the filename
3. **Suffix segments** — progressively longer path suffixes are tested

This means `vercel.json` will match `/Users/me/project/vercel.json` via basename,
and `app/**/route.*` will match `/Users/me/project/app/api/route.ts` via suffix.

### Examples

```jsonc
// Match all files in app/ and nested subdirectories
"app/**"

// Match route handlers at any depth under app/
"app/**/route.*"

// Match Next.js config regardless of extension
"next.config.*"

// Match monorepo apps
"apps/*/vercel.json"
"apps/*/src/app/**"
```

---

## Regex Syntax for `bashPatterns`

Patterns are standard JavaScript `RegExp` strings (no delimiters, no flags).
They are tested against the full bash command string.

### Examples

```jsonc
// Match "next dev", "next build", "next start", "next lint"
"\\bnext\\s+(dev|build|start|lint)\\b"

// Match package install commands for a specific package
"\\bnpm\\s+(install|i|add)\\s+[^\\n]*@vercel/blob\\b"

// Match the vercel CLI as a standalone command
"^\\s*vercel(?:\\s|$)"
```

**Tips:**
- Use `\\b` for word boundaries to avoid false positives
- Use `\\s+` instead of literal spaces for robustness
- Remember to double-escape backslashes in JSON strings (`\\b` not `\b`)
- Invalid regex patterns are silently skipped with an `issue` event in debug mode

---

## Adding a New Skill (Step-by-Step)

1. **Create the skill content:** `skills/<name>/SKILL.md`
2. **Add the mapping** to `hooks/skill-map.json` under `"skills"`:
   ```jsonc
   "my-new-skill": {
     "priority": 6,
     "pathPatterns": ["lib/my-feature/**"],
     "bashPatterns": ["\\bmy-tool\\s+run\\b"]
   }
   ```
3. **Pick a priority** using the table above.
4. **Run the tests:** `bun test`
5. **Verify debug output** (optional): `VERCEL_PLUGIN_DEBUG=1` — see below.

---

## Debugging with `VERCEL_PLUGIN_DEBUG=1`

Set either environment variable to enable JSON-lines debug output on stderr:

```bash
VERCEL_PLUGIN_DEBUG=1
# or
VERCEL_PLUGIN_HOOK_DEBUG=1
```

### Debug events emitted

| Event               | When                                        | Key fields                          |
|---------------------|---------------------------------------------|-------------------------------------|
| `input-parsed`      | After reading stdin                         | `toolName`, `sessionId`             |
| `tool-target`       | After parsing tool target (redacted)        | `toolName`, `target`                |
| `skillmap-loaded`   | After loading skill-map.json                | `skillCount`                        |
| `matches-found`     | After pattern matching                      | `matched[]`, `reasons{}`            |
| `dedup-filtered`    | After filtering already-injected skills     | `newSkills[]`, `previouslyInjected[]` |
| `cap-applied`       | When matches exceed MAX_SKILLS (3)          | `selected[]`, `dropped[]`           |
| `skills-injected`   | After reading SKILL.md files                | `injected[]`, `totalParts`          |
| `complete`          | At the end of every invocation              | `result`, `elapsed_ms`, `timing_ms` |
| `issue`             | On any warning or error                     | `code`, `message`, `hint`           |

### Issue codes

| Code                  | Meaning                                   |
|-----------------------|-------------------------------------------|
| `STDIN_EMPTY`         | No data on stdin                          |
| `STDIN_PARSE_FAIL`    | stdin is not valid JSON                   |
| `SKILLMAP_LOAD_FAIL`  | skill-map.json missing or invalid         |
| `SKILLMAP_EMPTY`      | skill-map has no skills                   |
| `DEDUP_READ_FAIL`     | Could not read session dedup state        |
| `DEDUP_WRITE_FAIL`    | Could not persist session dedup state     |
| `SKILL_FILE_MISSING`  | `skills/<name>/SKILL.md` not found        |
| `BASH_REGEX_INVALID`  | A bashPatterns entry is not valid regex   |

### Redaction behavior

When debug mode logs bash commands (the `tool-target` event), sensitive values
are automatically masked:

- Environment-style secrets: `MY_TOKEN=abc123` becomes `TOKEN=[REDACTED]`
- Flag-style secrets: `--password abc` becomes `--password [REDACTED]`
- Patterns matched: `TOKEN=`, `KEY=`, `SECRET=`, `--token`, `--password`, `--api-key`
- Commands longer than 200 characters are truncated with `…[truncated]`

Redaction only applies to debug logs — actual tool commands are never modified.

---

## Other Environment Variables

| Variable                       | Effect                                          |
|--------------------------------|-------------------------------------------------|
| `VERCEL_PLUGIN_HOOK_DEDUP=off` | Disable session dedup (every match re-injects)  |
| `RESET_DEDUP=1`               | Clear the dedup file before matching             |
| `SESSION_ID`                   | Override session ID (fallback if stdin omits it) |
