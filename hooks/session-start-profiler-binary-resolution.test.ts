import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  binaryNeedsShell,
  buildShellCommand,
  getBinaryPathCandidates,
} from "./src/session-start-profiler.mts";

// npm lays down three entries per global binary in %APPDATA%\npm:
// `vercel` (POSIX sh shim), `vercel.CMD` and `vercel.ps1`. Only the .CMD is
// usable from Node, so candidate ordering decides whether the CLI is found.
const NPM_STYLE_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1".split(";");

describe("getBinaryPathCandidates", () => {
  test("returns the bare name on non-Windows platforms", () => {
    expect(getBinaryPathCandidates("vercel", "linux")).toEqual(["vercel"]);
    expect(getBinaryPathCandidates("vercel", "darwin")).toEqual(["vercel"]);
  });

  test("prefers a spawnable extension over npm's extensionless POSIX shim", () => {
    const candidates = getBinaryPathCandidates("vercel", "win32", NPM_STYLE_PATHEXT);

    expect(candidates.indexOf("vercel.CMD")).toBeLessThan(candidates.indexOf("vercel"));
    expect(candidates[candidates.length - 1]).toBe("vercel");
  });

  test("never ranks a non-spawnable PATHEXT entry above a real executable", () => {
    const candidates = getBinaryPathCandidates("vercel", "win32", NPM_STYLE_PATHEXT);

    for (const spawnable of ["vercel.COM", "vercel.EXE", "vercel.BAT", "vercel.CMD"]) {
      for (const rejected of ["vercel.VBS", "vercel.JS", "vercel.PS1"]) {
        expect(candidates.indexOf(spawnable)).toBeLessThan(candidates.indexOf(rejected));
      }
    }
  });

  test("keeps every PATHEXT entry as a candidate", () => {
    const candidates = getBinaryPathCandidates("vercel", "win32", NPM_STYLE_PATHEXT);

    expect(candidates.length).toBe(NPM_STYLE_PATHEXT.length + 1);
    for (const extension of NPM_STYLE_PATHEXT) {
      expect(candidates).toContain(`vercel${extension}`);
    }
  });

  test("does not append extensions to an already-qualified name", () => {
    expect(getBinaryPathCandidates("vercel.cmd", "win32", NPM_STYLE_PATHEXT)).toEqual([
      "vercel.cmd",
    ]);
  });
});

describe("binaryNeedsShell", () => {
  test("requires a shell for Windows batch wrappers", () => {
    // Node rejects these with EINVAL when spawned directly (CVE-2024-27980 fix).
    expect(binaryNeedsShell("C:\\npm\\vercel.CMD", "win32")).toBe(true);
    expect(binaryNeedsShell("C:\\npm\\vercel.bat", "win32")).toBe(true);
  });

  test("spawns real executables directly", () => {
    expect(binaryNeedsShell("C:\\tools\\vercel.exe", "win32")).toBe(false);
  });

  test("never asks for a shell off Windows", () => {
    expect(binaryNeedsShell("/usr/local/bin/vercel", "linux")).toBe(false);
    expect(binaryNeedsShell("/usr/local/bin/weird.cmd", "darwin")).toBe(false);
  });
});

describe("buildShellCommand", () => {
  test("quotes a batch wrapper path that contains spaces", () => {
    expect(
      buildShellCommand("C:\\Program Files\\nodejs\\npm.cmd", ["view", "vercel", "version"]),
    ).toBe('"C:\\Program Files\\nodejs\\npm.cmd" view vercel version');
  });

  test.skipIf(process.platform === "win32")(
    "runs a binary under a path with spaces through a shell with its args intact",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "vercel plugin "));
      try {
        const binary = join(dir, "fake vercel");
        writeFileSync(binary, '#!/bin/sh\necho "$# $*"\n');
        chmodSync(binary, 0o755);

        const output = execSync(buildShellCommand(binary, ["--version"]), {
          encoding: "utf-8",
        }).trim();

        expect(output).toBe("1 --version");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
