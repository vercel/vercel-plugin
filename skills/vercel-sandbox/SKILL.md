---
name: vercel-sandbox
description: Vercel Sandbox guidance — ephemeral Firecracker microVMs for running untrusted code safely. Supports AI agents, code generation, and experimentation. Use when executing user-generated or AI-generated code in isolation.
summary: "Run untrusted/AI-generated code in ephemeral Firecracker microVMs via @vercel/sandbox. Core loop: `const s = await Sandbox.create(); try { const r = await s.runCommand('python3', ['-c', code]); } finally { await s.stop(); }`. runCommand has no shell (wrap pipes/redirects in `bash -c`) and does not throw on non-zero exit (check r.exitCode). Default image is Ubuntu (`apt-get update` before install). Persistence is on by default (auto-snapshot on stop, resume by name; only the filesystem survives). For untrusted code use `networkPolicy: 'deny-all'`, a short `timeout`, and `persistent: false`. Credential brokering: a firewall `transform` injects a secret header on egress so the VM never holds it. AI agents reach models with no API key via the AI Gateway (`https://ai-gateway.vercel.sh`, `Authorization: Bearer $VERCEL_OIDC_TOKEN`) — the token is not auto-injected, so pass it via `env` or broker it. Full docs: https://vercel.com/docs/sandbox"
metadata:
  priority: 4
  docs:
    - "https://vercel.com/docs/sandbox"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns: []
  importPatterns:
    - '@vercel/sandbox'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*@vercel/sandbox\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@vercel/sandbox\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@vercel/sandbox\b'
    - '\byarn\s+add\s+[^\n]*@vercel/sandbox\b'
  promptSignals:
    phrases:
      - "@vercel/sandbox"
      - "sandbox"
      - "code sandbox"
      - "vercel sandbox"
      - "isolated environment"
      - "sandboxed execution"
    allOf:
      - [sandbox, code]
      - [sandbox, execute]
      - [sandbox, run]
      - [sandbox, isolated]
      - [sandbox, safe]
      - [sandbox, environment]
      - [isolated, execute]
      - [isolated, code]
      - [isolated, environment]
      - [isolated, run]
      - [safe, execute]
      - [safe, code]
      - [untrusted, code]
      - [untrusted, execute]
      - [code, runner]
      - [code, playground]
      - [execute, safely]
      - [run, safely]
      - [run, isolation]
      - [execute, isolation]
      - [ffmpeg, process]
      - [ffmpeg, convert]
      - [ffmpeg, compress]
      - [student, code]
      - [student, execute]
      - [student, run]
    anyOf:
      - "sandbox"
      - "isolated"
      - "isolation"
      - "untrusted"
      - "safely"
      - "microvm"
      - "ffmpeg"
      - "playground"
    noneOf:
      - "iframe sandbox"
      - "sandbox attribute"
      - "codesandbox.io"
      - "stackblitz"
    minScore: 4
retrieval:
  aliases:
    - code sandbox
    - microvm
    - isolated execution
    - safe code runner
  intents:
    - run untrusted code
    - execute code safely
    - create sandbox
    - isolate code execution
  entities:
    - Vercel Sandbox
    - Firecracker
    - microVM
    - isolated execution
chainTo:
  -
    pattern: 'from\s+[''""]vm2[''""]|require\s*\(\s*[''""]vm2[''""\)]|new\s+VM\('
    targetSkill: vercel-sandbox
    message: 'vm2 detected — it has known security vulnerabilities. Reloading Vercel Sandbox guidance for Firecracker microVM-based safe execution.'
  -
    pattern: 'child_process.*exec\(|execSync\(|spawn\(.*\{.*shell:\s*true'
    targetSkill: ai-sdk
    message: 'Shell exec for code execution detected — loading AI SDK guidance for tool-calling patterns that pair with Vercel Sandbox for safe agent execution.'

---

# Vercel Sandbox

Vercel Sandbox runs untrusted or AI-generated code inside an ephemeral Firecracker microVM. You get a real Linux VM with a filesystem and network — created on demand over an API, and stopped (or snapshotted) when you're done. Reach for it when code you don't fully trust needs to run: AI agent tool calls, code generation, user submissions, builds, or experiments.

Do **not** use in-process sandboxes like `vm2` (known escapes) or `child_process`/`eval` for untrusted code. Those share your process; a Sandbox is a separate VM.

## Install

```bash
pnpm add @vercel/sandbox   # or npm i / yarn add / bun add
```

There is also a Python SDK (`vercel` package, `vercel.sandbox`) and a `sandbox` CLI. This skill shows the JS SDK unless noted.

## Minimal example

The core loop is create → run → stop. For one-off work, stop in a `finally` so a thrown error can't leak a running VM (you're billed while it runs). `stop()` is safe to call more than once.

```ts
import { Sandbox } from "@vercel/sandbox";

const sandbox = await Sandbox.create();
try {
  const result = await sandbox.runCommand("python3", ["-c", "print(2 + 2)"]);
  console.log(await result.stdout()); // "4\n"
  console.log(result.exitCode);       // 0
} finally {
  await sandbox.stop();
}
```

`Sandbox.create()` with no arguments boots the default image (`vercel/sandbox/universal`, Ubuntu with Node.js 24, Python 3.14 as `python3`, and common tools), 2 vCPUs, and a 5-minute timeout.

## Authentication

- **On Vercel** (Functions, Cron, builds): the SDK authenticates automatically via the deployment's OIDC token. No config.
- **Local dev**: run `vercel link` then `vercel env pull` to get a `VERCEL_OIDC_TOKEN` in `.env.local` (valid ~12h; re-pull when it expires).
- **External / CI** (no OIDC available): set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`. The SDK picks these up automatically.

This is auth for the process **calling** the SDK. It is separate from any credential you want available **inside** the VM — the sandbox does not automatically carry your `VERCEL_OIDC_TOKEN` (see [Running AI agents](#running-ai-agents-in-a-sandbox)).

## Creating a sandbox

Common `Sandbox.create()` options (all optional):

| Option | Default | Notes |
|---|---|---|
| `image` | `vercel/sandbox/universal` | Managed image, or a custom/public VCR image. See [Images](#images). |
| `resources` | `{ vcpus: 2 }` | `vcpus` can be `1` or an even number up to the plan max (Hobby 4, Pro 8, Enterprise 32). Each vCPU includes 2 GB RAM. Use `1` for cheap, low-intensity untrusted runs. |
| `timeout` | `300_000` (5 min) | Session timeout in ms. When it elapses the session is stopped and any in-flight `runCommand` **rejects**. Extend with `sandbox.extendTimeout(ms)` up to the plan max session (Hobby 45 min, Pro/Ent 24h). |
| `ports` | `[]` | Ports to expose, up to 15. Reach them with `sandbox.domain(port)`. Your server must listen on `0.0.0.0` (not `127.0.0.1`) to be reachable. |
| `region` | project default or `iad1` | One of 19 regions. |
| `persistent` | `true` | Auto-snapshots on stop and resumes on next call. Pass `false` for one-off work to avoid snapshot storage cost. |
| `networkPolicy` | `"allow-all"` | Use `"deny-all"` or an allow-list for untrusted code. See [Network policy](#network-policy-and-credential-brokering). |
| `env` | – | Environment variables for every command. Per-command `env` overrides these. Use this to inject a credential into the VM. |
| `name` | auto-generated | Unique per project, immutable. Used to retrieve/resume a persistent sandbox. |
| `tags` | – | Up to 5 key-value pairs for filtering in `Sandbox.list()`. |

## Running commands

`runCommand` runs a binary directly — **there is no shell**, so pipes, redirects, `&&`, and globs do not work unless you invoke a shell yourself. It **resolves with the finished command regardless of exit code** (it does not throw on a non-zero exit); check `result.exitCode`. It only rejects on an actual failure to run — e.g. the session timing out mid-command.

Commands run as a **non-root** user (`ubuntu`, in the sudo group) by default; pass `sudo: true` for root.

```ts
const r = await sandbox.runCommand("npm", ["install"]);
if (r.exitCode !== 0) throw new Error(await r.stderr()); // non-zero does NOT throw

// Needs a shell for the redirect / pipe. Use absolute paths (see below).
await sandbox.runCommand("bash", ["-c", "echo hi > /vercel/sandbox/out.txt && cat /vercel/sandbox/out.txt"]);

// Root for one command (sudo is object-form only)
await sandbox.runCommand({ cmd: "apt-get", args: ["update"], sudo: true });

// Long-running process: detached (object form only) returns immediately
const server = await sandbox.runCommand({ cmd: "npm", args: ["run", "dev"], detached: true });
```

`runCommand` returns a finished command with `await result.stdout()`, `await result.stderr()`, and `result.exitCode` (or a live `Command` when `detached: true`). The object form also takes `cwd`, `env`, and `stdout`/`stderr` (a `Writable` to stream into). `sudo` and `detached` are object-form only.

**Working directory**: the file methods below are rooted at `/vercel/sandbox`, but do not assume a command's default working directory is the same. Whenever a command reads or writes files you created with `writeFiles`/`readFileToBuffer`, use **absolute paths under `/vercel/sandbox`** (or pass an explicit `cwd`) so both sides point at the same place.

## Files

File-method paths are relative to `/vercel/sandbox` unless absolute. `content` must be a `Buffer`.

```ts
await sandbox.writeFiles([
  { path: "input.txt", content: Buffer.from("line one\nline two\n") },
  { path: "run.sh", content: Buffer.from("#!/bin/bash\necho hi"), mode: 0o755 },
]);

// readFileToBuffer returns a Buffer, or null if the file is missing — guard it.
// (readFile returns a ReadableStream; neither returns a string, so convert yourself.)
const buf = await sandbox.readFileToBuffer({ path: "input.txt" });
const text = buf?.toString("utf8") ?? "";

await sandbox.mkDir("src/generated");
```

To pull source in at create time, use `source`: a git repo (`{ type: "git", url, username, password, depth?, revision? }` — `username`/`password` authenticate a private repo), a `tarball` (`{ type: "tarball", url }`), or a `snapshot` (`{ type: "snapshot", snapshotId }`).

## Installing system packages

The default image is **Ubuntu** — use `apt-get`, and run `apt-get update` first (package lists ship empty, so install fails without it). This needs `sudo`, and there is no shell, so run it through `bash -c` and check the exit code:

```ts
const install = await sandbox.runCommand({
  cmd: "bash",
  args: ["-c", "apt-get update && apt-get install -y ffmpeg"],
  sudo: true,
});
if (install.exitCode !== 0) throw new Error(await install.stderr());
```

For a different base, use a managed image (`vercel/sandbox/arch` uses `pacman`/`yay`) or build a [custom image](#images) so packages are baked in and there's nothing to install at runtime.

## Ports and preview URLs

Expose ports at create time (up to 15), start a server **listening on `0.0.0.0`** (not `127.0.0.1`, or it's unreachable — the host flag is framework-specific), then read its public URL. `detached` returns when the process spawns, not when it's listening, so poll for readiness before using the URL:

```ts
const sandbox = await Sandbox.create({ ports: [3000] });
// Bind 0.0.0.0 — e.g. Next/Vite: `run dev -- --host 0.0.0.0`; node http: listen("0.0.0.0")
await sandbox.runCommand({ cmd: "npm", args: ["run", "dev", "--", "--host", "0.0.0.0"], detached: true });

// Wait until the port actually answers inside the VM
for (let i = 0; i < 30; i++) {
  const ping = await sandbox.runCommand("bash", ["-c", "curl -sf http://localhost:3000 >/dev/null && echo up || true"]);
  if ((await ping.stdout()).includes("up")) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const url = sandbox.domain(3000); // public HTTPS URL for port 3000
```

The URL is served by the running session. If the sandbox is stopped, nothing is listening until you resume it and restart the server — so for a durable preview keep the session alive (`extendTimeout`) rather than relying on the URL between sessions. Traffic to and from exposed ports is billable (requests and responses both count).

## Lifecycle and persistence

**Persistence is the default.** When a persistent sandbox stops, its **filesystem** is snapshotted automatically; a later call resumes it into a fresh session. Only the filesystem is saved — **running processes do not survive a stop/resume**, so restart long-running servers on resume (see below).

- **Sandbox vs session**: a *sandbox* is a long-lived entity identified by `name`; a *session* is one VM boot. The max session duration caps each session, not the sandbox — resuming starts a new session with a fresh timeout, so a persistent sandbox's total lifetime is effectively unbounded.
- **Retrieve / resume**: `Sandbox.get({ name })` returns the handle immediately and auto-resumes on the next call that needs a running VM (pass `resume: false` to disable). `getOrCreate` does not resume before returning by default; pass `resume: true` to resume and await `onResume` immediately. `stop()` and `update()` never auto-resume. Use `getOrCreate` when the sandbox may not exist yet, `get` when you know it does.
- **`getOrCreate` accepts the same create options** as `create` (`ports`, `persistent`, `resources`, `networkPolicy`, `env`, …). They apply **only when it creates** the sandbox; if the named sandbox already exists it's returned with its existing config (use `sandbox.update({ … })` to change it).
- **Hooks are per call**, and fire on mutually exclusive events: `onCreate` runs once, the first time `getOrCreate` creates the sandbox; `onResume` runs on a resume. So to start a service **exactly once per session**, start it in **both** `onCreate` (first boot) and `onResume` (later boots). Hooks are arguments to *this* `getOrCreate` call, not stored on the sandbox — a *different process* resuming via `Sandbox.get` won't run them, so restart what it needs itself.
- A detached server returns as soon as the process spawns, **not** when it's listening — so after starting it (in `onCreate` for the first boot and `onResume` for later ones) poll until the port answers before treating `domain(port)` as live (see [Ports](#ports-and-preview-urls)).

```ts
const startDev = (s) =>
  s.runCommand({ cmd: "npm", args: ["run", "dev"], detached: true, cwd: "/vercel/sandbox" });

const sandbox = await Sandbox.getOrCreate({
  name: "agent-ws",
  ports: [3000],
  onCreate: async (s) => {          // once, on first creation
    await s.runCommand({ cmd: "git", args: ["clone", repoUrl, "."], cwd: "/vercel/sandbox" });
    await s.runCommand({ cmd: "npm", args: ["install"], cwd: "/vercel/sandbox" });
    await startDev(s);              // up on first boot, before domain() is read
  },
  onResume: async (s) => startDev(s), // every later resume
});
// Poll for the server to be listening (see Ports) before using the URL.
const url = sandbox.domain(3000);
// Don't stop this sandbox in a finally — stopping kills the dev server and the URL.
// If this process might find the sandbox already existing (not freshly created), pass
// `resume: true` above and start the server yourself — the hooks only fire on create/this call.
```

A separate later process reconnects by name and resumes on the first command. It won't run the hooks above, so restart anything it needs:

```ts
const sandbox = await Sandbox.get({ name: "agent-ws" });
const test = await sandbox.runCommand({ cmd: "npm", args: ["test"], cwd: "/vercel/sandbox" }); // resumes, then runs
```

Opt out for one-off work: `Sandbox.create({ persistent: false })` — the filesystem is discarded on stop and you accrue no snapshot-storage cost. Recommended for scratch/CI tasks.

## Snapshots

A snapshot is a saved full-filesystem image you can boot new sandboxes from — the way to skip repeated dependency installs (create-from-snapshot is much faster than installing from scratch).

```ts
const running = await Sandbox.create({ image: "vercel/sandbox/node:24" });
await running.runCommand({ cmd: "bash", args: ["-c", "apt-get update && apt-get install -y ffmpeg"], sudo: true });
const snap = await running.snapshot(); // sandbox stops automatically after; do NOT call stop()

const fast = await Sandbox.create({ source: { type: "snapshot", snapshotId: snap.snapshotId } });
```

Snapshots expire 30 days after last use by default. Control retention with `snapshotExpiration` (ms; `0` = never) and `keepLastSnapshots: { count: 1 }` (keep only the latest — keeps storage flat). Persistent sandboxes create these automatically on stop.

## Images

Pass `image` to control the environment. Managed images live under `vercel/sandbox`:

| Image | Contents |
|---|---|
| `vercel/sandbox/universal` (default) | Ubuntu + Node.js 24, Python 3.14, coding agents, utilities |
| `vercel/sandbox/node:22\|24\|26` | Ubuntu + pinned Node.js, pnpm |
| `vercel/sandbox/python:3.14` | Ubuntu + Python 3.14, pip, venv, uv |
| `vercel/sandbox/ubuntu` | Minimal Ubuntu 26.04 + sudo |
| `vercel/sandbox/arch` | Arch Linux, yay, base-devel |

**Custom images** (bake in your own tools) go through Vercel Container Registry: `vercel vcr build docker . my-repo:latest --push`, then `image: "my-repo:latest"`. Team-scoped (`team/project/repo:tag`) and public images work too. Note: Sandbox does **not** run a Dockerfile `ENTRYPOINT`/`CMD` — start processes yourself with `runCommand` after create. Pin a digest (`image@sha256:...`) for reproducibility.

## Drives (beta)

A drive is persistent storage you mount into a sandbox as a directory; unlike a snapshot (a full-filesystem copy per sandbox), a drive is one directory many sandboxes share and keep updating across runs. Good for agent workspaces, dependency caches, and shared data.

```ts
import { Sandbox, Drive } from "@vercel/sandbox";

const drive = await Drive.getOrCreate({ name: "workspace-cache" });
const sandbox = await Sandbox.create({ mounts: { "/data": drive } }); // read-write

// Concurrent read-only access via a drive snapshot
const reader = await Sandbox.create({ mounts: { "/data": drive.snapshot() } });
```

Up to 4 drives per run. Default size 1 TiB (1 GiB on Hobby), max 16 TiB. A drive lives in one region; a sandbox mounting it must run in that region and can't use failover regions. Only one sandbox at a time can mount a drive read-write; use `drive.snapshot()` for shared reads.

## Network policy and credential brokering

The egress firewall is Sandbox's key security control for untrusted code. Set `networkPolicy` at create or via `sandbox.update({ networkPolicy })`:

- `"allow-all"` (default) — all egress allowed.
- `"deny-all"` — blocks all egress, including DNS. Start here for untrusted code.
- Rule object — an `allow` list restricts egress to **only** the listed domains (everything else is denied); add `subnets.allow`/`subnets.deny` for IP ranges (`deny` wins). Domain matching is SNI-based, so it only applies to TLS traffic — pair with `deny-all`/subnet rules if non-TLS egress must be blocked too.

**Credential brokering**: a `transform` rule injects a secret header on egress to an allowed domain, so code inside the VM can call an authenticated API **without the secret ever entering the sandbox**. Because the `allow` list denies everything else, the box can reach only that one domain:

```ts
const sandbox = await Sandbox.create({
  networkPolicy: {
    allow: [{
      domain: "api.example.com",
      transform: { headers: { authorization: `Bearer ${process.env.API_SECRET}` } },
    }],
  },
});
// Inside the VM: fetch("https://api.example.com/…") is authenticated by the
// firewall; the VM never holds API_SECRET and can't reach any other TLS host.
// Domain rules are SNI-based (TLS only) — add `subnets: { deny: [...] }` to also
// block non-TLS / raw-IP egress if the code is fully untrusted.
```

## Running AI agents in a sandbox

To run AI-generated code, or a coding agent (Claude Code, Codex) that edits and executes code, put it in a sandbox. Two ways to give it model access, by trust level:

**Trusted agent — inject the OIDC token, call the AI Gateway directly.** The AI Gateway accepts a Vercel OIDC token as a bearer credential, so no model API key is needed. The sandbox does **not** automatically have your `VERCEL_OIDC_TOKEN`, so pass it in via `env`:

```ts
const sandbox = await Sandbox.create({
  env: { VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN! },
});
// Inside the VM, hit the gateway (OpenAI-compatible at /v1, Anthropic-compatible at root):
//   curl https://ai-gateway.vercel.sh/v1/chat/completions \
//     -H "Authorization: Bearer $VERCEL_OIDC_TOKEN" -H "Content-Type: application/json" \
//     -d '{"model":"anthropic/claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
// The AI SDK auto-resolves VERCEL_OIDC_TOKEN when AI_GATEWAY_API_KEY isn't set. Model ids
// come from the AI Gateway model catalog (provider/model, e.g. "anthropic/claude-sonnet-5").
```

**Untrusted code — broker the credential, keep it out of the VM.** For code you don't trust, don't put the token in the VM at all. Allow only the gateway and inject the auth header at the firewall so the box holds no credential and can reach no other TLS host (add `subnets.deny` to block non-TLS egress too):

```ts
const sandbox = await Sandbox.create({
  networkPolicy: {
    allow: [{
      domain: "ai-gateway.vercel.sh",
      transform: { headers: { authorization: `Bearer ${process.env.VERCEL_OIDC_TOKEN}` } },
    }],
  },
});
// Agent code calls https://ai-gateway.vercel.sh with no token present in the VM.
```

The OIDC token is ~12h; for longer sessions re-inject on resume or scope work to the token's life.

## Multi-agent isolation

Run several agents in one sandbox, each as its own Linux user with a private home directory (JS SDK only; image must include `/bin/bash`):

```ts
const alice = await sandbox.createUser("alice"); // /home/alice
await alice.runCommand("whoami"); // runs as alice
const root = sandbox.asUser("root");
```

Files in one user's home are unreadable by another. Share a workspace with `sandbox.createGroup("team")` (dir at `/shared/team`) and `addUserToGroup`.

## CLI

The `sandbox` CLI (also `vercel sandbox`) mirrors the SDK, Docker-style:

```bash
sandbox create --name my-box              # create (persistent; --non-persistent to opt out)
sandbox exec my-box -- npm test           # run a command in a named sandbox (resumes if stopped)
sandbox run -- node --version             # create an ephemeral box, run once
sandbox connect my-box                    # interactive shell (aliases: ssh, shell)
sandbox copy ./local my-box:/remote       # copy files (alias: cp)
sandbox list                              # list sandboxes (alias: ls)
sandbox drives get-or-create cache        # create a drive
sandbox stop my-box
```

## Limits and cost

- **Session duration**: Hobby 45 min, Pro/Ent 24h (per session; resume for longer).
- **Resources**: `vcpus` 1 or even up to 4/8/32 (Hobby/Pro/Ent), 2 GB RAM per vCPU, 15 ports, 64 GB disk.
- **Concurrency**: Hobby 10, Pro/Ent 10,000 concurrent sandboxes.
- **Network**: data your sandbox **downloads** (npm, git, datasets) is **free**; data it sends out and all exposed-port traffic is billable.
- **Isolation**: each sandbox is a separate Firecracker microVM, so a crash, fork bomb, or disk-fill is contained to that VM. There are no per-process CPU/PID quotas inside the VM beyond the vCPU and 64 GB disk limits — cap risk with a short `timeout` and `deny-all` for untrusted code.
- **Save money**: call `stop()` when done with one-off work, right-size vCPUs (down to 1), use `persistent: false` for scratch runs, and a smaller image or `keepLastSnapshots: { count: 1 }` to cut snapshot storage.

## Best-practice checklist

- For one-off work, `stop()` in a `finally` (safe to call more than once). **Exception**: a long-lived sandbox serving an exposed port — don't stop it, or the URL goes dead; leave it running (it persists/resumes).
- `runCommand` has no shell (wrap pipes/redirects/`&&` in `bash -c`) and does not throw on non-zero exit (check `result.exitCode`); it rejects if the session times out mid-command.
- Use absolute `/vercel/sandbox` paths (or an explicit `cwd`) when a command reads/writes files you created with `writeFiles`.
- `apt-get update` before `apt-get install`; commands are non-root by default (`sudo: true` for root); `sudo`/`detached` are object-form only.
- Start per-session services (dev servers) in **both** `onCreate` and `onResume` — only the filesystem survives a stop.
- For untrusted code: `networkPolicy: "deny-all"` (or a tight allow-list), a short `timeout` (e.g. `30_000`), `vcpus: 1`, and `persistent: false`.
- Exposed servers must bind `0.0.0.0`, not `127.0.0.1`.
- Pin a custom image by digest for reproducible boots; `ENTRYPOINT`/`CMD` don't run.
