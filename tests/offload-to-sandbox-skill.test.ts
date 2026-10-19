import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  compileSkillPatterns,
  matchBashWithReason,
  type CompiledSkillEntry,
} from "../hooks/src/patterns.mts";
import {
  compilePromptSignals,
  matchPromptWithReason,
  normalizePromptText,
  type CompiledPromptSignals,
} from "../hooks/src/prompt-patterns.mts";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_PATH = resolve(ROOT, "skills/offload-to-sandbox/SKILL.md");
const SKILL = readFileSync(SKILL_PATH, "utf8");

let offloadSignals: CompiledPromptSignals;
let sandboxSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const offload = skills["offload-to-sandbox"];
  const sandbox = skills["vercel-sandbox"];

  expect(offload).toBeDefined();
  expect(offload.promptSignals).toBeDefined();
  expect(sandbox.promptSignals).toBeDefined();

  offloadSignals = compilePromptSignals(offload.promptSignals!);
  sandboxSignals = compilePromptSignals(sandbox.promptSignals!);
  compiledSkill = compileSkillPatterns({ "offload-to-sandbox": offload })[0];
});

function matches(signals: CompiledPromptSignals, prompt: string): boolean {
  return matchPromptWithReason(normalizePromptText(prompt), signals).matched;
}

const OFFLOAD_PROMPTS = [
  "Offload the full test suite to Vercel Sandboxes, my laptop can't keep up.",
  "Shard the test suite across several sandboxes and run them at once.",
  "Give each agent its own remote sandbox for builds.",
  "Offload the Rust build to a sandbox.",
  "Run our CI shards in parallel on Vercel Sandboxes.",
  "Use vercel sandbox exec to run the build remotely.",
];

describe("offload-to-sandbox prompt activation", () => {
  test.each(OFFLOAD_PROMPTS)("matches offload intent: %s", (prompt) => {
    expect(matches(offloadSignals, prompt)).toBe(true);
  });

  test.each([
    "Run AI-generated code safely with @vercel/sandbox.",
    "Execute untrusted user code in an isolated Vercel Sandbox microVM.",
    "Expose port 3000 from a sandbox and get the preview URL.",
    "Add the sandbox attribute to this iframe.",
    "Embed a codesandbox.io example in the docs.",
    "Offload work to a background worker with Vercel Queues.",
    "Run tests remotely on GitHub Actions.",
    "Shard the Postgres database across regions.",
    "Run the vitest suite in parallel locally.",
  ])("does not match unrelated intent: %s", (prompt) => {
    expect(matches(offloadSignals, prompt)).toBe(false);
  });
});

describe("split with the vercel-sandbox skill", () => {
  test.each(OFFLOAD_PROMPTS.filter((p) => /offload|shard/i.test(p)))(
    "vercel-sandbox stays out of offload and shard prompts: %s",
    (prompt) => {
      expect(matches(sandboxSignals, prompt)).toBe(false);
    },
  );

  test.each([
    "Run untrusted code safely in a Vercel Sandbox.",
    "Use @vercel/sandbox to execute AI-generated code.",
    "Create a sandbox with Sandbox.create and expose port 3000.",
  ])("vercel-sandbox keeps SDK and untrusted-code prompts: %s", (prompt) => {
    expect(matches(sandboxSignals, prompt)).toBe(true);
    expect(matches(offloadSignals, prompt)).toBe(false);
  });
});

describe("offload-to-sandbox bash activation", () => {
  test.each([
    "vercel sandbox create --name exp-parser --non-persistent --snapshot snap_abc",
    "vercel sandbox exec exp-parser -- sh -c 'npm test'",
    "vc sandbox copy ./results.json exp-parser:/tmp/results.json",
    "vercel sandbox snapshot base-builder --stop --expiration 0",
  ])("matches %s", (command) => {
    expect(matchBashWithReason(command, compiledSkill.compiledBash)).not.toBeNull();
  });

  test.each([
    "npm install @vercel/sandbox",
    "vercel deploy --prod",
    "sandbox-exec -f profile.sb ./run",
  ])("does not match %s", (command) => {
    expect(matchBashWithReason(command, compiledSkill.compiledBash)).toBeNull();
  });
});

function codeBlocks(): string[] {
  return [...SKILL.matchAll(/^[ \t]*```(?:bash|sh)\n([\s\S]*?)^[ \t]*```/gm)].map(
    (m) => m[1],
  );
}

describe("offload-to-sandbox guidance", () => {
  test("every shell example parses as POSIX sh", () => {
    const blocks = codeBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    for (const block of blocks) {
      const result = spawnSync("sh", ["-n"], { input: block, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  // Plan limits from https://vercel.com/docs/sandbox/pricing: Pro allows
  // 8 vCPUs (1 or an even number) and 24-hour sessions.
  test("examples stay within Pro limits and never create persistent task sandboxes", () => {
    const code = codeBlocks().join("\n").replace(/\\\n\s*/g, " ");
    const creates = code.match(/vercel sandbox create [^\n]*|sb create [^\n]*/g) ?? [];
    expect(creates.length).toBeGreaterThanOrEqual(3);
    for (const create of creates) {
      expect(create).toContain("--non-persistent");
    }

    for (const [, n] of code.matchAll(/--vcpus (\d+)/g)) {
      const vcpus = Number(n);
      expect(vcpus === 1 || (vcpus % 2 === 0 && vcpus <= 8)).toBe(true);
    }
    for (const [, n, unit] of SKILL.matchAll(/--timeout (\d+)(m|h)\b/g)) {
      const minutes = unit === "h" ? Number(n) * 60 : Number(n);
      expect(minutes).toBeLessThanOrEqual(24 * 60);
    }

    expect(code).not.toMatch(/vercel sandbox stop\b/);
  });
});

// ---------------------------------------------------------------------------
// The sbx wrapper, run against a fake `vercel` binary.
// ---------------------------------------------------------------------------

const WRAPPER = SKILL.match(/```sh\n(#!\/bin\/sh\n[\s\S]*?)```/)?.[1];

// Mirrors the real CLI at the boundary: `vercel sandbox exec` exits 0 whatever
// the remote command returns (vercel 64.5.0 returns 0 after delegating to the
// Sandbox CLI), `copy` of a missing source prints an error and exits 0, and
// `list` prints a header row, one row per sandbox, then an optional
// "More results" hint. The "sandbox" is the local filesystem.
const FAKE_VERCEL = `#!/bin/sh
printf '%s\\037' "$@" >> "$FAKE_VERCEL_LOG"
printf '\\036' >> "$FAKE_VERCEL_LOG"
[ "$1" = sandbox ] || exit 1
sub=$2
shift 2
case "$sub" in
  exec)
    while [ "$1" != "--" ]; do shift; done
    shift
    "$@"
    exit 0
    ;;
  copy)
    src=
    dst=
    while [ $# -gt 0 ]; do
      case "$1" in
        --scope|--project) shift 2 ;;
        *) if [ -z "$src" ]; then src=$1; else dst=$1; fi; shift ;;
      esac
    done
    src=\${src#*:}
    dst=\${dst#*:}
    [ -f "$src" ] || { echo "File not found: $src" >&2; exit 0; }
    cp "$src" "$dst"
    ;;
  list)
    cat "$FAKE_VERCEL_LIST"
    ;;
esac
`;

let work: string;

function sbx(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return spawnSync("sh", [join(work, "sbx"), ...args], {
    cwd: opts.cwd ?? work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(work, "bin")}:${process.env.PATH}`,
      FAKE_VERCEL_LOG: join(work, "vercel.log"),
      FAKE_VERCEL_LIST: join(work, "list.txt"),
      SBX_SCOPE: "my-team",
      SBX_PROJECT: "my-project",
      SBX_OWNER: "agent-a",
      ...opts.env,
    },
  });
}

function vercelCalls(): string[][] {
  if (!existsSync(join(work, "vercel.log"))) return [];
  return readFileSync(join(work, "vercel.log"), "utf8")
    .split("\x1e")
    .filter(Boolean)
    .map((call) => call.split("\x1f").slice(0, -1));
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

function write(path: string, content: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
}

describe("sbx wrapper", () => {
  beforeEach(() => {
    expect(WRAPPER).toBeDefined();
    work = mkdtempSync(join(tmpdir(), "sbx-"));
    writeFileSync(join(work, "sbx"), WRAPPER!);
    write(join(work, "bin/vercel"), FAKE_VERCEL);
    chmodSync(join(work, "bin/vercel"), 0o755);
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test("exec exits with the remote script's status even though vercel exits 0", () => {
    const failed = sbx(["exec", "box", "echo hi; exit 3"]);
    expect(failed.status).toBe(3);
    expect(failed.stdout).toContain("hi\n");

    const passed = sbx(["exec", "box", "true"]);
    expect(passed.status).toBe(0);

    const call = vercelCalls()[0];
    expect(call.slice(0, 9)).toEqual([
      "sandbox", "exec", "--scope", "my-team", "--project", "my-project",
      "--timeout", "2h", "box",
    ]);
  });

  test("push syncs tracked and untracked files and keeps remote node_modules", () => {
    const local = join(work, "local");
    write(join(local, ".gitignore"), "node_modules/\nignored.log\n");
    write(join(local, "src/a.js"), "export const a = 2;\n");
    write(join(local, "packages/web/index.js"), "web\n");
    git(local, "init", "-q");
    git(local, "add", "-A");
    git(local, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
    write(join(local, "new.txt"), "untracked\n");
    write(join(local, "ignored.log"), "ignored\n");
    write(join(local, "node_modules/local-only/index.js"), "local\n");

    const remote = join(work, "remote/cand");
    write(join(remote, "src/a.js"), "export const a = 1;\n");
    write(join(remote, "stale.txt"), "deleted locally\n");
    write(join(remote, "node_modules/pkg/index.js"), "installed\n");
    write(join(remote, "packages/web/node_modules/dep/index.js"), "installed\n");

    const result = sbx(["push", "box", local, remote]);
    expect(result.status).toBe(0);

    expect(tree(join(work, "remote"))).toEqual([
      "cand/.gitignore",
      "cand/new.txt",
      "cand/node_modules/pkg/index.js",
      "cand/packages/web/index.js",
      "cand/packages/web/node_modules/dep/index.js",
      "cand/src/a.js",
    ]);
    expect(readFileSync(join(remote, "src/a.js"), "utf8")).toBe("export const a = 2;\n");
  });

  test("push outside a git work tree fails and leaves the remote tree alone", () => {
    mkdirSync(join(work, "not-a-repo"));
    const remote = join(work, "remote/cand");
    write(join(remote, "src/a.js"), "keep\n");

    const result = sbx(["push", "box", join(work, "not-a-repo"), remote]);
    expect(result.status).not.toBe(0);
    expect(tree(join(work, "remote"))).toEqual(["cand/src/a.js"]);
  });

  test("create makes a non-persistent sandbox from BASE_SNAPSHOT with owner tags", () => {
    writeFileSync(join(work, "BASE_SNAPSHOT"), "snap_base123\n");
    const result = sbx(["create", "exp-parser"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("exp-parser\n");
    expect(vercelCalls()).toEqual([
      [
        "sandbox", "create", "--scope", "my-team", "--project", "my-project",
        "--name", "exp-parser", "--non-persistent", "--snapshot", "snap_base123",
        "--vcpus", "8", "--timeout", "3h",
        "--tag", "app=my-project", "--tag", "owner=agent-a", "--silent",
      ],
    ]);
  });

  test("clean removes every listed sandbox, stopped ones included", () => {
    writeFileSync(
      join(work, "list.txt"),
      [
        "NAME         STATUS    CREATED",
        "exp-parser   running   2 minutes ago",
        "exp-lexer    stopped   1 hour ago",
        "",
        "More results: sandbox list --all --tag owner=agent-a --cursor abc",
        "",
      ].join("\n"),
    );
    const result = sbx(["clean"]);
    expect(result.status).toBe(0);
    expect(vercelCalls()).toEqual([
      ["sandbox", "list", "--scope", "my-team", "--project", "my-project", "--all", "--tag", "owner=agent-a"],
      ["sandbox", "remove", "--scope", "my-team", "--project", "my-project", "exp-parser", "exp-lexer"],
    ]);
  });

  test("clean with nothing to remove makes no remove call", () => {
    writeFileSync(join(work, "list.txt"), "NAME   STATUS   CREATED\n");
    const result = sbx(["clean"]);
    expect(result.status).toBe(0);
    expect(vercelCalls().map((call) => call[1])).toEqual(["list"]);
  });

  test("get fails when the remote file does not exist", () => {
    const result = sbx(["get", "box", join(work, "missing.json"), join(work, "out.json")]);
    expect(result.status).toBe(1);
    expect(existsSync(join(work, "out.json"))).toBe(false);
  });
});
