# Hook Lifecycle Deep Dive

> Note: the skill-injection engines described here still exist, but their `PreToolUse` and `UserPromptSubmit` registrations are disabled in the default `hooks/hooks.json` profile.

This document covers every hook entry point in `hooks/hooks.json`, organized by lifecycle phase. Each section includes input/output contracts, sequence diagrams, and implementation details.

---

## Table of Contents

1. [Lifecycle Overview](#lifecycle-overview)
2. [SessionStart Phase](#sessionstart-phase)
   - [session-start-seen-skills](#1-session-start-seen-skills)
   - [session-start-profiler](#2-session-start-profiler)
   - [inject-claude-md](#3-inject-claude-md)
3. [PreToolUse Phase](#pretooluse-phase)
   - [pretooluse-skill-inject](#4-pretooluse-skill-inject)
4. [UserPromptSubmit Phase](#userpromptsubmit-phase)
   - [user-prompt-submit-skill-inject](#6-user-prompt-submit-skill-inject)
5. [PostToolUse Phase](#posttooluse-phase)
   - [posttooluse-shadcn-font-fix](#7-posttooluse-shadcn-font-fix)
   - [posttooluse-verification-observe](#8-posttooluse-verification-observe)
   - [posttooluse-validate](#9-posttooluse-validate)
6. [SubagentStart Phase](#subagentstart-phase)
   - [subagent-start-bootstrap](#10-subagent-start-bootstrap)
7. [SubagentStop Phase](#subagentstop-phase)
   - [subagent-stop-sync](#11-subagent-stop-sync)
8. [SessionEnd Phase](#sessionend-phase)
   - [session-end-cleanup](#12-session-end-cleanup)
9. [Hook I/O Contract](#hook-io-contract)
10. [Custom YAML Parser Semantics](#custom-yaml-parser-semantics)
11. [Environment Variables Reference](#environment-variables-reference)

---

## Lifecycle Overview

Every hook fires at a specific point in Claude Code's execution cycle. The following diagram shows the complete lifecycle from session start to session end, including all 12 hook entry points.

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant SS as SessionStart Hooks
    participant Agent as Agent (LLM)
    participant PTU as PreToolUse Hooks
    participant UPS as UserPromptSubmit Hook
    participant PostTU as PostToolUse Hooks
    participant SA as Subagent Hooks
    participant SE as SessionEnd Hook

    Note over CC,SE: Session Lifecycle

    CC->>SS: startup | resume | clear | compact
    activate SS
    SS-->>CC: Initialize dedup, profile project, inject thin session context
    deactivate SS

    loop Every user prompt
        CC->>UPS: User types a prompt
        activate UPS
        UPS-->>CC: Score prompt signals -> inject 0-2 skills
        deactivate UPS

        loop Every tool call
            CC->>PTU: Agent calls Read/Edit/Write/Bash/Agent
            activate PTU
            PTU-->>CC: Match patterns -> inject 0-3 skills
            deactivate PTU

            Agent->>Agent: Tool executes

            CC->>PostTU: Tool completes (Write/Edit/Bash)
            activate PostTU
            PostTU-->>CC: Validate files / observe verification / fix fonts
            deactivate PostTU
        end
    end

    opt Agent spawns subagent
        CC->>SA: SubagentStart
        activate SA
        SA-->>CC: Bootstrap context (1-8KB by agent type)
        deactivate SA

        Note over SA: Subagent works...

        CC->>SA: SubagentStop
        activate SA
        SA-->>CC: Write ledger, sync dedup
        deactivate SA
    end

    CC->>SE: Session ends
    activate SE
    SE-->>CC: Delete all temp files
    deactivate SE
```

---

## SessionStart Phase

These hooks fire once when a session begins, resumes, is cleared, or compacted. They set up the environment for all subsequent hooks.

**Matcher**: `startup|resume|clear|compact`

**Execution order**: Hooks run in the order listed in `hooks.json` — seen-skills first, then profiler, then inject-claude-md.

---

### 1. session-start-seen-skills

**Source**: `hooks/src/session-start-seen-skills.mts` (17 lines)
**Timeout**: None
**Output**: None (side-effect only)

#### Purpose

Initializes the dedup state by writing `VERCEL_PLUGIN_SEEN_SKILLS=""` to `CLAUDE_ENV_FILE`. This ensures the PreToolUse and UserPromptSubmit hooks start with a blank slate for skill dedup tracking.

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as session-start-seen-skills
    participant Env as CLAUDE_ENV_FILE

    CC->>Hook: SessionStart event (stdin: JSON)
    Hook->>Env: appendFileSync('export VERCEL_PLUGIN_SEEN_SKILLS=""')
    Hook-->>CC: exit 0 (no stdout)
```

#### Implementation Details

- Reads `CLAUDE_ENV_FILE` from environment (required — `requireEnvFile()` exits if missing)
- Appends a single `export` line — does not overwrite existing content
- Failures are silently ignored (non-critical)
- This must run **before** the profiler to ensure the env var exists when the profiler writes `LIKELY_SKILLS`

---

### 2. session-start-profiler

**Source**: `hooks/src/session-start-profiler.mts` (620 lines)
**Timeout**: None
**Output**: stdout text (CLI status messages), env var side-effects

#### Purpose

Scans the project's `package.json`, config files, directory structure, and Vercel CLI version to:
1. Determine which skills are likely relevant (`VERCEL_PLUGIN_LIKELY_SKILLS`)
2. Detect bootstrap/setup signals (`VERCEL_PLUGIN_BOOTSTRAP_HINTS`, `VERCEL_PLUGIN_SETUP_MODE`)
3. Detect greenfield (empty) projects (`VERCEL_PLUGIN_GREENFIELD`)
4. Check if `agent-browser` CLI is available (`VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE`)
5. Report Vercel CLI installation and update status

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as session-start-profiler
    participant FS as File System
    participant Env as CLAUDE_ENV_FILE
    participant Cache as Profile Cache (tmpdir)

    CC->>Hook: SessionStart event (stdin: { session_id })
    Hook->>FS: Check greenfield (readdirSync)
    Hook->>FS: Scan FILE_MARKERS (next.config.*, vercel.json, etc.)
    Hook->>FS: Read package.json -> match PACKAGE_MARKERS
    Hook->>FS: Read vercel.json -> check crons, rewrites, functions
    Hook->>Hook: Detect bootstrap signals (env templates, prisma, drizzle, auth)
    Hook->>Hook: Check Vercel CLI version (vercel --version + npm view)
    Hook->>Hook: Check agent-browser on PATH
    Hook->>Env: Write VERCEL_PLUGIN_LIKELY_SKILLS
    Hook->>Env: Write VERCEL_PLUGIN_GREENFIELD (if empty)
    Hook->>Env: Write VERCEL_PLUGIN_SETUP_MODE (if hints >= 3)
    Hook->>Env: Write VERCEL_PLUGIN_BOOTSTRAP_HINTS
    Hook->>Env: Write VERCEL_PLUGIN_RESOURCE_HINTS
    Hook->>Env: Write VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE
    Hook->>Cache: Write profile.json (for subagent bootstrap)
    Hook-->>CC: stdout: CLI status messages (if outdated/missing)
```

#### File Markers

The profiler checks for these files to determine likely skills:

| File | Skills Detected |
|------|-----------------|
| `next.config.{js,mjs,ts,mts}` | `nextjs`, `turbopack` |
| `turbo.json` | `turborepo` |
| `vercel.json` | `vercel-cli`, `deployments-cicd`, `vercel-functions` |
| `.mcp.json` | `vercel-api` |
| `middleware.{ts,js}` | `routing-middleware` |
| `components.json` | `shadcn` |
| `.env.local` | `env-vars` |
| `pnpm-workspace.yaml` | `turborepo` |

#### Package Markers

Dependencies in `package.json` map to skills:

| Package | Skills |
|---------|--------|
| `next` | `nextjs` |
| `ai`, `@ai-sdk/*` | `ai-sdk`, `ai-elements`, `ai-gateway` |
| `@vercel/blob`, `@vercel/kv`, `@vercel/postgres`, `@vercel/edge-config` | `vercel-storage` |
| `@vercel/analytics`, `@vercel/speed-insights` | `observability` |
| `@vercel/flags` | `vercel-flags` |
| `@vercel/workflow` | `workflow` |
| `@vercel/queue` | `vercel-queues` |
| `turbo` | `turborepo` |
| `@repo/*`, `@t3-oss/env-nextjs` | `next-forge` |

#### Bootstrap Signal Detection

The profiler detects setup/bootstrap signals that trigger `VERCEL_PLUGIN_SETUP_MODE` when 3 or more hints are found:

- **Env templates**: `.env.example`, `.env.sample`, `.env.template`
- **README**: Any file starting with `readme`
- **Database**: `drizzle.config.*`, `prisma/schema.prisma`, `db:push`/`db:seed` scripts
- **Auth**: `next-auth`, `@auth/core`, `better-auth` dependencies
- **Resources**: `@neondatabase/serverless`, `drizzle-orm`, `@upstash/redis`

#### Greenfield Detection

A project is greenfield if:
- Every top-level entry is a dot-directory (`.git`, `.claude`)
- No dot-files exist (`.env.local`, `.mcp.json` indicate real config)

Greenfield projects get default skills: `nextjs`, `ai-sdk`, `vercel-cli`, `env-vars`.

---

### 3. inject-claude-md

**Source**: `hooks/src/inject-claude-md.mts` (33 lines)
**Timeout**: None
**Output**: stdout text (vercel.md content as additionalContext)

#### Purpose

Outputs the `vercel.md` ecosystem graph (~52KB) as `additionalContext`. This gives the agent a map of the entire Vercel ecosystem before any specific skills fire. If the project is greenfield, it also appends execution mode instructions.

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as inject-claude-md
    participant FS as File System

    CC->>Hook: SessionStart event
    Hook->>FS: Read vercel.md from plugin root
    alt Greenfield project
        Hook->>Hook: Append greenfield execution instructions
        Note over Hook: "Skip planning, choose defaults, start executing"
    end
    Hook-->>CC: stdout: vercel.md content (~52KB)
```

---

## PreToolUse Phase

These hooks fire **before** a tool call executes. They can inject additional context or observe the pending action.

---

### 4. pretooluse-skill-inject

**Source**: `hooks/src/pretooluse-skill-inject.mts` (~1300 lines)
**Matcher**: `Read|Edit|Write|Bash`
**Timeout**: 5 seconds
**Output**: JSON with `additionalContext`

#### Purpose

The main injection engine. When the agent calls Read, Edit, Write, or Bash, this hook:
1. Parses the tool input (file path or bash command)
2. Matches against all skills' `pathPatterns`, `bashPatterns`, and `importPatterns`
3. Applies priority boosters (profiler, vercel.json, setup mode)
4. Deduplicates against already-injected skills
5. Injects up to 3 skills within an 18KB byte budget

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as pretooluse-skill-inject
    participant Manifest as skill-manifest.json
    participant Dedup as Dedup State
    participant Skills as SKILL.md files

    CC->>Hook: PreToolUse (stdin: { tool_name, tool_input, session_id })
    Hook->>Hook: parseInput -> extract file path or bash command
    Hook->>Manifest: Load skill map (prefer manifest over scanning)
    Hook->>Hook: compileSkillPatterns -> create regex matchers
    Hook->>Hook: matchPathWithReason / matchBashWithReason / matchImportWithReason
    Hook->>Hook: Apply vercel.json routing (+-10)
    Hook->>Hook: Apply profiler boost (+5 for LIKELY_SKILLS)
    Hook->>Hook: Apply setup mode boost (+50 if SETUP_MODE=1)
    Hook->>Hook: Check TSX review trigger (+40 after N edits)
    Hook->>Hook: Check dev server detection
    Hook->>Hook: rankEntries -> sort by final priority DESC
    Hook->>Dedup: mergeSeenSkillStates (env + file + claims)
    Hook->>Dedup: Filter already-seen skills
    loop For each ranked skill (up to 3, within 18KB)
        Hook->>Skills: Read SKILL.md body
        alt Body fits budget
            Hook->>Hook: Add full body to parts
        else Over budget
            Hook->>Hook: Add summary fallback
        end
        Hook->>Dedup: Atomic claim + update env var
    end
    Hook-->>CC: JSON { hookSpecificOutput: { additionalContext } }
```

#### Pipeline Stages

The hook is organized as a testable pipeline:

```
parseInput -> loadSkills -> matchSkills -> deduplicateSkills -> injectSkills -> formatOutput
```

#### Special Triggers

| Trigger | Condition | Effect |
|---------|-----------|--------|
| **TSX review** | After `VERCEL_PLUGIN_REVIEW_THRESHOLD` (default 3) `.tsx` edits | Injects `react-best-practices` with +40 priority boost |
| **Dev server detection** | Bash command matches `next dev`, `npm run dev`, etc. | Boosts `agent-browser-verify` |
| **Vercel env help** | First `vercel env` command | One-time injection of env-vars guidance |
| **Setup mode** | `VERCEL_PLUGIN_SETUP_MODE=1` | +50 priority boost for matched skills |

#### Input Schema

```json
{
  "tool_name": "Read|Edit|Write|Bash",
  "tool_input": {
    "file_path": "app/page.tsx",
    "command": "vercel deploy --prod"
  },
  "session_id": "abc-123",
  "cwd": "/Users/dev/my-app"
}
```

#### Output Schema

```json
{
  "hookSpecificOutput": {
    "additionalContext": "<!-- skillInjection: {...} -->\n[vercel-plugin] Best practices...\n\n<!-- skill:nextjs -->\n..."
  }
}
```

---

## UserPromptSubmit Phase

This hook fires when the user submits a prompt, before the agent processes it.

---

### 6. user-prompt-submit-skill-inject

**Source**: `hooks/src/user-prompt-submit-skill-inject.mts` (703 lines)
**Matcher**: _(all prompts)_
**Timeout**: 5 seconds
**Output**: JSON with `additionalContext`

#### Purpose

Scores the user's prompt text against `promptSignals` defined in skill frontmatter. Injects up to 2 skills within an 8KB budget. Also handles troubleshooting intent routing and investigation companion selection.

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as user-prompt-submit
    participant Skills as Skill Map
    participant Dedup as Dedup State
    participant Analysis as Prompt Analysis

    CC->>Hook: UserPromptSubmit (stdin: { prompt, session_id })
    Hook->>Hook: parsePromptInput -> validate length >= 10 chars
    Hook->>Hook: normalizePromptText -> lowercase, expand contractions
    Hook->>Skills: loadSkills -> build skill map
    Hook->>Analysis: analyzePrompt -> score all skills with promptSignals

    loop For each skill with promptSignals
        Analysis->>Analysis: Score phrases (+6 each)
        Analysis->>Analysis: Score allOf groups (+4 per match)
        Analysis->>Analysis: Score anyOf terms (+1 each, cap +2)
        Analysis->>Analysis: Check noneOf (-Infinity if matched)
        Analysis->>Analysis: Compare score vs minScore (default 6)
    end

    Hook->>Hook: classifyTroubleshootingIntent
    alt Investigation mode triggered
        Hook->>Hook: selectInvestigationCompanion
        Note over Hook: Pick best from: workflow, agent-browser-verify, vercel-cli
    end
    alt Test framework mentioned
        Hook->>Hook: Suppress verification-family skills
    end

    Hook->>Dedup: Filter already-seen skills
    Hook->>Hook: Cap at 2 skills, enforce 8KB budget

    loop For each selected skill
        Hook->>Skills: Read SKILL.md body
        Hook->>Dedup: Atomic claim + sync
    end

    Hook-->>CC: JSON { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }
```

#### Scoring Example

Given a skill with:
```yaml
promptSignals:
  phrases: ["deploy to preview"]  # +6
  allOf: [["deploy", "branch"]]   # +4
  anyOf: ["ci", "github"]         # +1 each, cap +2
  noneOf: ["rollback"]
  minScore: 6
```

- Prompt "how do I deploy to preview?" -> phrase match (+6) -> score 6 >= minScore 6 -> **matched**
- Prompt "deploy my branch to CI" -> allOf (+4) + anyOf "ci" (+1) -> score 5 < minScore 6 -> **not matched**
- Prompt "rollback the deploy" -> noneOf "rollback" -> score -Infinity -> **suppressed**

#### Investigation Companion Selection

When `investigation-mode` is selected, the hook picks the best companion skill:

| Priority | Companion | When Selected |
|----------|-----------|---------------|
| 1st | `workflow` | Best score among companions |
| 2nd | `agent-browser-verify` | If workflow doesn't match |
| 3rd | `vercel-cli` | Fallback companion |

---

## PostToolUse Phase

These hooks fire **after** a tool call completes. They observe results, validate outputs, or apply fixes.

---

### 7. posttooluse-shadcn-font-fix

Removed from the runtime. This hook was deleted as part of the hook-reduction pass.

---

### 8. posttooluse-verification-observe

**Source**: `hooks/src/posttooluse-verification-observe.mts` (285 lines)
**Matcher**: `Bash`
**Timeout**: 5 seconds
**Output**: `{}` (observer only — emits structured log events)

#### Purpose

After a Bash command completes, classifies the command into a verification boundary type and emits structured log events. This powers the verification pipeline that tracks whether the agent is testing at all system boundaries.

#### Boundary Classification

| Boundary | Pattern Examples | Label |
|----------|-----------------|-------|
| `uiRender` | `open`, `screenshot`, `playwright`, `puppeteer` | Browser/UI interaction |
| `clientRequest` | `curl`, `wget`, `fetch(`, `httpie` | HTTP client requests |
| `serverHandler` | `tail -f *.log`, `vercel logs`, port inspection | Server/log inspection |
| `environment` | `printenv`, `vercel env`, `cat .env` | Environment reads |

#### Story Inference

The hook infers the target route from two sources (in priority order):
1. `VERCEL_PLUGIN_RECENT_EDITS` — file paths recently edited, e.g. `app/settings/page.tsx` -> `/settings`
2. URL patterns in the command itself, e.g. `curl http://localhost:3000/api/data` -> `/api/data`

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as posttooluse-verification-observe
    participant Log as Structured Logger

    CC->>Hook: PostToolUse (stdin: { tool_name: "Bash", tool_input: { command } })
    Hook->>Hook: parseInput -> extract command
    Hook->>Hook: classifyBoundary(command)
    alt Boundary matched
        Hook->>Hook: inferRoute(command, RECENT_EDITS)
        Hook->>Log: Emit verification.boundary_observed event
        Note over Log: { boundary, verificationId, command, inferredRoute }
    end
    Hook-->>CC: "{}" (observer only)
```

---

### 9. posttooluse-validate

Removed from the runtime. This hook and its validated-file dedup state were deleted as part of the hook-reduction pass.

---

## SubagentStart Phase

This hook fires when any subagent starts.

---

### 10. subagent-start-bootstrap

**Source**: `hooks/src/subagent-start-bootstrap.mts` (427 lines)
**Matcher**: `.+` (any subagent)
**Timeout**: 5 seconds
**Output**: JSON with `additionalContext`

#### Purpose

When any subagent starts, bootstraps it with relevant skill context. The context size is tailored to the agent type:

| Agent Type | Budget | Content Strategy |
|------------|--------|------------------|
| `Explore` | 1KB (minimal) | Project profile line + skill name list |
| `Plan` | 3KB (light) | Profile + skill summaries + deployment constraints |
| `general-purpose` | 8KB (standard) | Profile + full skill bodies (with summary fallback) |
| Other/custom | 8KB (standard) | Same as general-purpose |

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as subagent-start-bootstrap
    participant Cache as Profile Cache
    participant Skills as Skill Map
    participant Dedup as Dedup Claims

    CC->>Hook: SubagentStart (stdin: { session_id, agent_id, agent_type })
    Hook->>Cache: Read profiler cache (profile.json)
    alt Cache hit
        Hook->>Hook: Use cached likelySkills
    else Cache miss
        Hook->>Hook: Fallback to VERCEL_PLUGIN_LIKELY_SKILLS env var
    end
    Hook->>Hook: resolveBudgetCategory(agentType)
    alt Minimal (Explore)
        Hook->>Hook: buildMinimalContext (profile + skill names)
    else Light (Plan)
        Hook->>Skills: Load skill summaries within 3KB
        Hook->>Hook: buildLightContext (profile + summaries + constraints)
    else Standard (general-purpose)
        Hook->>Skills: Load full SKILL.md bodies within 8KB
        Hook->>Hook: buildStandardContext (profile + full bodies)
    end
    Hook->>Dedup: Claim injected skills (scoped by agentId)
    Hook-->>CC: JSON { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } }
```

## SubagentStop Phase

This hook fires when any subagent stops.

---

### 11. subagent-stop-sync

**Source**: `hooks/src/subagent-stop-sync.mts` (141 lines)
**Matcher**: `.+` (any subagent)
**Timeout**: 5 seconds
**Output**: None (side-effect only)

#### Purpose

When any subagent stops, writes a JSONL ledger entry for observability and counts the skills injected for that agent.

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as subagent-stop-sync
    participant Ledger as Ledger File (JSONL)
    participant Dedup as Dedup Claims

    CC->>Hook: SubagentStop (stdin: { session_id, agent_id, agent_type, agent_transcript_path })
    Hook->>Ledger: Append JSONL record
    Note over Ledger: <tmpdir>/vercel-plugin-<sid>-subagent-ledger.jsonl
    Hook->>Dedup: Count skills injected for this agent (scoped claims)
    Hook->>Hook: Log summary (agent_id, agent_type, skills_injected)
    Hook-->>CC: exit 0 (no stdout)
```

#### Ledger Entry Format

```json
{
  "timestamp": "2026-03-10T12:00:00.000Z",
  "session_id": "abc-123",
  "agent_id": "agent-456",
  "agent_type": "Explore",
  "agent_transcript_path": "/path/to/transcript"
}
```

---

## SessionEnd Phase

This hook fires when the session ends.

---

### 12. session-end-cleanup

**Source**: `hooks/src/session-end-cleanup.mts` (81 lines)
**Matcher**: None (fires on all session ends)
**Timeout**: None
**Output**: None (side-effect only)

#### Purpose

Best-effort cleanup of all session-scoped temporary files. Always exits successfully, even if cleanup fails.

#### What Gets Cleaned Up

| Path Pattern | Type | Contents |
|-------------|------|----------|
| `<tmpdir>/vercel-plugin-<sid>-seen-skills.d/` | Directory | Atomic skill claim files |
| `<tmpdir>/vercel-plugin-<sid>-seen-skills.txt` | File | Comma-delimited seen skills |
| `<tmpdir>/vercel-plugin-<sid>-subagent-ledger.jsonl` | File | Subagent lifecycle ledger |
| `<tmpdir>/vercel-plugin-<sid>-profile.json` | File | Profiler cache |
| `<tmpdir>/vercel-plugin-<sid>-validated-files.txt` | File | Validation dedup state |

#### Sequence

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Hook as session-end-cleanup
    participant FS as File System (tmpdir)

    CC->>Hook: SessionEnd (stdin: { session_id })
    Hook->>Hook: Parse session_id from stdin
    Hook->>Hook: Hash session_id if non-alphanumeric
    Hook->>FS: readdirSync(tmpdir) -> filter by prefix
    loop For each matching entry
        alt Entry ends with .d
            Hook->>FS: rmSync(path, { recursive: true })
        else Regular file
            Hook->>FS: unlinkSync(path)
        end
    end
    Hook-->>CC: exit 0 (always succeeds)
```

---

## Hook I/O Contract

All hooks follow the same I/O contract defined by `SyncHookJSONOutput` from `@anthropic-ai/claude-agent-sdk`:

### Input (stdin)

```json
{
  "tool_name": "Read",
  "tool_input": { "file_path": "app/page.tsx" },
  "session_id": "abc-123",
  "cwd": "/Users/dev/my-app",
  "hook_event_name": "PreToolUse"
}
```

For `UserPromptSubmit`:
```json
{
  "prompt": "How do I deploy to preview?",
  "session_id": "abc-123",
  "cwd": "/Users/dev/my-app",
  "hook_event_name": "UserPromptSubmit"
}
```

For `SubagentStart` / `SubagentStop`:
```json
{
  "session_id": "abc-123",
  "cwd": "/Users/dev/my-app",
  "agent_id": "agent-456",
  "agent_type": "Explore",
  "hook_event_name": "SubagentStart"
}
```

### Output (stdout)

Hooks that inject context return:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "<!-- skill:nextjs -->\n..."
  }
}
```

Observer-only hooks and hooks with no matches return:
```json
{}
```

### Error Handling

All hooks follow defensive patterns:
- Catch all errors and log to stderr
- Always write valid JSON to stdout (at minimum `{}`)
- Never crash the Claude Code session — graceful degradation is preferred
- Timeouts (5s) kill the hook process; Claude Code continues without the hook's output

---

## Custom YAML Parser Semantics

The plugin uses `parseSimpleYaml` (in `hooks/src/skill-map-frontmatter.mts`), a custom inline YAML parser purpose-built for skill frontmatter. It is **not** `js-yaml`.

### Why a Custom Parser?

Skill frontmatter values are always used as strings for pattern matching. The standard YAML spec converts values like `null`, `true`, and `false` to their JavaScript equivalents, which would break pattern matching.

### Behavioral Differences

| Input | Standard YAML (js-yaml) | vercel-plugin parser | Rationale |
|-------|------------------------|---------------------|-----------|
| Bare `null` | JavaScript `null` | String `"null"` | Patterns should always be strings |
| Bare `true` | JavaScript `true` | String `"true"` | No type coercion |
| Bare `false` | JavaScript `false` | String `"false"` | No type coercion |
| Unclosed `[items` | Parse error (throws) | Scalar string `"[items"` | Graceful degradation |
| Tab indentation | Allowed | **Explicit error thrown** | Prevents hard-to-debug whitespace issues |
| `---` delimiters | Standard | Standard | Same behavior |
| Nested objects | Full support | Indentation-based nesting | Same behavior |
| Array items (`- item`) | Standard | Standard | Same behavior |
| Inline arrays (`[a, b]`) | Standard | Standard | Same behavior |

### Tab Error Example

```yaml
---
name: my-skill
metadata:
	priority: 6    # <-- Tab character: parser throws explicit error
---
```

The parser will throw with a message indicating the tab character and line number, making it easy to find and fix.

### Frontmatter Extraction

The `extractFrontmatter()` function splits a SKILL.md into:
- `yaml`: The raw YAML string between `---` delimiters
- `body`: The markdown content after the closing `---`

The `buildSkillMap()` function reads all `skills/*/SKILL.md` files, extracts frontmatter, parses it with `parseSimpleYaml`, validates the structure, and returns a `Record<string, SkillConfig>` keyed by skill slug.

---

## Environment Variables Reference

### Plugin-Controlled Variables

These are set and read by the plugin's hooks. Writers and readers are listed to show data flow.

| Variable | Default | Writer(s) | Reader(s) | Lifecycle |
|----------|---------|-----------|-----------|-----------|
| `VERCEL_PLUGIN_SEEN_SKILLS` | `""` | `session-start-seen-skills` (init), `pretooluse-skill-inject` (append), `user-prompt-submit` (append) | `pretooluse-skill-inject`, `user-prompt-submit` | Session-scoped |
| `VERCEL_PLUGIN_LIKELY_SKILLS` | — | `session-start-profiler` | `pretooluse-skill-inject`, `subagent-start-bootstrap` | Session-scoped |
| `VERCEL_PLUGIN_GREENFIELD` | — | `session-start-profiler` | `inject-claude-md` | Session-scoped |
| `VERCEL_PLUGIN_SETUP_MODE` | — | `session-start-profiler` | `pretooluse-skill-inject` | Session-scoped |
| `VERCEL_PLUGIN_BOOTSTRAP_HINTS` | — | `session-start-profiler` | — | Session-scoped |
| `VERCEL_PLUGIN_RESOURCE_HINTS` | — | `session-start-profiler` | — | Session-scoped |
| `VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE` | — | `session-start-profiler` | `pretooluse-skill-inject` | Session-scoped |
| `VERCEL_PLUGIN_TSX_EDIT_COUNT` | `0` | `pretooluse-skill-inject` | `pretooluse-skill-inject` | Session-scoped, counter |
| `VERCEL_PLUGIN_DEV_VERIFY_COUNT` | `0` | `pretooluse-skill-inject` | `pretooluse-skill-inject` | Session-scoped, counter |
| `VERCEL_PLUGIN_DEV_COMMAND` | — | `pretooluse-skill-inject` | `pretooluse-skill-inject` | Session-scoped |
| `VERCEL_PLUGIN_RECENT_EDITS` | — | `pretooluse-skill-inject` | `posttooluse-verification-observe` | Session-scoped |

### User-Configurable Variables

These can be set by the user to customize plugin behavior.

| Variable | Default | Effect |
|----------|---------|--------|
| `VERCEL_PLUGIN_LOG_LEVEL` | `off` | Logging verbosity: `off`, `summary`, `debug`, `trace` |
| `VERCEL_PLUGIN_DEBUG` | — | Legacy: `1` maps to `debug` level |
| `VERCEL_PLUGIN_HOOK_DEBUG` | — | Legacy: `1` maps to `debug` level |
| `VERCEL_PLUGIN_HOOK_DEDUP` | — | `off` to disable dedup entirely |
| `VERCEL_PLUGIN_INJECTION_BUDGET` | `18000` | PreToolUse byte budget (bytes) |
| `VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET` | `8000` | UserPromptSubmit byte budget (bytes) |
| `VERCEL_PLUGIN_REVIEW_THRESHOLD` | `3` | Number of TSX edits before injecting `react-best-practices` |
| `VERCEL_PLUGIN_AUDIT_LOG_FILE` | — | Path to audit log file, or `off` to disable |
| `VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE` | `5.0` | Minimum score for lexical fallback results |

### Claude Code-Provided Variables

These are set by Claude Code itself and used by hooks.

| Variable | Description |
|----------|-------------|
| `CLAUDE_ENV_FILE` | Path to env file for persisting variables across hook invocations |
| `CLAUDE_PLUGIN_ROOT` | Root directory of the plugin installation |
| `CLAUDE_PROJECT_ROOT` | Root directory of the user's project |
| `SESSION_ID` | Fallback session ID (used when not provided in stdin) |
