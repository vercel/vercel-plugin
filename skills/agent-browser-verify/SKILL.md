---
name: agent-browser-verify
description: Automated browser verification for dev servers. Triggers when a dev server starts to run a visual gut-check with agent-browser — verifies the page loads, checks for console errors, validates key UI elements, and reports pass/fail before continuing.
metadata:
  priority: 2
  pathPatterns: []
  bashPatterns:
    - '\bnext\s+dev\b'
    - '\bnpm\s+run\s+dev\b'
    - '\bpnpm\s+dev\b'
    - '\bbun\s+run\s+dev\b'
    - '\byarn\s+dev\b'
    - '\bvite\s*(dev)?\b'
    - '\bnuxt\s+dev\b'
    - '\bvercel\s+dev\b'
---

# Dev Server Verification with agent-browser

**You MUST verify the dev server with agent-browser after starting it.** Do not assume the page works just because the dev server process started. Many issues (blank pages, hydration errors, missing env vars, broken imports) are only visible in the browser. Run this verification before continuing with any other work:

## Quick Verification Flow

```bash
# 1. Open the dev server
agent-browser open http://localhost:3000
agent-browser wait --load networkidle

# 2. Screenshot for visual check
agent-browser screenshot --annotate

# 3. Check for errors
agent-browser eval 'JSON.stringify(window.__consoleErrors || [])'

# 4. Snapshot interactive elements
agent-browser snapshot -i
```

## Verification Checklist

Run each check and report results:

1. **Page loads** — `agent-browser open` succeeds without timeout
2. **No blank page** — snapshot shows meaningful content (not empty body)
3. **No error overlay** — no Next.js/Vite error overlay detected
4. **Console errors** — evaluate `document.querySelectorAll('[data-nextjs-dialog]')` for error modals
5. **Key elements render** — snapshot `-i` shows expected interactive elements
6. **Navigation works** — if multiple routes exist, verify at least the home route

## Error Detection

```bash
# Check for framework error overlays
agent-browser eval 'document.querySelector("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay") ? "ERROR_OVERLAY" : "OK"'

# Check page isn't blank
agent-browser eval 'document.body.innerText.trim().length > 0 ? "HAS_CONTENT" : "BLANK"'
```

## On Failure

If verification fails:

1. Screenshot the error state: `agent-browser screenshot error-state.png`
2. Capture the error overlay text or console output
3. Close the browser: `agent-browser close`
4. Fix the issue in code
5. Re-run verification (max 2 retry cycles to avoid infinite loops)

## On Success

```bash
agent-browser close
```

Report: "Dev server verified — page loads, no errors detected, key UI elements render correctly."
