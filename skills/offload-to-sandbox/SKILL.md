---
name: offload-to-sandbox
description: Offload heavy builds, full test suites and parallel experiments from the local machine to Vercel Sandboxes with the `vercel sandbox` CLI. Use when a local machine is overloaded or shared by several agents, when a test suite should be sharded, or when many tasks should run side by side without consuming local CPU, memory or disk.
summary: "Offload heavy work to Vercel Sandboxes: build a base snapshot once (toolchain + deps + baseline build), create one non-persistent sandbox per task from it (`vercel sandbox create --name <task> --non-persistent --snapshot <snap_id> --vcpus 8 --timeout 3h`; Hobby allows 4 vCPUs and 45-minute sessions), push code as a tarball of git-tracked and untracked files while keeping heavy dirs like node_modules, run commands as one quoted `sh -c` string (long jobs detached with an exit-status file you poll), copy small result files back, shard suites across sandboxes, check failures against an untouched baseline in the same sandbox, and `vercel sandbox remove` every sandbox when done. `vercel sandbox exec` exits 0 even when the remote command fails, so read the remote exit status yourself."
metadata:
  priority: 5
  docs:
    - "https://vercel.com/docs/sandbox"
    - "https://vercel.com/docs/cli/sandbox"
    - "https://vercel.com/docs/sandbox/cli-reference"
    - "https://vercel.com/docs/sandbox/pricing"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns: []
  importPatterns: []
  bashPatterns:
    - '\b(?:vercel|vc)\s+sandbox\s+(?:create|exec|copy|cp|snapshot|run|fork)\b'
  promptSignals:
    phrases:
      - "offload to a sandbox"
      - "offload to sandbox"
      - "run it in a sandbox"
      - "run the tests in a sandbox"
      - "remote sandbox"
      - "remote sandboxes"
      - "use sandboxes"
      - "shard the test suite"
      - "machine is overloaded"
    allOf:
      - [sandbox, offload]
      - [sandbox, remote]
      - [sandbox, "test suite"]
      - [sandbox, shard]
      - [sandbox, parallel]
      - [sandboxes, agents]
    anyOf:
      - "sandbox"
      - "sandboxes"
      - "offload"
      - "remote"
    noneOf:
      - "iframe sandbox"
      - "sandbox attribute"
      - "codesandbox.io"
    minScore: 6
retrieval:
  aliases:
    - offload work to vercel sandbox
    - remote build machine
    - remote test runner
  intents:
    - offload builds and tests to a sandbox
    - shard a test suite across machines
    - run parallel experiments remotely
  entities:
    - Vercel Sandbox
    - vercel sandbox CLI
    - snapshot
---

# Offloading work to a Vercel Sandbox

A Vercel Sandbox is a Linux microVM (x86_64) you can create in seconds and remove when you're done. That makes it a good remote worker: it keeps heavy builds and long test suites off your laptop and gives every agent or task its own clean machine. This skill covers how to do that efficiently with the `vercel sandbox` CLI. For the `@vercel/sandbox` SDK and running untrusted code, see the `vercel-sandbox` skill.

## When to offload, and what to keep local

Offload:

- Full test suites, especially when they can be sharded.
- Builds that take minutes or need Linux.
- Many tasks at once: one sandbox per task or per agent.
- Anything that fills the local disk (large build trees, many worktrees).

Keep local:

- Editing, `git`, small focused tests, type checks and lint, and orchestration.
- Anything needing local credentials or hardware the sandbox doesn't have.

A good default when several agents share one machine: agents edit locally and run quick focused checks, and everything heavy goes to their own sandboxes.

## Plan limits

| | Hobby | Pro | Enterprise |
|---|---|---|---|
| Max vCPUs (2 GB memory each) | 4 (8 GB) | 8 (16 GB) | 32 (64 GB) |
| Max session duration | 45 minutes | 24 hours | 24 hours |
| Concurrent sandboxes | 10 | 10,000 | 10,000 |

`--vcpus` takes 1 or an even number up to your plan's maximum; the default is 2. The examples below use Pro sizes (`--vcpus 8`, `--timeout 3h`). On Hobby, use `--vcpus 4` and a timeout of `45m` or less. Hobby also includes only 5 hours of Active CPU a month, so heavy offloading realistically needs Pro.

Running sandboxes are billed for Active CPU and provisioned memory. Snapshots are billed as Snapshot Storage per GB-month for as long as they exist.

## Prepare a base snapshot once

Installing toolchains and dependencies in every new sandbox wastes minutes and money. Do it once, snapshot, and start everything else from the snapshot:

```bash
# 1. Create a builder sandbox from the default image (Ubuntu, Node.js, Python, common tools).
vercel sandbox create --name base-builder --non-persistent --vcpus 8 --timeout 2h --image vercel/sandbox/universal

# 2. Install the pinned toolchain and build the baseline tree once.
vercel sandbox copy ./setup-base.sh base-builder:/vercel/sandbox/setup-base.sh
vercel sandbox exec base-builder -- sh -c 'cd /vercel/sandbox && sh setup-base.sh; echo "exit=$?"'

# 3. Snapshot it (this stops the sandbox). The ID is printed on stderr, not stdout.
vercel sandbox snapshot base-builder --stop --expiration 0 2>&1 | grep -o 'snap_[A-Za-z0-9_-]*' | head -n 1 > BASE_SNAPSHOT
test -s BASE_SNAPSHOT

# 4. The builder is no longer needed. Removing it keeps the snapshot.
vercel sandbox remove base-builder
```

Check that step 2 printed `exit=0` before you snapshot (see [Run commands](#run-commands) for why).

What to put in the base:

- The exact toolchain versions your project pins (compilers, runtimes, package manager).
- An installed and built copy of the main branch at a known commit, as a read-only baseline (for example `/vercel/sandbox/base`).
- Small helper scripts the tasks will reuse (for example a `prepare.sh` that turns a freshly pushed tree into a runnable checkout).

Keep the snapshot ID in a file next to your tooling. `--expiration 0` means the snapshot never expires, so it is billed until you delete it. When the toolchain changes, build a new snapshot and delete the old one with `vercel sandbox snapshots delete <old-id>`. Before a big run, check that `vercel sandbox snapshots get "$(cat BASE_SNAPSHOT)"` still shows the status `created`; a deleted or expired snapshot shows `deleted`.

## Create one sandbox per task

```bash
vercel sandbox create --name exp-parser --non-persistent --snapshot "$(cat BASE_SNAPSHOT)" \
  --vcpus 8 --timeout 3h --tag app=my-project --tag owner=agent-parser --silent
```

- **Name by owner and purpose** (`exp-parser`, `exp-parser-2`) so parallel agents never collide. Names are unique per project and stay taken until the sandbox is removed. Never use another agent's sandbox.
- **Size:** each vCPU comes with 2 GB of memory, and that is the only way to get more memory. Memory-heavy steps (large compiles, big linker jobs) can be killed by the Linux OOM killer. Below your plan's vCPU maximum, size up. At the maximum, lower the step's parallelism (for example fewer build jobs) or run it alone.
- **Tags** (up to 5 per sandbox) make cleanup easy: list and remove everything with your owner tag at the end.

## Lifetime and cleanup

Sandboxes are persistent by default: when a session stops, the filesystem is snapshotted so the sandbox can resume later, and that snapshot is billed as Snapshot Storage. Task sandboxes don't need that, which is why every `create` here passes `--non-persistent`.

- **`--timeout` sets the session length**, not the sandbox's lifetime. The default is 5 minutes. When it runs out, the session stops and everything running in it is killed, detached jobs included. A non-persistent sandbox loses its whole filesystem at that point. Set the timeout for the whole task. `vercel sandbox config timeout <name> <duration>` changes it later, and a higher value also extends the running session.
- **`vercel sandbox remove <name>` when a task is done.** `vercel sandbox stop` only ends the current session: the sandbox keeps its name, and a persistent sandbox keeps billing for its snapshot. Vercel removes sandboxes that can't resume after 14 days of inactivity, so a stopped non-persistent sandbox blocks its name until then unless you remove it.
- Removing a sandbox does not delete snapshots, so the base snapshot survives task cleanup. `--delete-orphan-snapshots` on `remove` also deletes the sandbox's own snapshots that no other sandbox uses. Don't pass it when removing the builder that made your base snapshot.
- **Sweep orphans** from crashed agents with `vercel sandbox list --all --tag owner=<agent>`. `--all` includes stopped sandboxes (the default shows only running ones), and `list` filters by one tag at a time. Remove everything it shows with `vercel sandbox remove <name>...`. Sweep the whole project (`--tag app=my-project`) only when no agent is still working.

## Move code in without reinstalling dependencies

Send source, not build output. Package the files git knows about (tracked plus untracked but not ignored) as one tarball, copy it, and extract it next to the old tree. Then move heavy directories (`node_modules`) from the old tree into the new one so they don't need reinstalling, and swap the two. `sbx push` in the [wrapper script](#wrap-it-in-one-small-script) does exactly this:

```bash
sbx push exp-parser . /vercel/sandbox/cand
```

- Push after every change; it takes seconds. Then run an idempotent prepare step that installs or rebuilds only what changed (for example, install dependencies only when the lockfile changed).
- Build platform-specific artifacts inside the sandbox. Don't copy macOS binaries into a Linux VM.
- Don't push `.git` or dependency directories. If you need git history remotely, push a bundle or `git clone` inside the sandbox.
- A tracked file you deleted but didn't stage makes `tar` fail. Stage the deletion (`git rm`) first.

## Run commands

```bash
vercel sandbox exec --timeout 2h exp-parser -- sh -c 'cd /vercel/sandbox/cand && npm test -- --shard 1/4; echo "exit=$?"'
```

- Pass the whole command as **one single-quoted string** to `sh -c`. Your local shell otherwise expands `$VARS` and globs before the sandbox sees them. zsh in particular errors on unmatched globs and treats `$var:r`, `$var:h` and similar as modifiers; use `${var}`.
- **Don't trust the exit status of `vercel sandbox exec`.** It exits 0 even when the remote command fails (checked with `vercel` 64.5.0, which bundles Sandbox CLI 4.4.0). End the remote command with `echo "exit=$?"` and read that, or use `sbx exec`, which returns the remote status. The standalone Sandbox CLI (`npm i -g sandbox`, then `sandbox exec ...`) does pass the remote exit code through.
- For anything longer than a line, write a script locally, `vercel sandbox copy` it in, and run it. That is easier to quote, review and rerun.
- `exec --timeout` is optional and has no default. When it expires, the command is killed with SIGKILL and the CLI prints `Command was killed (SIGKILL, exit code 137)`. Without it, a command runs until it finishes or the session times out.
- **Long jobs:** start them detached and poll, so the job doesn't depend on your local `exec` call staying connected or on an `exec` timeout. The session timeout still applies, so make sure it covers the job:

  ```bash
  vercel sandbox exec exp-parser -- sh -c 'cd /vercel/sandbox/cand && rm -f /tmp/test.status && nohup sh -c "npm run test:all > /tmp/test.log 2>&1; echo \$? > /tmp/test.status" > /dev/null 2>&1 &'
  # later, cheap polls:
  vercel sandbox exec --timeout 30s exp-parser -- sh -c 'cat /tmp/test.status 2>/dev/null || tail -3 /tmp/test.log'
  ```

- If you compare timings, run both versions in the same sandbox, because hosts of the same size can differ in speed.

## Get results back

- Have the remote side write compact result files (a summary of failing test names, exit codes, a JSON report) and copy just those back with `vercel sandbox copy exp-parser:/tmp/results.json ./results/results.json`. `copy` moves one file per call, and the destination must be a file path, not a directory.
- A missing source file makes `copy` print an error without failing, so check that the local file exists afterwards (`sbx get` does).
- Compress large logs remotely and only fetch them when needed. Streaming megabytes of output through `exec` is slow and wastes context when an agent reads it.

## Shard and parallelize

- Split a slow suite across N sandboxes by shard index, with your test runner's sharding or one orchestration script, and run the shards at the same time.
- Give each task its own sandbox. Ten agents each working in their own sandbox beat ten tasks queued on one machine.
- Bound concurrency by budget, not by what the API allows. Every running sandbox costs money.
- Large fan-outs are throttled by how fast you can allocate vCPUs. An idle Pro team starts at 150 vCPUs per minute (18 sandboxes with 8 vCPUs) and ramps up with sustained use; Hobby allows 20 to 40 per minute.

## Separate pre-existing failures from new ones

A remote suite usually has some failures that have nothing to do with your change: environment differences, flaky tests, failures already on main.

- Run the failing tests again on the untouched baseline tree in the same sandbox. Only failures that the baseline doesn't have are yours.
- Keep a short list of known environment-only failures next to your tooling, so nobody chases them again.
- While iterating, run focused checks. Run the full suite on the final candidate, not on every intermediate step.

## Authentication and scope

- **Token:** `vercel sandbox` uses `--token`, then `VERCEL_AUTH_TOKEN`, then `VERCEL_TOKEN`, then your `vercel login` session. It falls back to a `VERCEL_OIDC_TOKEN` environment variable only when none of those is available. For CI or long-running automation, set `VERCEL_TOKEN`.
- The standalone `sandbox` CLI reads `VERCEL_AUTH_TOKEN` but not `VERCEL_TOKEN`, and it loads `.env` files from the current directory. A `VERCEL_OIDC_TOKEN` pulled into `.env.local` therefore takes precedence over your login there, and its project becomes the default scope.
- **Team and project:** sandboxes and their names belong to one project. `--scope` (or `--team`) and `--project` set it. Without them, the CLI uses the project in the token when it is an OIDC token, then the `.vercel/project.json` in the current directory (from `vercel link`), then your default team and a project named `vercel-sandbox-default-project`, which it creates if needed.
- Pass `--scope` and `--project` explicitly in scripts. Otherwise a script run from another directory works in a different project and can't see, reuse or clean up your sandboxes.

## Wrap it in one small script

A thin wrapper removes most mistakes and keeps agent instructions short. Save this as `sbx`, make it executable, and set `SBX_SCOPE`, `SBX_PROJECT` and `SBX_OWNER` (and `SBX_VCPUS=4 SBX_TIMEOUT=45m` on Hobby):

```sh
#!/bin/sh
# sbx: offload work to Vercel Sandboxes through `vercel sandbox`.
#   sbx create <name>                         new task sandbox from the base snapshot
#   sbx push <name> <local-dir> <remote-dir>  sync git-tracked and untracked files, keep node_modules
#   sbx exec <name> <script>                  run a shell script remotely, exit with its status
#   sbx get <name> <remote-file> <local-file>
#   sbx put <name> <local-file> <remote-file>
#   sbx rm <name>...                          permanently remove sandboxes
#   sbx clean                                 remove every sandbox tagged with your owner tag
# shellcheck disable=SC2016 # single-quoted scripts are expanded by the remote shell
set -eu

: "${SBX_SCOPE:?set SBX_SCOPE to your team slug}"
: "${SBX_PROJECT:?set SBX_PROJECT to your project name}"
owner=${SBX_OWNER:-${USER:-agent}}
vcpus=${SBX_VCPUS:-8}              # Pro maximum; Hobby allows 4
timeout=${SBX_TIMEOUT:-3h}         # session length; Hobby allows 45m
exec_timeout=${SBX_EXEC_TIMEOUT:-2h}

sb() { # sb <subcommand> [args...]
  sub=$1
  shift
  vercel sandbox "$sub" --scope "$SBX_SCOPE" --project "$SBX_PROJECT" "$@"
}

# `vercel sandbox exec` exits 0 even when the remote command fails, so the
# remote shell prints the script's exit status and remote() returns it.
remote() { # remote <name> <script> [args...]
  name=$1
  script=$2
  shift 2
  log=$(mktemp)
  sb exec --timeout "$exec_timeout" "$name" -- \
    sh -c 'sh -c "$0" sh "$@"; echo "__sbx_exit=$?"' "$script" "$@" | tee "$log"
  code=$(sed -n 's/^__sbx_exit=//p' "$log" | tail -n 1)
  rm -f "$log"
  return "${code:-1}"
}

push() { # push <name> <local-dir> <remote-dir>
  git -C "$2" rev-parse --is-inside-work-tree > /dev/null
  tgz=$(mktemp)
  (cd "$2" && git ls-files -z --cached --others --exclude-standard |
    COPYFILE_DISABLE=1 tar -czf "$tgz" --null -T -)
  sb copy "$tgz" "$1:$3.tgz"
  rm -f "$tgz"
  remote "$1" '
    set -e
    dest=$1
    rm -rf "$dest.new"
    mkdir -p "$dest.new"
    tar -xzf "$dest.tgz" -C "$dest.new"
    rm -f "$dest.tgz"
    if [ -d "$dest" ]; then
      (cd "$dest" && find . -maxdepth 4 -type d -name node_modules -prune -print) > "$dest.keep"
      while IFS= read -r keep; do
        [ -e "$dest.new/$keep" ] && continue
        mkdir -p "$(dirname "$dest.new/$keep")"
        mv "$dest/$keep" "$dest.new/$keep"
      done < "$dest.keep"
      rm -rf "$dest" "$dest.keep"
    fi
    mv "$dest.new" "$dest"' "$3" > /dev/null
}

cmd=${1:?usage: sbx create|push|exec|get|put|rm|clean ...}
shift
case "$cmd" in
  create)
    name=${1:?usage: sbx create <name>}
    snapshot=${SBX_SNAPSHOT:-$(cat BASE_SNAPSHOT)}
    sb create --name "$name" --non-persistent --snapshot "$snapshot" \
      --vcpus "$vcpus" --timeout "$timeout" \
      --tag "app=$SBX_PROJECT" --tag "owner=$owner" --silent
    echo "$name"
    ;;
  push)
    push "${1:?name}" "${2:?local dir}" "${3:?remote dir}"
    ;;
  exec)
    name=${1:?usage: sbx exec <name> <script>}
    shift
    remote "$name" "$*"
    ;;
  get)
    rm -f "${3:?local file}"
    sb copy "${1:?name}:${2:?remote file}" "$3"
    [ -f "$3" ] || { echo "sbx: could not copy $1:$2" >&2; exit 1; }
    ;;
  put)
    [ -f "${2:?local file}" ] || { echo "sbx: no such file: $2" >&2; exit 1; }
    sb copy "$2" "${1:?name}:${3:?remote file}"
    ;;
  rm)
    : "${1:?usage: sbx rm <name>...}"
    sb remove "$@"
    ;;
  clean)
    # `list` shows 50 sandboxes per page; run `sbx clean` again if more remain.
    names=$(sb list --all --tag "owner=$owner" | awk 'NR > 1 && NF && $1 != "More" { print $1 }')
    # shellcheck disable=SC2086 # one word per sandbox name
    if [ -n "$names" ]; then sb remove $names; fi
    ;;
  *)
    echo "usage: sbx create|push|exec|get|put|rm|clean ..." >&2
    exit 2
    ;;
esac
```

Typical agent session:

```sh
sbx create exp-parser
sbx push exp-parser . /vercel/sandbox/cand
sbx exec exp-parser 'cd /vercel/sandbox/cand && sh /vercel/sandbox/prepare.sh && npm test'
sbx get exp-parser /tmp/results.json ./results.json
sbx rm exp-parser
```

Document the workflow next to the wrapper (a short `SANDBOX.md`): the snapshot ID, what the base contains, the prepare step, how to run the suite, and the known environment-only failures. Point every agent's instructions at that file.

## Pitfalls

- **False success:** `vercel sandbox exec` exits 0 when the remote command fails. Read the printed exit status, or use `sbx exec`.
- **OOM:** big compiles can be killed. A remote exit status of 137 means the process got SIGKILL, usually from the OOM killer. Size up within your plan, or lower parallelism at the maximum, rather than retrying blindly.
- **Lost work at the session timeout:** a non-persistent sandbox discards its filesystem when the session stops. Copy results out before the timeout, and set the timeout for the whole task.
- **Leftover sandboxes:** `stop` doesn't free a sandbox's name or delete it. Use `remove`, and sweep with `list --all`.
- **Stale snapshot:** tasks that start from an old base can hit toolchain-version mismatches. Rebuild the snapshot, or refresh the tools in the task sandbox, when versions change.
- **Shared sandboxes:** two agents in one sandbox corrupt each other's trees. One owner per sandbox.
- **Quotas mid-run:** on Hobby, sandbox creation pauses once the monthly allotment is used up, and on Pro a Spend Management limit can pause projects. Commit work in small steps, write results to disk as you go, and keep scripts idempotent, so a replacement agent can resume instead of starting over.
