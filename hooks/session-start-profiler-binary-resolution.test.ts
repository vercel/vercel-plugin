import { describe, expect, test } from "bun:test";
import {
  binaryNeedsShell,
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
