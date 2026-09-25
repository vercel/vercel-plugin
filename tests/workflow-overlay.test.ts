import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { profileProject } from "../hooks/src/session-start-profiler.mts";

// The Workflow SDK ships as `workflow` and `@workflow/*`; `@vercel/workflow`
// is not a public npm package (a private pre-launch package uses the name),
// and neither `createWorkflow` nor
// `experimental_createWorkflow` is exported by `workflow` or `ai`.

const ROOT = resolve(import.meta.dirname, "..");
const overlay = readFileSync(resolve(ROOT, "skills/workflow/overlay.yaml"), "utf8");
const graph = readFileSync(resolve(ROOT, "vercel.md"), "utf8");

describe("workflow overlay", () => {
  test("matches only published Workflow SDK packages", () => {
    expect(overlay).not.toContain("@vercel/workflow");
    expect(overlay).toContain("- '@workflow/*'");
  });

  test("has no rules for APIs the Workflow SDK does not export", () => {
    expect(overlay).not.toContain("createWorkflow");
    expect(graph).not.toContain("createWorkflow");
  });
});

describe("session-start profiler", () => {
  test("maps the published workflow package to the workflow skill", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-profiler-"));
    try {
      writeFileSync(
        join(projectRoot, "package.json"),
        JSON.stringify({ dependencies: { workflow: "4.8.9" } }),
      );
      expect(profileProject(projectRoot)).toContain("workflow");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
