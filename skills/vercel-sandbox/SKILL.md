---
name: vercel-sandbox
description: Vercel Sandbox guidance — ephemeral Firecracker microVMs for running untrusted code safely. Supports AI agents, code generation, and experimentation. Use when executing user-generated or AI-generated code in isolation.
metadata:
  priority: 4
  pathPatterns: []
  importPatterns:
    - '@vercel/sandbox'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*@vercel/sandbox\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@vercel/sandbox\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@vercel/sandbox\b'
    - '\byarn\s+add\s+[^\n]*@vercel/sandbox\b'
---

# Vercel Sandbox

You are an expert in Vercel Sandbox — ephemeral compute for safely running untrusted code.

## What It Is

Vercel Sandbox provides **Firecracker microVMs** with millisecond startup times for running untrusted or user-generated code in complete isolation. Used by AI agents, code generation tools, developer playgrounds, and interactive tutorials.

- **Base OS**: Amazon Linux 2023 (with `git`, `tar`, `openssl`, `dnf`)
- **Runtimes**: `node24` (default), `node22`, `python3.13`
- **Working directory**: `/vercel/sandbox`
- **User**: `vercel-sandbox` with `sudo` access
- **Filesystem**: Ephemeral — artifacts must be exported before sandbox stops
- **GitHub**: https://github.com/vercel/sandbox

## Key APIs

Package: `@vercel/sandbox`

### Create and Run Commands

```ts
import { Sandbox } from '@vercel/sandbox';

// Create a sandbox
const sandbox = await Sandbox.create({
  runtime: 'node24',  // 'node24' | 'node22' | 'python3.13'
});

// Run a command (separated command + args)
const result = await sandbox.runCommand('node', ['-e', 'console.log(42)']);
const output = await result.stdout(); // "42\n"

// Run with options
const result2 = await sandbox.runCommand({
  cmd: 'npm',
  args: ['install', 'express'],
  cwd: '/vercel/sandbox/app',
  env: { NODE_ENV: 'production' },
  sudo: true,
});

// Detached execution (long-running processes)
const cmd = await sandbox.runCommand({
  cmd: 'node',
  args: ['server.js'],
  detached: true,
});
// Stream logs in real-time
for await (const log of cmd.logs()) {
  console.log(`[${log.stream}] ${log.data}`);
}
await cmd.wait(); // block until completion
```

### File Operations

```ts
// Write files (takes array of { path, content: Buffer })
await sandbox.writeFiles([
  { path: 'app.js', content: Buffer.from('console.log("hello")') },
  { path: 'package.json', content: Buffer.from('{"type":"module"}') },
]);

// Read a file (returns Buffer or null)
const buf = await sandbox.readFileToBuffer({ path: 'app.js' });

// Read as stream
const stream = await sandbox.readFile({ path: 'app.js' });

// Download to local filesystem
await sandbox.downloadFile('output.zip', './local-output.zip');

// Create directory
await sandbox.mkDir('src/components');
```

### Source Initialization

```ts
// Clone a git repo
const sandbox = await Sandbox.create({
  source: { type: 'git', url: 'https://github.com/user/repo', depth: 1 },
});

// Mount a tarball
const sandbox = await Sandbox.create({
  source: { type: 'tarball', url: 'https://example.com/project.tar.gz' },
});

// Restore from snapshot
const sandbox = await Sandbox.create({
  source: { type: 'snapshot', snapshotId: 'snap_abc123' },
});
```

### Snapshots (Save and Resume VM State)

```ts
// Capture full VM state (filesystem + packages)
// WARNING: sandbox shuts down after snapshot creation
const snapshot = await sandbox.snapshot({ expiration: 86400_000 }); // 24h
console.log(snapshot.snapshotId);

// List and manage snapshots
const { snapshots } = await Snapshot.list();
const snap = await Snapshot.get({ snapshotId: 'snap_abc' });
await snap.delete();
```

### Network Policies

```ts
// Lock down before running untrusted code
await sandbox.updateNetworkPolicy('deny-all');

// Allow specific domains only
await sandbox.updateNetworkPolicy({
  allow: ['api.openai.com', '*.googleapis.com'],
});

// Credential brokering (inject API keys so untrusted code never sees them)
await sandbox.updateNetworkPolicy({
  allow: {
    'ai-gateway.vercel.sh': [{
      transform: [{ headers: { 'x-api-key': process.env.SECRET_KEY! } }],
    }],
  },
});
```

### Public URLs and Lifecycle

```ts
// Expose a port and get a public URL
const sandbox = await Sandbox.create({ ports: [3000] });
const url = sandbox.domain(3000); // public URL

// Extend timeout
await sandbox.extendTimeout(300_000); // +5 minutes

// Clean up
await sandbox.stop();

// Check status
sandbox.status; // 'pending' | 'running' | 'stopping' | 'stopped' | 'failed'

// Resource tracking (after stop)
sandbox.activeCpuUsageMs;
sandbox.networkUsage; // { ingress, egress } in bytes
```

### List and Rehydrate

```ts
// List existing sandboxes
const { sandboxes } = await Sandbox.list({ limit: 10 });

// Reconnect to a running sandbox
const sandbox = await Sandbox.get({ sandboxId: 'sbx_abc123' });
```

## Timeout Limits

| Plan | Max Timeout |
|------|------------|
| Default | 5 minutes |
| Hobby | 45 minutes |
| Pro/Enterprise | 5 hours |

## Agent Patterns

1. **Safe AI code execution**: Run AI-generated code without production risk
2. **Snapshot-based fast restart**: Install deps once → snapshot → create from snapshot (skip setup)
3. **Network isolation**: Allow all during setup → `deny-all` before untrusted code
4. **Credential brokering**: Inject API keys via network policy transforms
5. **Live preview**: Expose ports via `sandbox.domain(port)` for generated apps
6. **File I/O workflow**: `writeFiles()` → execute → `readFileToBuffer()` results

## When to Use

- AI agents need to execute generated code safely
- User-submitted code execution (playgrounds, tutorials)
- Code review validation (used by Vercel Agent)
- Ephemeral development environments

## When NOT to Use

- Production workloads → use Vercel Functions
- Long-running services → use a dedicated server
- Simple function execution → use Serverless Functions

## References

- 📖 docs: https://vercel.com/docs/vercel-sandbox
- 📖 SDK reference: https://vercel.com/docs/vercel-sandbox/sdk-reference
- 📖 GitHub: https://github.com/vercel/sandbox
