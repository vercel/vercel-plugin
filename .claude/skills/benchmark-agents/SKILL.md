---
name: benchmark-agents
description: Advanced AI agent benchmark scenarios that push Vercel's cutting-edge platform features — Workflow DevKit, AI Gateway, MCP, Chat SDK, Queues, Flags, Sandbox, and multi-agent orchestration. Designed to stress-test skill injection for complex, multi-system builds.
---

# Benchmark Agents — Advanced AI Systems

Launch real Claude Code sessions with the plugin installed, verify skill injection, monitor PostToolUse validation catches, and produce a coverage report. This skill covers the full eval loop: setup → launch → monitor → verify → fix → release → repeat.

## How Evals Work (The Only Correct Method)

Evals are run by **you, in this conversation**, not by scripts. The process is:

1. You create directories and install the plugin via Bash tool calls
2. You spawn WezTerm panes with `wezterm cli spawn` — each pane runs an independent Claude Code interactive session
3. You wait, then check debug logs and claim dirs to see what the plugin injected
4. You inspect the generated source code for correctness
5. You read conversation logs to find what the user had to correct
6. You update skills/hooks, run `/release`, and spawn more evals

**Never use `claude --print`, eval scripts, or `Bun.spawn(["claude", ...])`**. These do not work because:
- Plugin hooks (PreToolUse, PostToolUse, UserPromptSubmit) only fire during interactive tool-calling sessions
- `--print` mode generates text without executing tools — no files are created, no deps installed, no dev servers started
- No `session_id` means dedup, profiler, and claim files don't work

**The WezTerm interactive approach is the only method that exercises the plugin correctly.** Every eval in our history (60+ sessions) used this approach.

## DO NOT (Hard Rules)

These are **absolute prohibitions**. Violating any of them wastes the entire eval run:

- **DO NOT** use `claude --print` or `-p` flag — hooks don't fire, no files created
- **DO NOT** use `--dangerously-skip-permissions` — changes agent behavior
- **DO NOT** create projects in `/tmp/` — always use `~/dev/vercel-plugin-testing/`
- **DO NOT** manually create `settings.local.json` or wire hooks by hand — use `npx add-plugin`
- **DO NOT** set `CLAUDE_PLUGIN_ROOT` manually — the plugin manages this
- **DO NOT** use `bash -c` or `bash -lc` in WezTerm — always use `/bin/zsh -ic`
- **DO NOT** use the full path to claude — use the `x` alias (it's configured in zsh)
- **DO NOT** create custom `debug.log` files with stderr redirects — debug logs go to `~/.claude/debug/`
- **DO NOT** write eval runner scripts in TypeScript/JavaScript — do everything as Bash tool calls in the conversation
- **DO NOT** try to `git init` or create `package.json` manually — `npx add-plugin` + the WezTerm session handle all scaffolding
- **DO NOT** use uppercase letters in directory names — npm rejects them (e.g. `T` in timestamps breaks `create-next-app`)

**Copy the exact commands below. Do not improvise.**

## Setup & Launch (Exact Commands)

### Naming convention

**Always append a timestamp** to directory names so reruns don't overwrite old projects:

```
<slug>-<yyyymmdd>-<hhmm>
```

Example: `tarot-card-deck-20260309-1227`, `interior-designer-20260309-1227`

Generate the timestamp with: `date +%Y%m%d-%H%M`

### 1. Create test directory and install plugin

```bash
TS=$(date +%Y%m%d-%H%M)
SLUG="my-app-$TS"
mkdir -p ~/dev/vercel-plugin-testing/$SLUG
cd ~/dev/vercel-plugin-testing/$SLUG
npx add-plugin https://github.com/vercel-labs/vercel-plugin -s project -y
```

### 2. Launch session via WezTerm

```bash
wezterm cli spawn --cwd /Users/johnlindquist/dev/vercel-plugin-testing/$SLUG -- /bin/zsh -ic \
  "unset CLAUDECODE; VERCEL_PLUGIN_LOG_LEVEL=debug x '<PROMPT>' --settings .claude/settings.json; exec zsh"
```

Key flags:
- `unset CLAUDECODE` — prevents nested session detection error
- `VERCEL_PLUGIN_LOG_LEVEL=debug` — enables hook debug output in `~/.claude/debug/`
- `x` — alias for `claude` CLI
- `--settings .claude/settings.json` — loads project-level plugin settings

### 3. Find the debug log (wait ~25s for SessionStart hooks)

```bash
find ~/.claude/debug -name "*.txt" -mmin -2 -exec grep -l "$SLUG" {} +
```

### 4. Launch multiple sessions in parallel

Create dirs and install plugin in a loop, then spawn each WezTerm pane:

```bash
TS=$(date +%Y%m%d-%H%M)
cd ~/dev/vercel-plugin-testing
for name in tarot-deck interior-designer superhero-origin; do
  d="${name}-${TS}"
  mkdir -p "$d" && (cd "$d" && npx add-plugin https://github.com/vercel-labs/vercel-plugin -s project -y)
done

# Then spawn each (these run in separate terminal panes)
wezterm cli spawn --cwd .../tarot-deck-$TS -- /bin/zsh -ic "unset CLAUDECODE; VERCEL_PLUGIN_LOG_LEVEL=debug x '...' --settings .claude/settings.json; exec zsh"
wezterm cli spawn --cwd .../interior-designer-$TS -- /bin/zsh -ic "unset CLAUDECODE; VERCEL_PLUGIN_LOG_LEVEL=debug x '...' --settings .claude/settings.json; exec zsh"
wezterm cli spawn --cwd .../superhero-origin-$TS -- /bin/zsh -ic "unset CLAUDECODE; VERCEL_PLUGIN_LOG_LEVEL=debug x '...' --settings .claude/settings.json; exec zsh"
```

## Monitoring

### Skill injection claims (the key metric)

```bash
TMPDIR=$(node -e "import {tmpdir} from 'os'; console.log(tmpdir())" --input-type=module)
CLAIMDIR="$TMPDIR/vercel-plugin-<session-id>-seen-skills.d"

# List all injected skills
ls "$CLAIMDIR"

# Count
ls "$CLAIMDIR" | wc -l

# Check specific skill
ls "$CLAIMDIR/workflow" && echo "YES" || echo "NO"
```

### Hook firing

```bash
LOG=~/.claude/debug/<session-id>.txt

# SessionStart hooks
grep -c 'SessionStart.*success' "$LOG"

# PreToolUse calls and injections
grep -c 'executePreToolHooks' "$LOG"        # total calls
grep -c 'provided additionalContext' "$LOG"  # actual injections

# PostToolUse validation catches
grep 'VALIDATION' "$LOG" | head -10

# UserPromptSubmit
grep -c 'UserPromptSubmit.*success' "$LOG"
```

### Quick status check for multiple sessions

```bash
TMPDIR=$(node -e "import {tmpdir} from 'os'; console.log(tmpdir())" --input-type=module 2>/dev/null)

for label_id in "slug1:SESSION_ID_1" "slug2:SESSION_ID_2" "slug3:SESSION_ID_3"; do
  label="${label_id%%:*}"
  id="${label_id##*:}"
  claimdir="$TMPDIR/vercel-plugin-$id-seen-skills.d"
  echo "=== $label ==="
  count=$(ls "$claimdir" 2>/dev/null | wc -l | tr -d ' ')
  claims=$(ls "$claimdir" 2>/dev/null | sort | tr '\n' ', ')
  echo "Skills ($count): $claims"
done
```

## Verification — What to Check in Generated Code

After sessions build, verify these patterns in the generated projects:

### Project structure
```bash
echo -n "src/: "; test -d "$base/src" && echo YES || echo NO          # Should be NO for WDK projects
echo -n "workflows/: "; test -d "$base/workflows" && echo YES || echo NO
echo -n "withWorkflow: "; grep -q "withWorkflow" "$base"/next.config.* && echo YES || echo NO
echo -n "components.json: "; test -f "$base/components.json" && echo YES || echo NO
```

### Image generation model
```bash
# Should use gemini-3.1-flash-image-preview, NOT dall-e-3 or older gemini models
grep -rn "gemini.*image\|dall-e\|experimental_generateImage\|result\.files" "$base/workflows/" "$base/app/" 2>/dev/null | grep "\.ts"
```

### Gateway vs direct provider
```bash
# Should use gateway() or plain "provider/model" strings, NOT openai("gpt-4o") directly
grep -rn "from.*@ai-sdk/openai\|openai(" "$base" 2>/dev/null | grep "\.ts" | grep -v node_modules
grep -rn "gateway(\|model:.*\"openai/" "$base" 2>/dev/null | grep "\.ts" | grep -v node_modules
```

### AI Elements installed
```bash
find "$base" -path "*/ai-elements/*.tsx" 2>/dev/null | grep -v node_modules | wc -l
```

### Workflow API usage
```bash
wf=$(find "$base" -name "*.ts" -path "*/workflow*" 2>/dev/null | grep -v node_modules | head -1)
head -5 "$wf"   # Should show: import { getWritable } from "workflow"
```

## Prompt Design Rules

**Describe products, not technologies.** Let the plugin infer which skills to inject. This tests whether the plugin's pattern matching and prompt signals work from natural language.

### DO:
- "runs a multi-step creation pipeline that streams each phase"
- "generates a portrait image"
- "users can chat with an AI advisor"
- "store all designs in a gallery"

### DON'T:
- "use Vercel Workflow DevKit with getWritable"
- "use gateway('google/gemini-3.1-flash-image-preview')"
- "install npx ai-elements"
- "add withWorkflow to next.config.ts"

### Always end prompts with:
"Link the project to my vercel-labs team so we can deploy it later. Skip any planning and just build it. Get the dev server running."

### Phrases that trigger key skills (via promptSignals):
- **workflow**: "multi-step pipeline", "streams progress", "streams each phase", "durable pipeline", "creation pipeline"
- **ai-sdk**: Triggered by imports/install patterns (very broad)
- **shadcn**: Triggered by `create-next-app` bash pattern
- **ai-elements**: Triggered when ai-sdk is active + chat UI patterns

## Common Issues Found in Evals (and Fixes Applied)

| Issue | Cause | Plugin Fix (version) |
|-------|-------|---------------------|
| Workflow not triggered from natural language | promptSignals too narrow | Broadened phrases, lowered minScore 6→4 (v0.9.5) |
| Agent uses `openai("gpt-4o")` instead of gateway | Agent's training data defaults to openai | PostToolUse validate warns "your knowledge is outdated" (v0.9.9) |
| Agent uses `dall-e-3` for images | Agent doesn't know about gemini image gen | PostToolUse validate warns, capabilities table in ai-sdk (v0.9.7) |
| Agent uses `experimental_generateImage` | Old API | PostToolUse validate warns, recommend `generateText` + `result.files` (v0.9.9) |
| Raw markdown rendering (`**bold**` visible) | Agent skips AI Elements | `MessageResponse` documented as universal renderer (v0.9.2) |
| `@/../../workflows/` broken import | Workflows outside `@` alias root | Canonical structure docs: no `src/` for WDK (v0.8.3) |
| `withWorkflow` missing from next.config | Agent skipped setup step | Marked as "Required" in workflow skill (v0.8.1) |
| `defineHook` but no resume route | Agent didn't wire the 3-piece pattern | Documented as 3 required pieces (v0.9.3) |
| `generateObject()` used (removed in v6) | Agent's training data | PostToolUse validate catches as error (v0.9.3) |
| `getWritable()` in workflow scope | Sandbox violation | Strengthened warning in skill (v0.8.1) |
| Missing `vercel link` + `vercel env pull` | No OIDC credentials | Added as "Required" setup step (v0.9.1) |
| `getStepMetadata().retryCount` undefined on first attempt | WDK quirk | Documented: guard with `?? 0` (v0.9.1) |
| shadcn not installed | No trigger for scaffolding | Added `create-next-app` bashPattern to shadcn (v0.8.0) |
| Skill cap too low (3) | Only 3 skills injected per tool call | Raised to 5 with 18KB budget (v0.8.0) |

## Agent-Browser Verification

After dev server starts, verify with agent-browser. Note: agents currently DO NOT self-verify despite the skill being injected. You must launch verification manually:

```bash
agent-browser open http://localhost:<port>
agent-browser wait --load networkidle
agent-browser screenshot
agent-browser snapshot -i
```

## Coverage Report

Write results to `.notes/COVERAGE.md` with:

1. **Session index** — slug, session ID, unique skills, dedup status
2. **Hook coverage matrix** — which hooks fired in which sessions
3. **Skill injection table** — which of the 43 skills triggered
4. **Code quality checks** — gateway vs direct, image model, withWorkflow, AI Elements
5. **PostToolUse validation catches** — outdated models, deprecated APIs
6. **Issues found** — bugs, pattern gaps, new findings to feed back into skills

## Release → Eval Loop

The standard improvement cycle:

1. **Run evals** — launch 3 sessions with natural language prompts
2. **Check results** — skill claims, project structure, code quality
3. **Identify gaps** — what skills didn't trigger, what patterns are wrong
4. **Read conversation logs** — find user follow-up corrections
5. **Fix skills** — update SKILL.md content, patterns, validate rules
6. **Run gates** — `bun run typecheck && bun test && bun run validate`
7. **Release** — bump version, `bun run build`, commit, push
8. **Repeat** — launch 3 more evals to verify fixes

## Scenario Table

| # | Slug | Prompt Summary | Expected Skills |
|---|------|---------------|----------------|
| 01 | doc-qa-agent | PDF Q&A with embeddings, citations, multi-step reasoning | ai-sdk, nextjs, vercel-storage, ai-elements |
| 02 | customer-support-agent | Durable support agent, escalation, confidence tracking | ai-sdk, workflow, nextjs, ai-elements |
| 03 | deploy-monitor | Uptime monitoring, AI incident responder, durable investigation | workflow, cron-jobs, observability, ai-sdk |
| 04 | multi-model-router | Side-by-side model comparison, parallel streaming, cost tracking | ai-gateway, ai-sdk, nextjs, ai-elements |
| 05 | slack-pr-reviewer | Multi-platform chat bot, PR review, threaded conversations | chat-sdk, ai-sdk, nextjs |
| 06 | content-pipeline | Durable multi-step content production with image generation | workflow, ai-sdk, satori, nextjs |
| 07 | feature-rollout | Feature flags, A/B testing, AI experiment analysis | vercel-flags, ai-sdk, nextjs |
| 08 | event-driven-crm | Event-driven CRM, churn prediction, re-engagement emails | vercel-queues, workflow, ai-sdk, email |
| 09 | code-sandbox-tutor | AI coding tutor with sandbox execution, auto-fix | vercel-sandbox, ai-sdk, nextjs, ai-elements |
| 10 | multi-agent-research | Parallel sub-agents, durable orchestration, streaming synthesis | workflow, ai-sdk, ai-elements, nextjs |
| 11 | discord-game-master | RPG bot, persistent game state, scene illustration generation | chat-sdk, ai-sdk, vercel-storage, nextjs |
| 12 | compliance-auditor | Scheduled AI audits, durable approval workflow, deploy blocking | workflow, cron-jobs, ai-sdk, vercel-firewall |

## Complexity Tiers

### Tier 1 — Core AI (30-45 min, `--quick`)
Scenarios 01, 04, 09 — AI SDK, Gateway, Sandbox, AI Elements without durable workflows.

### Tier 2 — Durable Agents (45-60 min)
Scenarios 02, 03, 06, 10 — Workflow DevKit, multi-step durability, agent orchestration.

### Tier 3 — Platform Integration (45-60 min)
Scenarios 05, 07, 08, 11, 12 — Chat SDK, Queues, Flags, Firewall, cross-platform messaging.

### Full Suite
All 12 scenarios, ~3-4 hours.

## Cleanup

```bash
rm -rf ~/dev/vercel-plugin-testing
```
