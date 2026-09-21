---
name: release
description: Release vercel-plugin — run gates, bump version, generate artifacts, commit, and push. Use when asked to "release", "ship", "bump and push", or "cut a release".
---

# Release

End-to-end release workflow for vercel-plugin.

## Workflow

### 1. Pre-flight checks

Run all gates in parallel:

```bash
bun run typecheck          # tsc --noEmit on hooks/src
bun test                   # all test files
bun run validate           # skill frontmatter + manifest integrity
```

**Stop if any gate fails.** Fix issues before proceeding.

### 2. Determine version bump

Read the current version from `.plugin/plugin.json`. Ask the user which semver component to bump if not specified:

| Bump  | When                                      |
|-------|-------------------------------------------|
| patch | Bug fixes, test/fixture updates, docs     |
| minor | New skills, new hooks, new features       |
| major | Breaking changes to hook API or skill map |

Default to **patch** if the user says "release" without specifying.

### 3. Bump version

Update the `version` field in `.plugin/plugin.json`. This is the **only** version source of truth.

### 4. Rebuild generated artifacts

```bash
bun run build              # hooks (tsup) + manifest
```

This merges upstream skills with their overlays, compiles `hooks/src/*.mts` → `hooks/*.mjs`, and resolves agent/command templates. Skill metadata is read directly from `SKILL.md` files.

### 5. Stage, commit, and push

```bash
git add -A
git commit -m "<summary>; bump to <new-version>"
git push
```

Commit message style: match existing convention — descriptive summary followed by `; bump to X.Y.Z` (see git log for examples).

The pre-commit hook will re-run typecheck and recompile hooks automatically. If it fails, fix the issue and create a **new** commit (never amend).

## Version source of truth

`.plugin/plugin.json` — the `version` field. There is no `package.json` version to sync.

## Checklist (copy into your reasoning)

- [ ] typecheck passes
- [ ] tests pass
- [ ] validate passes
- [ ] `.plugin/plugin.json` version bumped
- [ ] `bun run build` succeeded
- [ ] commit includes all changes
- [ ] pushed to main
