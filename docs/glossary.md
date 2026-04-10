# Glossary

Definitions of project-specific terms used throughout the vercel-plugin codebase and documentation.

---

| Term | Definition |
|------|-----------|
| **additionalContext** | The field in a Claude Code hook's JSON output (`SyncHookJSONOutput`) used to inject skill content into Claude's context window. Each hook invocation can return one or more `additionalContext` entries. |
| **allOf** | A prompt signal group where **all** terms must appear in the user's prompt for the group to score. Each matching `allOf` group contributes **+4** to the skill's prompt score. Defined in `metadata.promptSignals.allOf`. |
| **anyOf** | A prompt signal list where **any** matching term adds **+1**, capped at **+2** total. Used for broad topic hints that shouldn't dominate scoring. Defined in `metadata.promptSignals.anyOf`. |
| **Atomic claim** | A zero-byte file created with `openSync(path, "wx")` (`O_EXCL` flag) in the claim directory. The OS guarantees only one process succeeds, providing exactly-once injection semantics even under concurrent hook invocations. See **Claim directory**. |
| **Budget** | The maximum byte size of skill content injectable per hook invocation. PreToolUse: **3 skills / 18 KB** (`VERCEL_PLUGIN_INJECTION_BUDGET`). UserPromptSubmit: **2 skills / 8 KB** (`VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET`). When a skill body exceeds remaining budget, its `summary` field is injected as a compact fallback. |
| **Claim directory** | A per-session directory at `<tmpdir>/vercel-plugin-<sessionId>-seen-skills.d/` containing one empty file per already-injected skill. The primary layer of the three-layer dedup system. Cleaned up by `session-end-cleanup`. |
| **Compiled pattern** | A `{ pattern: string, regex: RegExp }` pair produced at build time (for manifest entries) or at runtime (for live SKILL.md scanning). Glob patterns are converted to regex via `globToRegex()` in `patterns.mts`. |
| **Dedup** | The deduplication system preventing the same skill from being injected more than once per session. Merges three state sources: atomic file claims, `VERCEL_PLUGIN_SEEN_SKILLS` env var, and a session file — unioned by `mergeSeenSkillStates()`. |
| **Effective priority** | A skill's final ranking score after all boosts are applied: base `metadata.priority` (4–8) + profiler boost (+5) + vercel.json routing (±10) + special triggers (+40/+50). Higher values are injected first. |
| **Frontmatter** | The YAML block between `---` delimiters at the top of each `SKILL.md` file. Contains `name`, `description`, `summary`, `metadata` (priority, patterns, prompt signals, validation rules). Parsed by `parseSimpleYaml` — not `js-yaml`. |
| **Greenfield** | A project state detected by the profiler when the working directory is empty or lacks meaningful source files. Triggers automatic prioritization of the `bootstrap` skill. Signaled via `VERCEL_PLUGIN_GREENFIELD=true`. |
| **Hook** | A TypeScript function registered in `hooks/hooks.json` that fires on a Claude Code lifecycle event such as `SessionStart`, `PreToolUse`, `UserPromptSubmit`, or `SessionEnd`. Hooks decide what knowledge Claude receives and when. |
| **Injection** | The act of inserting a skill's markdown body into Claude's `additionalContext` during a hook invocation. Gated by pattern matching, priority ranking, dedup checks, and budget limits. |
| **Invocation ID** | An 8-character hex string (`randomBytes(4).toString("hex")`) shared across all logger instances within a single hook process. Used to correlate log lines from the same hook invocation. |
| **Lexical index** | A fallback scoring system (`lexical-index.mts`) that tokenizes prompt text and matches against skill keywords when no prompt signals fire. Returns scored results above `VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE` (default 5.0). |
| **Manifest** | The pre-compiled skill index at `generated/skill-manifest.json`. Built by `scripts/build-manifest.ts`, it converts glob patterns to regex at build time. Version 2 format with paired arrays (`pathPatterns` ↔ `pathRegexSources`, etc.). |
| **mergeSeenSkillStates()** | The function that unions all three dedup state sources (claim directory files, env var, session file) into a single set of seen skill names. Ensures consistency even if one source is stale. |
| **minScore** | The threshold a skill's prompt signal score must reach before it qualifies for injection via `UserPromptSubmit`. Default is **6**. Configured per-skill in `metadata.promptSignals.minScore`. |
| **noneOf** | A prompt signal blocklist. If **any** `noneOf` term appears in the user's prompt, the skill's score is set to `-Infinity`, hard-suppressing it. Prevents false-positive injections. Defined in `metadata.promptSignals.noneOf`. |
| **parseSimpleYaml** | The plugin's custom YAML parser (in `skill-map-frontmatter.mts`). Intentionally differs from `js-yaml`: bare `null` → string `"null"`, bare `true`/`false` → strings, unclosed `[` → scalar string, tab indentation → error. |
| **Phrases** | Prompt signal keywords that score **+6** each via exact case-insensitive substring matching. The strongest single-term signal. Defined in `metadata.promptSignals.phrases`. |
| **Profiler** | The `session-start-profiler` hook. Scans `package.json` dependencies, config files (`vercel.json`, `next.config.*`), and project structure at session start. Sets `VERCEL_PLUGIN_LIKELY_SKILLS` (comma-delimited), granting matched skills a **+5 priority boost**. |
| **Prompt signals** | The scoring system in `UserPromptSubmit` that matches user prompt text against skill-defined keywords. Composed of `phrases` (+6), `allOf` (+4), `anyOf` (+1 capped at +2), and `noneOf` (hard suppress). Compiled by `prompt-patterns.mts`. |
| **Session file** | A text file at `<tmpdir>/vercel-plugin-<sessionId>-seen-skills.txt` containing a comma-delimited snapshot of seen skills. The second layer of the dedup system, synced from the claim directory. |
| **Skill** | A self-contained knowledge module in `skills/<name>/SKILL.md`. Each has YAML frontmatter (defining when to inject) and a markdown body (the content injected into Claude's context). Skills are the unit of domain knowledge. The plugin ships 46 skills. |
| **Skill map** | The in-memory `Map<string, SkillEntry>` built by `buildSkillMap()` from either the manifest or live SKILL.md files. Maps skill name → compiled patterns, priority, summary, and validation rules. |
| **Summary fallback** | When a skill's full markdown body would exceed the remaining injection budget, the hook injects the skill's `summary` field instead — a compact one-line description that still provides useful context. |
| **SyncHookJSONOutput** | The TypeScript type (from `@anthropic-ai/claude-agent-sdk`) defining the JSON structure hooks must return. Key fields: `additionalContext` (injected content), `env` (environment variable updates), `decision` (allow/block). |
| **Template include** | The `{{include:skill:<name>:<heading>}}` marker syntax used in `.md.tmpl` files. Resolved at build time by `scripts/build-from-skills.ts`, which extracts sections from SKILL.md files and compiles them into the output `.md` files. |
| **TSX review trigger** | A special PreToolUse behavior: after `VERCEL_PLUGIN_REVIEW_THRESHOLD` (default 3) `.tsx` file edits, the `react-best-practices` skill is injected with a **+40 priority boost**. Counter tracked in `VERCEL_PLUGIN_TSX_EDIT_COUNT`. |
| **Validation rules** | Per-skill `metadata.validate` entries stored in skill frontmatter. The current runtime does not register a default post-tool validation hook, so these rules are metadata only unless that path is reintroduced. |
| **vercel.json routing** | Priority adjustments (±10) applied by `vercel-config.mts` based on keys present in the project's `vercel.json`. For example, `rewrites` boosts `routing-middleware`; `crons` boosts `cron-jobs`. |

---

## See Also

- [Architecture Overview](./01-architecture-overview.md) — system diagram and core concepts
- [Injection Pipeline](./02-injection-pipeline.md) — how pattern matching, ranking, and budget work together
- [Operations & Debugging](./04-operations-debugging.md) — environment variables and troubleshooting
- [Observability Guide](./observability.md) — log levels, structured logging, and audit trails
