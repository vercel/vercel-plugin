import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The current `@ai-sdk/workflow` (2.x, WorkflowAgent) requires Workflow 5,
// which npm now publishes on the `latest` tag; Workflow 4 remains installable
// as `workflow@4`, whose docs use `DurableAgent` from `@workflow/ai`. Guidance
// that recommends WorkflowAgent or calls DurableAgent deprecated must name the version.

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

// Every shipped file that names an install tag for Workflow 5. `workflow@beta`
// now resolves to an older 5.0.0 prerelease, so none of them may point there.
const WORKFLOW_GUIDANCE_FILES = [
  "skills/knowledge-update/SKILL.md",
  "skills/workflow/overlay.yaml",
  "skills/workflow/SKILL.md",
  "vercel.md",
  "agents/ai-architect.md.tmpl",
  "agents/ai-architect.md",
];

describe("Workflow 5 version guidance", () => {
  test("session-start knowledge update states that Workflow 5 is on the latest tag", () => {
    expect(read("skills/knowledge-update/SKILL.md")).toMatch(
      /Workflow 5 is the `latest` npm tag \(`npm i workflow@latest`\), and the current `@ai-sdk\/workflow` \(2\.x\) requires it\. Workflow 4 remains installable as `workflow@4`/,
    );
  });

  test("the DurableAgent chainTo message scopes the deprecation to Workflow 5", () => {
    for (const path of ["skills/workflow/overlay.yaml", "skills/workflow/SKILL.md"]) {
      const content = read(path);
      expect(content).toContain("Workflow 5 (workflow@latest) deprecates DurableAgent");
      expect(content).toContain("the Workflow 4 docs (workflow@4) use DurableAgent");
      expect(content).not.toContain("DurableAgent (@workflow/ai) is deprecated");
    }
  });

  test("vercel.md and the ai-architect agent tie WorkflowAgent to Workflow 5", () => {
    const graph = read("vercel.md");
    expect(graph).toContain("@ai-sdk/workflow 2.x, requires Workflow 5 on workflow@latest");
    expect(graph).toContain("`DurableAgent` → `WorkflowAgent` (`@ai-sdk/workflow` 2.x requires Workflow 5, `workflow@latest`)");
    expect(graph).toContain("the current 2.x line requires Workflow 5 (`workflow@latest`)");
    expect(graph).toContain("`WorkflowAgent` from `@ai-sdk/workflow` (Workflow 5, `workflow@latest`) |");
    expect(graph).toContain("on Workflow SDK 5 (`workflow@latest`)");
    expect(graph).toContain("for durable agents, `WorkflowAgent` needs Workflow 5 (`workflow@latest`)");
    expect(read("agents/ai-architect.md")).toContain("(Workflow SDK 5, `workflow@latest`)");
  });

  test("no shipped guidance sends Workflow 5 installs to the beta tag", () => {
    for (const path of WORKFLOW_GUIDANCE_FILES) {
      expect({ path, mentionsBetaTag: read(path).includes("workflow@beta") }).toEqual({
        path,
        mentionsBetaTag: false,
      });
    }
  });
});
