---
name: benchmark-sandbox
description: Run vercel-plugin eval scenarios in Vercel Sandboxes instead of local WezTerm panels. Provisions ephemeral microVMs with Claude Code + plugin pre-installed, runs benchmark prompts, extracts hook artifacts, and produces coverage reports.
---

# Benchmark Sandbox — Remote Eval via Vercel Sandboxes

Run benchmark scenarios inside Vercel Sandboxes — ephemeral Firecracker microVMs with node24. Each sandbox gets a fresh Claude Code + Vercel CLI + agent-browser install, the local vercel-plugin uploaded, and runs a **3-phase eval pipeline**:

- **Phase 1 (BUILD)**: Claude Code builds the app with `--dangerously-skip-permissions --debug`
- **Phase 2 (VERIFY)**: A follow-up Claude Code session uses `agent-browser` to walk through user stories, fixing issues until all pass (20 min timeout)
- **Phase 3 (DEPLOY)**: A third Claude Code session links to vercel-labs, runs `vercel deploy`, and fixes build errors (up to 3 retries). Deployed apps have deployment protection enabled by default.

Skills are tracked across **all 3 phases** — each phase may trigger additional skill injections as new files/patterns are created. After each phase, a **haiku structured scoring step** (`claude -p --json-schema --model haiku`) evaluates the results as structured JSON.

## Proven Working Script

Use `run-eval.ts` — the proven eval runner:

```bash
# Run default scenarios with full 3-phase pipeline
bun run .claude/skills/benchmark-sandbox/run-eval.ts

# With dynamic scenarios from a JSON file (recommended — see "Dynamic Scenarios" below)
bun run .claude/skills/benchmark-sandbox/run-eval.ts --scenarios-file /tmp/my-scenarios.json

# Keep sandboxes alive overnight with public URLs
bun run .claude/skills/benchmark-sandbox/run-eval.ts --keep-alive --keep-hours 8

# Build-only (skip verification and deploy)
bun run .claude/skills/benchmark-sandbox/run-eval.ts --skip-verify --skip-deploy

# Run specific scenarios by slug
bun run .claude/skills/benchmark-sandbox/run-eval.ts --scenarios splitwise-clone,calendly-clone
```

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--concurrency N` | 5 | Max parallel sandboxes (max 10) |
| `--timeout MS` | 1800000 (30 min) | Per-phase timeout in ms |
| `--keep-alive` | off | Keep sandboxes running after eval |
| `--keep-hours N` | 8 | Hours to keep alive (with `--keep-alive`) |
| `--skip-verify` | off | Skip the agent-browser verification phase |
| `--skip-deploy` | off | Skip the Vercel deploy phase |
| `--scenarios a,b,c` | all | Only run specific scenarios by slug |
| `--scenarios-file path` | — | Load scenarios from a JSON file instead of built-in defaults |

## Dynamic Scenarios (Recommended Approach)

Instead of hardcoding tech-specific prompts, generate scenarios dynamically as a JSON file. Prompts should describe **real-world apps people want to build** using user stories — no tech name-dropping. Let the plugin figure out what Vercel tech to inject.

### Scenario JSON Format

```json
[
  {
    "slug": "pet-adoption-board",
    "prompt": "Build me a pet adoption listing board where shelters can post animals...",
    "expectedSkills": ["ai-sdk", "shadcn", "vercel-functions"],
    "userStories": [
      "As a visitor, I can see a grid of pet listings with photos and names",
      "As a visitor, I can click a pet card to see a detail page",
      "As a visitor, I can filter pets by type"
    ]
  }
]
```

Each scenario needs: `slug` (string), `prompt` (string), `expectedSkills` (string[]), `userStories` (tuple of exactly 3 strings).

### Prompt Design Guidelines

- Focus on **what the user wants**, not what tech to use
- Describe real-world apps that solve real problems with friendly, stylish UX
- Include AI features naturally (recommendations, analysis, generation)
- Always end with: `"Link the project to my vercel-labs team. After building all files, start the dev server on port 3000 with \`npx next dev --port 3000\`."`
- Include storage needs (photos, uploads) to trigger vercel-storage
- Include scheduled tasks (reminders, cleanup) to trigger cron-jobs
- Include auth/middleware to trigger routing-middleware

## Structured Scoring (Haiku)

Each phase gets a structured JSON score via `claude -p --json-schema --model haiku --setting-sources ""` running inside the sandbox. This is a separate quick pass — no tools, no hooks — just reads the phase output and returns structured data.

### Build Score Schema

```json
{
  "completeness": "complete|partial|minimal|empty",
  "hasApiRoutes": true,
  "hasUIComponents": true,
  "hasAIFeature": true,
  "devServerRunning": true,
  "missingFeatures": ["feature1"],
  "summary": "Brief assessment"
}
```

### Verify Score Schema (per user story)

```json
{
  "stories": [
    { "index": 1, "status": "pass|fail", "reason": "Evidence from output" }
  ]
}
```

### Deploy Score Schema

```json
{
  "deployed": true,
  "url": "https://xxx.vercel.app",
  "buildSucceeded": true,
  "errors": [],
  "summary": "Brief assessment"
}
```

**Important**: The `claude -p --output-format json` response wraps results — the actual schema data is in `parsed.structured_output`, not the top-level object.

## Critical Sandbox Environment Facts

| Property | Value |
|----------|-------|
| Home directory | `/home/vercel-sandbox` (NOT `/home/user/` or `/root/`) |
| User | `vercel-sandbox` (NOT `root`) |
| Claude binary | `/home/vercel-sandbox/.global/npm/bin/claude` |
| PATH (via sh -c) | Includes `~/.global/npm/bin` — claude findable by name |
| Port exposure | `sandbox.domain(3000)` → `https://subdomain.vercel.run` |
| Snapshot persistence | **Files AND npm globals survive** snapshot restore — use `sandbox.snapshot()` → `Sandbox.create({ source: { type: "snapshot", snapshotId } })` |
| SDK version | `@vercel/sandbox@1.8.0` (v2 beta's named sandbox endpoint returns 404 for this team) |
| Team tier | Enterprise (vercel-labs) — **no known sandbox time cap** |

### Key Discoveries (Hard-Won)

1. **Snapshots work**: `sandbox.snapshot()` preserves files AND npm globals. Use it after build to create a restore point before verify/deploy. Note: snapshotting stops the source sandbox — create a new one from the snapshot to continue.
2. **Plugin install**: Use `npx add-plugin <path> -s project -y --target claude-code` — works because claude is in PATH after `npm install -g`. The `--target claude-code` flag is required because add-plugin can't auto-detect Claude Code without an initialized `~/.claude/` dir.
3. **File uploads**: Use `sandbox.writeFiles([{ path, content: Buffer }])` — NOT runCommand heredocs. Heredocs with special characters cause 400 errors from the sandbox API.
4. **Claude flags**: Always use `--dangerously-skip-permissions --debug`. The `--debug` flag writes to `~/.claude/debug/`.
5. **Auth**: API key from macOS Keychain (`ANTHROPIC_AUTH_TOKEN` — a `vck_*` Vercel Claude Key for AI Gateway), Vercel token from `~/.local/share/com.vercel.cli/auth.json` (a `vca_*` token).
6. **OIDC for sandbox SDK**: Run `npx vercel link --scope vercel-labs -y` + `npx vercel env pull` once before first use.
7. **Port exposure**: Pass `ports: [3000]` in `Sandbox.create()` to get a public URL immediately via `sandbox.domain(3000)`. Works on v1.8.0 — URL is assigned at creation time, before anything listens.
8. **extendTimeout**: Use `sandbox.extendTimeout(ms)` to keep sandboxes alive past their initial timeout. Verified working — extends by the requested duration. Use this for overnight keep-alive.
9. **Background commands**: `runCommand` with backgrounded processes (`&` or `nohup`) may throw ZodError on v1. Write a script file first, then execute it.
10. **Session cleanup race**: The `session-end-cleanup.mjs` hook deletes `/tmp/vercel-plugin-*-seen-skills.d/` on session end. Extract artifacts BEFORE the session completes, or rely on poll history data.
11. **agent-browser works in sandboxes**: Install via `npm install -g agent-browser`. Claude Code can use it for browser-based verification inside the sandbox.
12. **No hobby tier cap**: Early 301s timeouts were from lower default timeout values in earlier script iterations, not a tier limitation. Enterprise (vercel-labs) has no known sandbox time cap — sandboxes ran 10+ minutes successfully.
13. **claude -p works inside sandboxes**: `claude -p --json-schema --output-format json --model haiku` works for structured scoring passes. No nesting issue when running inside a sandbox (only fails when running Claude inside Claude on the same machine).
14. **Deploy project naming**: ALWAYS use timestamped slugs with minute precision (e.g., `pet-adoption-board-202603101853`) to avoid collisions when linking to vercel-labs team projects. These are demo projects — we generate many per day. Format: `<slug>-<YYYYMMDDHHMM>`.

## When to Use This vs benchmark-agents

| | benchmark-agents (WezTerm) | benchmark-sandbox |
|---|---|---|
| **Environment** | Local macOS terminal panes | Remote Vercel Sandboxes (Amazon Linux) |
| **Parallelism** | Limited by local resources | Up to 10 (Hobby) or 2,000 (Pro) concurrent |
| **Session type** | Interactive TTY via `/bin/zsh -ic` | Direct `sh -c` invocation (PTY not required) |
| **Artifact access** | Direct filesystem (`~/.claude/debug/`) | `sandbox.readFile()` / poll via `runCommand` |
| **Port exposure** | `localhost:3000` | Public `https://sb-XXX.vercel.run` URLs |
| **Verification** | Manual browser check | Automated agent-browser in Phase 2 |
| **Deploy** | Manual | Automated Phase 3 → permanent `*.vercel.app` URLs |
| **Scoring** | Manual review | Haiku structured JSON scoring per phase |
| **Best for** | Manual eval + iteration loop | Automated parallel coverage + verification + deploy runs |

## How It Works

1. **Create fresh sandbox**: `Sandbox.create({ runtime: "node24", ports: [3000], env: { ANTHROPIC_API_KEY, ... } })` — no snapshot
2. **Install tools**: `npm install -g @anthropic-ai/claude-code vercel agent-browser` (~20s per sandbox)
3. **Auth Vercel CLI**: Write token to `~/.local/share/com.vercel.cli/auth.json`
4. **Upload plugin**: `sandbox.writeFiles()` for 80 plugin files, then `npx add-plugin`
5. **Phase 1 — BUILD**: Claude Code builds the app (30 min timeout)
6. **Score build**: Haiku evaluates completeness, API routes, UI, AI features
7. **Start dev server**: If not already running, start `npx next dev --port 3000`
8. **Extend timeout**: `sandbox.extendTimeout()` for verify + deploy + keep-alive
9. **Phase 2 — VERIFY**: Claude Code uses `agent-browser` to test user stories (20 min timeout). Prompt tells Claude to start dev server itself if not running.
10. **Score verify**: Haiku evaluates each user story as pass/fail with reasons
11. **Re-extract skills**: Skills re-collected after verify phase (agent-browser + code fixes trigger more)
12. **Phase 3 — DEPLOY**: Claude Code runs `vercel link` + `vercel deploy`, fixes build errors (30 min timeout)
13. **Score deploy**: Haiku evaluates deploy success, URL extraction, errors
14. **Re-extract skills**: Skills re-collected after deploy phase
15. **Write incremental results**: Each scenario writes its own `result.json` immediately on completion (survives crashes)
16. **Extract source archive**: `source.tar.gz` of project files saved locally
17. **Generate report**: Markdown report with build/verify/deploy scores, skill coverage, URLs

## Sandbox Session Flow (Per Scenario)

```
Sandbox.create({ runtime: "node24", ports: [3000], env: { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, VERCEL_PLUGIN_LOG_LEVEL: "trace" } })
  │
  ├─ npm install -g @anthropic-ai/claude-code vercel agent-browser   (~20s)
  ├─ Write Vercel CLI auth token to ~/.local/share/com.vercel.cli/auth.json
  ├─ mkdir -p /home/vercel-sandbox/<slug> && npm init -y
  ├─ sandbox.writeFiles() → /home/vercel-sandbox/vercel-plugin/  (80 files, ~945KB)
  ├─ npx add-plugin /home/vercel-sandbox/vercel-plugin -s project -y --target claude-code
  │
  ├─ Phase 1: BUILD
  │   ├─ sandbox.writeFiles() → /tmp/prompt.txt
  │   ├─ claude --dangerously-skip-permissions --debug --settings <path> "$(cat /tmp/prompt.txt)"
  │   │   (with AbortSignal.timeout(TIMEOUT_MS))
  │   ├─ Poll every 20s:
  │   │   ├─ ls /tmp/vercel-plugin-*-seen-skills.d/     (claimed skills)
  │   │   ├─ cat /tmp/vercel-plugin-*-seen-skills.txt    (seen skills snapshot)
  │   │   ├─ find ~/.claude/debug -type f                (debug log count)
  │   │   ├─ find <project> -newer /tmp/prompt.txt       (new project files)
  │   │   └─ curl localhost:3000                         (port status)
  │   ├─ Extract build artifacts
  │   └─ Haiku build score (structured JSON)
  │
  ├─ Start dev server (if not already running)
  ├─ sandbox.extendTimeout(...)
  │
  ├─ Phase 2: VERIFY (if >1 project file exists)
  │   ├─ sandbox.writeFiles() → /tmp/verify.txt  (agent-browser verification prompt)
  │   ├─ claude --dangerously-skip-permissions --debug "$(cat /tmp/verify.txt)"
  │   │   (with AbortSignal.timeout(1_200_000) — 20 min)
  │   ├─ Re-extract skills (verify phase triggers more)
  │   └─ Haiku verify score (per-story pass/fail JSON)
  │
  ├─ Phase 3: DEPLOY (if >3 project files)
  │   ├─ sandbox.writeFiles() → /tmp/deploy.txt
  │   ├─ claude --dangerously-skip-permissions --debug "$(cat /tmp/deploy.txt)"
  │   │   (links to vercel-labs, deploys, fixes build errors up to 3x)
  │   ├─ Extract deploy URL from output (*.vercel.app)
  │   ├─ Re-extract skills (deploy phase triggers more)
  │   └─ Haiku deploy score (structured JSON)
  │
  ├─ Write <slug>/result.json immediately (crash-safe)
  ├─ Update aggregate results.json (complete: false until all done)
  ├─ Extract source.tar.gz
  └─ sandbox.stop()  (skipped if --keep-alive)
```

## Verification Phase Details

The verify phase is the "closer" — its job is to make the app work and prove it. Key behaviors:

- **Always runs** if >1 project file exists (no longer gated on port 3000 being up)
- **Starts dev server itself** if not already running — the prompt tells Claude to check `localhost:3000` and run `npx next dev --port 3000` if needed
- **20 minute timeout** — enough for agent-browser to open pages, screenshot, interact, fix broken code, restart server, and re-verify
- **Triggers skill injection** — the verify session creates/edits files, triggering PreToolUse and PostToolUse hooks
- Uses agent-browser workflow: `open` → `wait --load networkidle` → `screenshot --annotate` → `snapshot -i` → interact → fix → re-verify
- Results scored by haiku — no more parsing `STORY_1: PASS` from free text

## Deploy Phase Details

The deploy phase uses a full Claude Code session (for skill tracking) to:

1. Run `vercel link --yes --scope vercel-labs --project <slug>-YYYYMMDD`
2. Run `vercel deploy --yes`
3. If build fails, fix code and retry (up to 3 attempts)
4. Important: unsets `VERCEL_TOKEN` env var so CLI falls back to `~/.local/share/com.vercel.cli/auth.json`
5. Deployment protection is enabled by default on vercel-labs team

Deploy URL is extracted by regex from Claude's output, with haiku as fallback URL extractor.

## DO NOT (Hard Rules)

Same rules as `benchmark-agents`, plus sandbox-specific:

- **DO NOT** use `claude --print` or `-p` flag for BUILD/VERIFY/DEPLOY phases — hooks don't fire without tool-calling sessions (use `-p` only for haiku scoring passes)
- **DO NOT** let sandboxes run without extracting artifacts — ephemeral filesystem is lost on stop
- **DO NOT** pass API keys via `writeFiles()` — use `Sandbox.create({ env: { ... } })`
- **DO NOT** skip snapshotting after build — it's your safety net if verify/deploy kills the sandbox
- **DO NOT** use v2 beta SDK — named sandbox endpoint returns 404 for this team; use v1.8.0
- **DO NOT** use `runCommand` heredocs to write file content — use `sandbox.writeFiles()` instead
- **DO NOT** assume `/home/user/` exists — the home dir is `/home/vercel-sandbox/`
- **DO NOT** use simple project names without timestamps — always append `-YYYYMMDDHHMM` to avoid collisions across runs

## Prerequisites

```bash
# One-time setup: link project for OIDC sandbox auth
npx vercel link --scope vercel-labs -y
npx vercel env pull .env.local

# Auth (auto-resolved from macOS Keychain + Vercel CLI auth):
# - ANTHROPIC_API_KEY: from Keychain "ANTHROPIC_AUTH_TOKEN" (vck_* key) or env var
# - VERCEL_TOKEN: from ~/.local/share/com.vercel.cli/auth.json (vca_* token) or env var
# - ANTHROPIC_BASE_URL: defaults to https://ai-gateway.vercel.sh
```

## Commands

### Run eval with dynamic scenarios (recommended)

```bash
# Generate scenarios as JSON, then run
bun run .claude/skills/benchmark-sandbox/run-eval.ts --scenarios-file /tmp/my-scenarios.json

# With all phases + keep-alive for overnight
bun run .claude/skills/benchmark-sandbox/run-eval.ts --scenarios-file /tmp/scenarios.json --keep-alive --keep-hours 8

# Build-only, no verification or deploy
bun run .claude/skills/benchmark-sandbox/run-eval.ts --scenarios-file /tmp/scenarios.json --skip-verify --skip-deploy

# Filter to specific slugs from file or defaults
bun run .claude/skills/benchmark-sandbox/run-eval.ts --scenarios splitwise-clone,calendly-clone
```

## Monitoring While Running

The orchestrator prints live status. For manual checks on a running sandbox:

```typescript
// List claimed skills
const claims = await sandbox.runCommand("sh", ["-c",
  "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null"
]);

// Check hook firing count
const hooks = await sandbox.runCommand("sh", ["-c",
  "find /home/vercel-sandbox/.claude/debug -name '*.txt' -exec grep -c 'executePreToolHooks' {} +"
]);

// Check port 3000
const port = await sandbox.runCommand("sh", ["-c",
  "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
]);

// Get public URL (after ports: [3000] in Sandbox.create)
const url = sandbox.domain(3000);
```

## Artifact Export Layout

Results are written to `~/dev/vercel-plugin-testing/sandbox-results/<run-id>/`:

```
<run-id>/
  results.json             # Aggregate results (complete: false until all done, then true)
  report.md                # Markdown report with scores, coverage, URLs
  <slug>/
    result.json            # Per-scenario result (written immediately on completion)
    source.tar.gz          # Project source archive
```

Each scenario result includes:
- `slug`, `sandboxId`, `success`, `durationMs`
- `claimedSkills[]`, `expectedSkills[]`, `projectFiles[]`
- `appUrl` — public `https://sb-XXX.vercel.run` URL (sandbox lifetime only)
- `deployUrl` — permanent `https://xxx.vercel.app` URL (if deploy succeeded)
- `pollHistory[]` — timestamped skill/file/port snapshots
- `verification` — `{ ran, exitCode, stories: [{ index, status }], output }`
- `buildScore` — haiku structured completeness assessment
- `deployScore` — haiku structured deploy assessment

The markdown report (`report.md` / `.reports/<timestamp>.md`) includes:
1. **Summary table** — slug, build status, skills, files, verify results, deploy URL, duration
2. **Per-scenario details** — build score, deploy score, verification per-story pass/fail
3. **Skill coverage** — expected vs actual per scenario, missing/bonus breakdown
4. **Total unique skills** across all scenarios

## Proven Results (2026-03-10)

Across 34 scenarios run in 5 batches:

| Metric | Best | Typical |
|--------|------|---------|
| Skills per scenario | 31 (ai-interior-designer) | 12-24 |
| Expected skill coverage | 100% (pet-adoption-board 4/4, apartment-hunting-copilot 7/7, splitwise-clone 6/6) | 50-86% |
| User stories verified | 3/3 PASS (ai-dream-journal, ai-gift-finder, ai-resume-roaster, ai-music-mood-radio, team-standup-bot, pet-adoption-board) | varies |
| Files built per scenario | 37 (student-study-groups) | 6-25 |
| Build time | 5-11 min | 5-7 min |

Key findings:
- User-story-focused prompts (no tech name-dropping) work — plugin detects patterns from actual code
- `ai-sdk`, `shadcn`, `nextjs`, `vercel-functions` are the most consistently detected skills
- `cron-jobs`, `routing-middleware` need Claude to write specific file patterns to trigger
- Lexical prompt inject (UserPromptSubmit) working — skills injected before any files written
- `session-end-cleanup` deletes claim dirs — use poll history for final skill counts
- Enterprise tier (vercel-labs) — no sandbox time cap; builds ran 10+ minutes

## Known Limitations

1. **Snapshot stops the source sandbox**: `sandbox.snapshot()` stops the original sandbox. Create a new sandbox from the snapshot to continue. Files and npm globals DO survive.
2. **v2 beta incompatible**: `@vercel/sandbox@2.0.0-beta.3`'s named sandbox endpoint returns 404 for this team. Stick with v1.8.0.
3. **Artifact window**: Must extract before `sandbox.stop()` — filesystem is ephemeral. Session cleanup hook may delete claim dirs before extraction.
4. **Amazon Linux paths**: User is `vercel-sandbox` (home at `/home/vercel-sandbox/`). NOT `/home/user/` or `/root/`.
5. **`--dangerously-skip-permissions` parity**: Sandbox evals auto-approve all tool calls. WezTerm evals use normal permission flow. Coverage results may differ.
6. **`runCommand` timeout**: Use `{ signal: AbortSignal.timeout(ms) }` — the `{ timeout }` option is silently ignored.
7. **BrotliDecompressionError**: Transient Vercel API errors can kill sandbox creation. Retry logic recommended for production runs.
8. **Deploy reliability**: Claude Code deploy sessions sometimes fail to output a parseable `*.vercel.app` URL. The haiku scoring step provides a fallback URL extraction attempt.
9. **Verify timeout**: Complex apps may need the full 20 minutes for agent-browser to test all stories. Simpler apps finish in 2-5 minutes.
