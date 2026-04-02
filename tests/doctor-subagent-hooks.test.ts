import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { doctor, type DoctorResult } from "../src/commands/doctor.ts";

const ROOT = resolve(import.meta.dir, "..");

/**
 * Create a minimal project fixture by copying engine/ and generated/ from ROOT,
 * plus writing a custom hooks.json.
 */
function createFixture(hooksJson: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "doctor-subagent-"));
  // Copy engine dir (needed for live scan)
  cpSync(join(ROOT, "engine"), join(dir, "engine"), { recursive: true });
  // Copy generated manifest
  mkdirSync(join(dir, "generated"), { recursive: true });
  cpSync(
    join(ROOT, "generated", "skill-rules.json"),
    join(dir, "generated", "skill-rules.json")
  );
  // Write custom hooks.json
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(
    join(dir, "hooks", "hooks.json"),
    JSON.stringify(hooksJson, null, 2)
  );
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

function issuesForCheck(result: DoctorResult, check: string) {
  return result.issues.filter((i) => i.check === check);
}

// ---------------------------------------------------------------------------
// SubagentStart / SubagentStop registration
// ---------------------------------------------------------------------------

describe("doctor: subagent hooks", () => {
  test("passes when SubagentStart and SubagentStop are properly registered", () => {
    const dir = createFixture({
      hooks: {
        SubagentStart: [
          {
            matcher: ".+",
            hooks: [{ type: "command", command: "echo start", timeout: 5 }],
          },
        ],
        SubagentStop: [
          {
            matcher: ".+",
            hooks: [{ type: "command", command: "echo stop", timeout: 5 }],
          },
        ],
      },
    });
    try {
      const result = doctor(dir);
      const subagentIssues = issuesForCheck(result, "subagent-hooks");
      expect(subagentIssues).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  test("errors when SubagentStart is missing", () => {
    const dir = createFixture({
      hooks: {
        SubagentStop: [
          {
            matcher: ".+",
            hooks: [{ type: "command", command: "echo stop", timeout: 5 }],
          },
        ],
      },
    });
    try {
      const result = doctor(dir);
      const subagentIssues = issuesForCheck(result, "subagent-hooks");
      const startError = subagentIssues.find(
        (i) => i.severity === "error" && i.message.includes("SubagentStart")
      );
      expect(startError).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  test("errors when SubagentStop is missing", () => {
    const dir = createFixture({
      hooks: {
        SubagentStart: [
          {
            matcher: ".+",
            hooks: [{ type: "command", command: "echo start", timeout: 5 }],
          },
        ],
      },
    });
    try {
      const result = doctor(dir);
      const subagentIssues = issuesForCheck(result, "subagent-hooks");
      const stopError = subagentIssues.find(
        (i) => i.severity === "error" && i.message.includes("SubagentStop")
      );
      expect(stopError).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  test("warns when timeout exceeds 5s", () => {
    const dir = createFixture({
      hooks: {
        SubagentStart: [
          {
            matcher: ".+",
            hooks: [{ type: "command", command: "echo start", timeout: 10 }],
          },
        ],
        SubagentStop: [
          {
            matcher: ".+",
            hooks: [{ type: "command", command: "echo stop", timeout: 5 }],
          },
        ],
      },
    });
    try {
      const result = doctor(dir);
      const subagentIssues = issuesForCheck(result, "subagent-hooks");
      const timeoutWarn = subagentIssues.find(
        (i) =>
          i.severity === "warning" &&
          i.message.includes("timeout") &&
          i.message.includes("10s")
      );
      expect(timeoutWarn).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  test("warns when matcher doesn't cover expected agent types", () => {
    const dir = createFixture({
      hooks: {
        SubagentStart: [
          {
            matcher: "Explore",
            hooks: [{ type: "command", command: "echo start", timeout: 5 }],
          },
        ],
        SubagentStop: [
          {
            matcher: "Explore",
            hooks: [{ type: "command", command: "echo stop", timeout: 5 }],
          },
        ],
      },
    });
    try {
      const result = doctor(dir);
      const subagentIssues = issuesForCheck(result, "subagent-hooks");
      // Should warn about Plan and general-purpose not being covered
      const matcherWarn = subagentIssues.find(
        (i) => i.severity === "warning" && i.message.includes("don't cover")
      );
      expect(matcherWarn).toBeDefined();
      expect(matcherWarn!.message).toContain("Plan");
      expect(matcherWarn!.message).toContain("general-purpose");
    } finally {
      cleanup(dir);
    }
  });

  test("warns when matcher is empty string (matches nothing)", () => {
    const dir = createFixture({
      hooks: {
        SubagentStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "echo start", timeout: 5 }],
          },
        ],
        SubagentStop: [
          {
            matcher: ".+",
            hooks: [{ type: "command", command: "echo stop", timeout: 5 }],
          },
        ],
      },
    });
    try {
      const result = doctor(dir);
      const subagentIssues = issuesForCheck(result, "subagent-hooks");
      const emptyMatcherWarn = subagentIssues.find(
        (i) =>
          i.severity === "warning" &&
          i.message.includes("SubagentStart") &&
          i.message.includes("no matcher")
      );
      expect(emptyMatcherWarn).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  test("errors when hooks.json is missing", () => {
    // Create fixture without hooks.json
    const dir = mkdtempSync(join(tmpdir(), "doctor-subagent-"));
    cpSync(join(ROOT, "engine"), join(dir, "engine"), { recursive: true });
    mkdirSync(join(dir, "generated"), { recursive: true });
    cpSync(
      join(ROOT, "generated", "skill-rules.json"),
      join(dir, "generated", "skill-rules.json")
    );
    try {
      const result = doctor(dir);
      const subagentIssues = issuesForCheck(result, "subagent-hooks");
      const missingError = subagentIssues.find(
        (i) => i.severity === "error" && i.message.includes("hooks.json not found")
      );
      expect(missingError).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });
});
