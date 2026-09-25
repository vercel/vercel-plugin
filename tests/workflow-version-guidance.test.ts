import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The current `@ai-sdk/workflow` (2.x, WorkflowAgent) requires Workflow 5,
// which npm publishes on the `beta` tag; `workflow@latest` is the 4.x line,
// whose docs use `DurableAgent` from `@workflow/ai`. Guidance that recommends
// WorkflowAgent or calls DurableAgent deprecated must name the version.

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("Workflow 5 version guidance", () => {
  test("session-start knowledge update states that Workflow 5 is on the beta tag", () => {
    expect(read("skills/knowledge-update/SKILL.md")).toMatch(
      /Workflow 5 ships on the `beta` npm tag \(`npm i workflow@beta`\), and the current `@ai-sdk\/workflow` \(2\.x\) requires it\. `npm i workflow` installs 4\.x/,
    );
  });

  test("the DurableAgent chainTo message scopes the deprecation to Workflow 5", () => {
    const overlay = read("skills/workflow/overlay.yaml");
    expect(overlay).toContain("Workflow 5 (workflow@beta) deprecates DurableAgent");
    expect(overlay).not.toContain("DurableAgent (@workflow/ai) is deprecated");
  });

  test("vercel.md and the ai-architect agent tie WorkflowAgent to Workflow 5", () => {
    const graph = read("vercel.md");
    expect(graph).toContain("@ai-sdk/workflow 2.x, requires Workflow 5 on workflow@beta");
    expect(graph).toContain("`DurableAgent` → `WorkflowAgent` (`@ai-sdk/workflow` 2.x requires Workflow 5, `workflow@beta`)");
    expect(graph).toContain("the current 2.x line requires Workflow 5 (`workflow@beta`)");
    expect(graph).toContain("`WorkflowAgent` from `@ai-sdk/workflow` (Workflow 5, `workflow@beta`) |");
    expect(graph).toContain("on Workflow SDK 5 (`workflow@beta`)");
    expect(graph).toContain("for durable agents, `WorkflowAgent` needs Workflow 5 (`workflow@beta`)");
    expect(read("agents/ai-architect.md.tmpl")).toContain("(Workflow SDK 5, `workflow@beta`)");
  });
});
