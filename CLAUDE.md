# vercel-plugin Development Guide

## Quick Reference

- **Build hooks**: `bun run build:hooks` (compiles `hooks/src/*.mts` → `hooks/*.mjs` via tsup)
- **Build manifest**: `bun run build:manifest` (generates `generated/skill-manifest.json` from SKILL.md frontmatter)
- **Build from skills**: `bun run build:from-skills` (compiles `*.md.tmpl` → `*.md` by resolving `{{include:skill:…}}` markers)
- **Check from skills**: `bun run build:from-skills:check` (verify generated `.md` files are up-to-date; exits non-zero on drift)
- **Build all**: `bun run build` (hooks + manifest + from-skills)
- **Test**: `bun test` (typecheck + 32 test files)
- **Single test**: `bun test tests/<file>.test.ts`
- **Typecheck only**: `bun run typecheck` (tsc on hooks/tsconfig.json)
- **Validate skills**: `bun run validate` (structural validation of all skills + manifest)
- **Doctor**: `bun run doctor` (self-diagnosis: manifest parity, hook timeouts, dedup health)
- **Update snapshots**: `bun test:update-snapshots` (regenerate golden snapshot baselines)
- **Playground**: `bun run playground:generate` (generate static skill files for external tools)

Run `bun run build:hooks` after editing any `.mts` file. A pre-commit hook auto-compiles when `.mts` files are staged.

Run `bun run build:from-skills` after editing any skill referenced by a `.md.tmpl` template. The `build` script includes this step automatically.

## Architecture

### Hook Registration (`hooks/hooks.json`)

All hooks are registered in `hooks/hooks.json` and run via `node "${CLAUDE_PLUGIN_ROOT}/hooks/<file>.mjs"`. Hook output is type-checked against `SyncHookJSONOutput` from `@anthropic-ai/claude-agent-sdk`.

| Event | Hook | Matcher | Timeout |
|-------|------|---------|---------|
| SessionStart | `session-start-seen-skills.mjs` | `startup\|resume\|clear\|compact` | — |
| SessionStart | `session-start-profiler.mjs` | `startup\|resume\|clear\|compact` | — |
| SessionStart | `inject-claude-md.mjs` | `startup\|resume\|clear\|compact` | — |
| SessionEnd | `session-end-cleanup.mjs` | — | — |

### Hook Source Files (`hooks/src/*.mts`)

Source lives in `hooks/src/*.mts` (TypeScript) and compiles to `hooks/*.mjs` (ESM, committed).

**Entry-point hooks** (wired in hooks.json):
- `session-start-seen-skills.mts` — initializes `VERCEL_PLUGIN_SEEN_SKILLS=""` in `CLAUDE_ENV_FILE`
- `session-start-profiler.mts` — scans config files + package deps → sets `VERCEL_PLUGIN_LIKELY_SKILLS` (+5 priority boost); detects greenfield mode
- `inject-claude-md.mts` — outputs the thin session-start Vercel context plus knowledge update guidance
- `session-end-cleanup.mts` — deletes session-scoped temp files

**Library modules** (imported by entry-point hooks):
- `hook-env.mts` — shared runtime helpers (env parsing, path resolution)
- `skill-map-frontmatter.mts` — YAML parser + frontmatter extraction + `buildSkillMap()` + `validateSkillMap()`
- `patterns.mts` — glob→regex conversion, seen-skills helpers, ranking, atomic file claims
- `prompt-patterns.mts` — prompt signal compiler + scorer (phrases/allOf/anyOf/noneOf)
- `prompt-analysis.mts` — dry-run analysis reports for prompt matching
- `vercel-config.mts` — vercel.json key→skill routing (±10 priority)
- `logger.mts` — structured JSON logging to stderr (off/summary/debug/trace)

### Skill Injection Flow

1. **SessionStart**: Profiler scans project → sets `VERCEL_PLUGIN_LIKELY_SKILLS`
2. **PreToolUse** (on Read/Edit/Write/Bash): Match file paths (glob), bash commands (regex), imports (regex+flags) → apply vercel.json routing → apply profiler boost → rank by priority → dedup → inject up to 3 skills within 18KB budget
3. **UserPromptSubmit**: Score prompt text against `promptSignals` (phrases/allOf/anyOf/noneOf) → inject up to 2 skills within 8KB budget
   - **3b. Lexical fallback** (when `VERCEL_PLUGIN_LEXICAL_PROMPT=on`): If phrase/allOf/anyOf scoring yields no matches above `minScore`, re-score using a lexical stemmer that normalizes prompt tokens before comparison — catches natural phrasing that exact-substring matching misses
4. **SessionEnd**: Clean up session-scoped temp files

Special triggers in PreToolUse:
- **TSX review**: After N `.tsx` edits (default 3), injects `react-best-practices`
- **Dev server detection**: Boosts `agent-browser-verify` when dev server patterns appear
- **Vercel env help**: One-time injection for `vercel env` commands

### Skill Structure (`skills/<name>/SKILL.md`)

43 skills in `skills/`. Each has a `SKILL.md` with YAML frontmatter:

```yaml
---
name: skill-slug
description: "One-line description"
summary: "Brief fallback (injected when budget exceeded)"
metadata:
  priority: 6                    # 4-8 range; higher = injected first
  pathPatterns: ["glob1"]        # File glob patterns
  bashPatterns: ["regex1"]       # Bash command regex patterns
  importPatterns: ["package"]    # Import/require patterns
  promptSignals:                 # UserPromptSubmit scoring
    phrases: ["key phrase"]      # +6 each (exact substring, case-insensitive)
    allOf: [["term1", "term2"]]  # +4 per group (all must match)
    anyOf: ["optional"]          # +1 each, capped at +2
    noneOf: ["exclude"]          # Hard suppress (score → -Infinity)
    minScore: 6                  # Threshold (default 6)
  validate:                      # PostToolUse validation rules
    - pattern: "regex"
      message: "Error description"
      severity: "error|recommended|warn"
      skipIfFileContains: "regex" # Optional conditional skip
---
# Skill body (markdown, injected as additionalContext)
```

### Manifest (`generated/skill-manifest.json`)

Built by `scripts/build-manifest.ts`. Pre-compiles glob→regex at build time for runtime speed. Version 2 format with paired arrays (`pathPatterns` ↔ `pathRegexSources`, etc.). Hooks prefer manifest over live SKILL.md scanning.

### Dedup Contract

Prevents the same skill from being injected twice in a session. Shared across PreToolUse and UserPromptSubmit hooks.

- **Claim dir**: `<tmpdir>/vercel-plugin-<sessionId>-seen-skills.d/` — one empty file per claimed skill, created atomically with `openSync(path, "wx")` (O_EXCL)
- **Session file**: `<tmpdir>/vercel-plugin-<sessionId>-seen-skills.txt` — comma-delimited snapshot synced from claim dir
- **Env var**: `VERCEL_PLUGIN_SEEN_SKILLS` — initialized by session-start, updated by hooks
- **State merge**: `mergeSeenSkillStates()` unions all three sources
- **Cleanup**: `session-end-cleanup.mjs` deletes temp files + claim dirs
- **Strategies** (debug mode): `"file"` (atomic claims) → `"env-var"` (fallback) → `"memory-only"` (single invocation) → `"disabled"` (`VERCEL_PLUGIN_HOOK_DEDUP=off`)

### YAML Parser

Uses inline `parseSimpleYaml` in `skill-map-frontmatter.mjs`, **not** js-yaml:
- Bare `null` → string `"null"`, not JavaScript `null`
- Bare `true`/`false` → strings, not booleans
- Unclosed `[` → scalar string, not parse error
- Tab indentation → explicit error

### CLI (`src/cli/`)

- `vercel-plugin explain <target> [--json] [--project <path>] [--likely-skills s1,s2] [--budget <bytes>]` — shows which skills match a file path or bash command, with priority breakdown and budget simulation
- `vercel-plugin doctor` — validates manifest parity, hook timeout risk, dedup correctness, skill map errors

### Playground (`.playground/`)

Generates static skill files for external tools (Cursor, VSCode Copilot, Gemini CLI, etc.). Run `bun run playground:generate`. Generators live in `.playground/<tool-name>/`, fixtures in `.playground/_fixtures/`, snapshots in `.playground/_snapshots/`.

### Template Include Engine (`scripts/build-from-skills.ts`)

Agents and commands derive instructions from skills via `.md.tmpl` templates. Skills are the single source of truth — templates pull content at build time so agents/commands stay in sync without duplicating prose.

**Convention**: `agents/<name>.md.tmpl` and `commands/<name>.md.tmpl` compile to `agents/<name>.md` and `commands/<name>.md` (committed). Two include marker formats:

```
{{include:skill:<name>:<heading>}}            — extracts a markdown section by heading
{{include:skill:<name>:frontmatter:<field>}}  — extracts a frontmatter field value
```

Heading extraction is case-insensitive and captures everything from the heading to the next heading of equal or higher level.

**Build**: `bun run build:from-skills` resolves all includes and writes output files. `bun run build:from-skills:check` verifies outputs are up-to-date (useful in CI). Both are part of `bun run build`.

**Current templates** (8): `agents/ai-architect.md.tmpl`, `agents/deployment-expert.md.tmpl`, `agents/performance-optimizer.md.tmpl`, `commands/bootstrap.md.tmpl`, `commands/deploy.md.tmpl`, `commands/env.md.tmpl`, `commands/marketplace.md.tmpl`, `commands/status.md.tmpl`.

## Testing

32 test files across `tests/`. Key categories:

- **Hook integration**: `session-start-profiler`, `session-start-seen-skills`
- **Pattern matching**: `patterns`, `fuzz-glob`, `fuzz-yaml`, `prompt-signals`, `prompt-analysis`
- **Snapshots**: `snapshot-runner` (golden snapshots of skill injection metadata per vercel.json fixture), `snapshots` (snapshot assertions)
- **Validation**: `validate`, `validate-rules`, `build-skill-map`
- **Benchmark**: `benchmark-pipeline`, `benchmark-analyze`
- **CLI**: `cli-explain`
- **Specialized**: `notion-clone-patterns`, `slack-clone-patterns`, `tsx-review-trigger`, `dev-server-verify`, `subagent-fresh-env`, `session-timeline-subagent`

Snapshot updates: `bun run test:update-snapshots` (sets `UPDATE_SNAPSHOTS=1`).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VERCEL_PLUGIN_LOG_LEVEL` | `off` | `off` / `summary` / `debug` / `trace` |
| `VERCEL_PLUGIN_DEBUG` | — | Legacy: `1` maps to `debug` level |
| `VERCEL_PLUGIN_HOOK_DEBUG` | — | Legacy: `1` maps to `debug` level |
| `VERCEL_PLUGIN_SEEN_SKILLS` | `""` | Comma-delimited already-injected skills |
| `VERCEL_PLUGIN_HOOK_DEDUP` | — | `off` to disable dedup entirely |
| `VERCEL_PLUGIN_LIKELY_SKILLS` | — | Profiler-set comma-delimited skills (+5 boost) |
| `VERCEL_PLUGIN_GREENFIELD` | — | `true` if project is empty (profiler sets) |
| `VERCEL_PLUGIN_INJECTION_BUDGET` | `18000` | PreToolUse byte budget |
| `VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET` | `8000` | UserPromptSubmit byte budget |
| `VERCEL_PLUGIN_REVIEW_THRESHOLD` | `3` | TSX edits before react-best-practices injection |
| `VERCEL_PLUGIN_TSX_EDIT_COUNT` | `0` | Current .tsx edit count (PreToolUse tracks) |
| `VERCEL_PLUGIN_AUDIT_LOG_FILE` | — | Audit log path or `off` |
| `VERCEL_PLUGIN_LEXICAL_PROMPT` | `on` | `0` to disable lexical stemmer fallback in UserPromptSubmit scoring |
