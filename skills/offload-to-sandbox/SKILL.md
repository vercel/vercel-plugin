---
name: offload-to-sandbox
description: Offload heavy builds, full test suites, benchmarks and parallel experiments from the local machine to Vercel Sandboxes with the `vercel sandbox` CLI. Use when a local machine is overloaded or shared by several agents, when timings must be reliable, when a test suite should be sharded, or when many experiments should run side by side without consuming local CPU, memory or disk.
summary: "Offload heavy work to Vercel Sandboxes: build a base snapshot once (toolchain + deps + baseline build), create one sandbox per task from it (`vercel sandbox create --snapshot <id> --vcpus 8 --timeout 180m --name <task>`), push code as a tarball of git-tracked and untracked files while keeping heavy dirs like node_modules, run commands as one quoted `sh -c` string (long jobs detached with an exit-status file you poll), copy small result files back, compare A/B interleaved inside the same VM, shard suites across sandboxes, classify failures against an untouched baseline in the same sandbox, and always stop sandboxes when done."
metadata:
  priority: 5
  docs:
    - "https://vercel.com/docs/sandbox"
    - "https://vercel.com/docs/cli/sandbox"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns: []
  importPatterns: []
  bashPatterns:
    - '\b(?:vercel|vc)\s+sandbox\s+(?:create|exec|copy|cp|snapshot|run|fork)\b'
  promptSignals:
    phrases:
      - "offload to a sandbox"
      - "offload to sandbox"
      - "offload work to"
      - "run it in a sandbox"
      - "run the tests in a sandbox"
      - "run tests remotely"
      - "remote sandbox"
      - "remote sandboxes"
      - "use sandboxes"
      - "shard the test suite"
      - "machine is overloaded"
    allOf:
      - [sandbox, offload]
      - [sandbox, remote]
      - [sandbox, benchmark]
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
    - sandbox benchmarking
  intents:
    - offload builds and tests to a sandbox
    - run benchmarks on dedicated machines
    - shard a test suite across machines
    - run parallel experiments remotely
  entities:
    - Vercel Sandbox
    - vercel sandbox CLI
    - snapshot
---

# Offloading work to a Vercel Sandbox

A Vercel Sandbox is a fresh Linux microVM you can create in seconds, give 8 vCPUs, and throw away. That makes it a good remote worker: it keeps heavy builds, long test suites and benchmarks off your laptop, gives every agent or experiment its own clean machine, and produces timings no other process disturbs. This skill covers how to do that efficiently with the `vercel sandbox` CLI. For running untrusted code through the SDK, see the `vercel-sandbox` skill.

## When to offload, and what to keep local

Offload:

- Full test suites, especially when they can be sharded.
- Builds that take minutes or need a different OS/architecture (sandboxes are Linux x86_64).
- Benchmarks and A/B performance measurements. A laptop shared with other work, or with several agents, gives noisy numbers (a load average of 20+ easily triples run times).
- Many experiments at once: one sandbox per experiment or per agent.
- Anything that fills the local disk (large build trees, many worktrees, profiling data).

Keep local:

- Editing, `git`, small focused tests, type checks and lint, and orchestration.
- Anything needing local credentials or hardware the sandbox doesn't have.

A good default when several agents share one machine: agents edit locally and run quick focused checks, and everything heavy goes to their own sandboxes.

## Prepare a base snapshot once

Installing toolchains and dependencies in every new sandbox wastes minutes and money. Do it once, snapshot, and start everything else from the snapshot:

```bash
# 1. Create a builder sandbox from the default image (Ubuntu, Node.js, Python, common tools).
vercel sandbox create --name base-builder --vcpus 8 --timeout 120m --image vercel/sandbox/universal

# 2. Install the pinned toolchain and build the baseline tree once.
vercel sandbox copy ./setup-base.sh base-builder:/vercel/sandbox/setup-base.sh
vercel sandbox exec base-builder -- sh -c 'cd /vercel/sandbox && sh setup-base.sh'

# 3. Snapshot it (this stops the sandbox) and record the ID.
vercel sandbox snapshot base-builder --stop --expiration 0 > BASE_SNAPSHOT
```

What to put in the base:

- The exact toolchain versions your project pins (compilers, runtimes, package manager).
- An installed and built copy of the main branch at a known commit, as a read-only baseline for comparisons (for example `/vercel/sandbox/base`).
- Small helper scripts the tasks will reuse (for example a `prepare.sh` that turns a freshly pushed tree into a runnable checkout).

Keep the snapshot ID in a file next to your tooling, and rebuild the snapshot when the toolchain changes. Snapshots can expire (`--expiration`), so check the ID still works before a big run. A sandbox created from an old snapshot can be refreshed by copying in new helper scripts, which is cheaper than rebuilding the snapshot for a small change.

## Create one sandbox per task

```bash
vercel sandbox create --name exp-parser --snapshot "$(cat BASE_SNAPSHOT)" \
  --vcpus 8 --timeout 180m --tag app=my-project --tag owner=agent-parser --silent
```

- **Name by owner and purpose** (`exp-parser`, `exp-parser-2`, `bench-app-1`) so parallel agents never collide. Never reuse another agent's sandbox: its state and timings are its own.
- **Size:** each vCPU comes with 2 GB of memory, so 8 vCPUs means 16 GB. Memory-heavy steps (large compiles with sanitizers, big linker jobs) can be killed by the Linux OOM killer at that size; give those more vCPUs or run them alone.
- **Lifetime:** `--timeout` caps how long the sandbox lives. Choose it for the whole task, and expect to recreate the sandbox for longer work. Separately, each `exec` has its own timeout (below).
- **Tags** make cleanup easy: list and stop everything with your tag at the end.
- `--region` defaults to `iad1`; keep all sandboxes for one comparison in the same region.

## Move code in without reinstalling dependencies

Send source, not build output. Package the files git knows about (tracked plus untracked but not ignored) as one tarball, copy it, and extract it next to the old tree. Then move heavy directories (`node_modules`, native build artifacts) from the old tree into the new one so they don't need reinstalling, and swap the two:

```bash
push() { # push <sandbox> <local-dir> <remote-dir>
  tmp=$(mktemp -d)
  (cd "$2" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -czf "$tmp/src.tgz")
  vercel sandbox copy "$tmp/src.tgz" "$1:/tmp/src.tgz" > /dev/null
  rm -rf "$tmp"
  vercel sandbox exec --timeout 10m "$1" -- sh -c "set -e
    rm -rf $3.new && mkdir -p $3.new && tar -xzf /tmp/src.tgz -C $3.new
    if [ -d $3 ]; then
      cd $3
      for keep in \$(find . -maxdepth 4 -type d -name node_modules -prune -print); do
        [ -e $3.new/\$keep ] || { mkdir -p \$(dirname $3.new/\$keep); mv \$keep $3.new/\$keep; }
      done
      cd / && rm -rf $3
    fi
    mv $3.new $3"
}
```

- Push after every change; it takes seconds. Then run an idempotent prepare step that installs or rebuilds only what changed (for example, install dependencies only when the lockfile changed).
- Build platform-specific artifacts inside the sandbox. Don't copy macOS binaries into a Linux VM.
- Don't push `.git` or dependency directories. If you need git history remotely, push a bundle or `git clone` inside the sandbox.
- If the project contains directories named like your keep-list (a test fixture called `node_modules`), make sure the keep step doesn't nest them into themselves.

## Run commands

```bash
vercel sandbox exec --timeout 120m exp-parser -- sh -c 'export PATH=/usr/local/bin:$PATH; cd /vercel/sandbox/cand && npm test -- --shard 1/4'
```

- Pass the whole command as **one single-quoted string** to `sh -c`. Your local shell otherwise expands `$VARS`, globs and history before the sandbox sees them.
  - zsh in particular errors on unmatched globs (quote `'--include=*.ts'`) and treats `$var:r`, `$var:h` and similar as modifiers. Use `${var}`, or run complex local loops under `bash -c`.
- For anything longer than a line, write a script locally, `vercel sandbox copy` it in, and run it. That is easier to quote, review and rerun.
- `exec` has a timeout (`--timeout`). On expiry the process is killed with SIGKILL, so set it explicitly for long work.
- **Long jobs:** start them detached and poll, so a dropped connection or an exec timeout doesn't kill an hour of work:

  ```bash
  vercel sandbox exec exp-parser -- sh -c 'cd /vercel/sandbox/cand && nohup sh -c "npm run test:all > /tmp/test.log 2>&1; echo \$? > /tmp/test.status" > /dev/null 2>&1 &'
  # later, cheap polls:
  vercel sandbox exec --timeout 30s exp-parser -- sh -c 'cat /tmp/test.status 2>/dev/null || tail -3 /tmp/test.log'
  ```

- `vercel sandbox connect <name>` gives you an interactive shell for debugging. Don't use it in automation.

## Get results back

- Have the remote side write compact results files (JSON from your benchmark tool, a summary of failing test names, exit codes) and copy just those back with `vercel sandbox copy <name>:/tmp/results.json ./results/`.
- Compress large logs remotely and only fetch them when needed. Streaming megabytes of output through `exec` is slow and wastes context when an agent reads it.
- Keep raw results in a per-task local directory (`results/<task>/`) so reports can be regenerated without rerunning.

## Benchmark fairly

- **Compare inside one VM.** Run the baseline and the candidate in the same sandbox, interleaved (A, B, A, B, …), with several runs and medians or paired comparisons. VM-to-VM differences then cancel out.
- **Record the host.** Save `/proc/cpuinfo` (model, MHz), the vCPU count and tool versions with every result. Hosts of the same size can differ (for example 2.5 GHz vs 2.9 GHz parts), so only compare absolute times measured on the same VM. Re-run a known anchor (the reference tool, the baseline build) in every VM when results from several VMs go into one table.
- **Use exclusive sandboxes for timing.** Don't run builds or tests in a sandbox while it's measuring.
- **Expect some residual noise** (live migration, neighbors). Use enough interleaved runs and report confidence intervals or paired medians, not single numbers.
- For code-layout-sensitive native code, average over several perturbed builds before trusting differences of a few percent.

## Shard and parallelize

- Split a slow suite across N sandboxes by shard index, either in one orchestration script or with your test runner's sharding. For example, 8 shards for a plain build and 8 for a sanitizer build, run at the same time.
- Give each experiment its own sandbox. Ten agents each measuring their own change in their own sandbox beat ten changes queued on one machine.
- Bound concurrency by budget, not by what the API allows. Every running sandbox costs money.

## Separate pre-existing failures from new ones

A remote suite usually has some failures that have nothing to do with your change: environment differences, flaky tests, failures already on main.

- Run the failing tests again on the untouched baseline tree in the same sandbox. Only failures that the baseline doesn't have are yours.
- Keep a short list of known environment-only failures next to your tooling, and update it when you confirm a new one, so nobody chases them again.
- **Measure first, gate later.** While iterating, run focused checks and measure. Run the full suite once, on the final candidate, after the change has proven its value. Full gates on every intermediate step waste time and money.

## Authentication

- `vercel sandbox` uses your CLI login, or a token passed with `--token`. Team and project come from `--scope`/`--project`, or are inferred from `VERCEL_OIDC_TOKEN`.
- Locally, `vercel link` and `vercel env pull` provide a `VERCEL_OIDC_TOKEN` (valid about 12 hours; re-pull when commands start failing with auth errors).
- For CI or long-running automation, use `VERCEL_TOKEN` with an explicit team and project.
- Put `--scope`/`--project` in one wrapper (below) instead of repeating them in every command.

## Wrap it in one small script

A thin wrapper removes most mistakes and keeps agent instructions short:

```sh
#!/bin/sh
# sbx: create | push | exec | get | put | stop
set -eu
scope="--scope my-team --project my-project"
cmd=${1:?usage: sbx create|push|exec|get|put|stop ...}; shift
case "$cmd" in
  create) vercel sandbox create $scope --name "${1:?name}" --vcpus 8 --timeout 180m \
            --snapshot "$(cat BASE_SNAPSHOT)" --tag app=my-project --silent; echo "$1" ;;
  push)   push "$@" ;;   # the push function from above, with $scope added
  exec)   name=${1:?name}; shift
          vercel sandbox exec $scope --timeout 120m "$name" -- sh -c "export PATH=/usr/local/bin:\$PATH; cd /vercel/sandbox; $*" ;;
  get)    vercel sandbox copy $scope "${1:?name}:${2:?remote}" "${3:?local}" ;;
  put)    vercel sandbox copy $scope "${2:?local}" "${1:?name}:${3:?remote}" ;;
  stop)   vercel sandbox stop $scope "${1:?name}" ;;
esac
```

Document the workflow next to the wrapper (a short `SANDBOX.md`): the snapshot ID, what the base contains, the prepare step, how to run the suite and benchmarks, and the known environment-only failures. Point every agent's instructions at that file.

## Cost and hygiene

- **Stop sandboxes when a task is done.** They are billed while running, and a forgotten 8-vCPU sandbox costs real money.
- At the end of a session, `vercel sandbox list`, then stop anything with your tag that has no active owner (including orphans from crashed agents).
- Watch budgets: if a spending limit is reached, running agents fail mid-task. Design for restarts:
  - Commit work in small steps.
  - Write results to disk as you go.
  - Make scripts idempotent, so a replacement agent can resume from the repository and the results directory instead of starting over.
- Offloading also protects the local disk. Delete large local build trees and intermediate files you no longer need; remote scratch space disappears with the sandbox.

## Pitfalls

- **Quoting:** the local shell expands your remote command before sending it. Use single quotes, or a script file.
- **Exec timeouts kill silently** with SIGKILL. Long jobs belong in a detached process with a status file.
- **OOM at 16 GB:** big compiles can be killed. Check `dmesg` or the exit status, and size up rather than retry blindly.
- **Stale snapshot:** tasks that start from an old base can hit toolchain-version mismatches. Rebuild the snapshot, or refresh the tools in the task sandbox, when versions change.
- **Comparing across VMs:** never put timings from different sandboxes into one comparison without an anchor measured in each.
- **Shared sandboxes:** two agents in one sandbox corrupt each other's trees and timings. One owner per sandbox.
