/**
 * Structural validation: hooks.json contains SubagentStart and SubagentStop
 * entries with the expected matchers and timeouts.
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
}

interface HooksJson {
  hooks: Record<string, HookGroup[]>;
}

const hooksJson: HooksJson = await import(resolve(ROOT, "hooks/hooks.json"));

describe("hooks.json SubagentStart", () => {
  const groups = hooksJson.hooks.SubagentStart;

  test("array exists with at least one entry", () => {
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  test("matcher is '.+'", () => {
    expect(groups[0].matcher).toBe(".+");
  });

  test("hook has timeout set to 5", () => {
    expect(groups[0].hooks[0].timeout).toBe(5);
  });
});

describe("hooks.json PostToolUse verification observer coverage", () => {
  const postToolUseGroups = hooksJson.hooks.PostToolUse;

  test("verification observer is registered for Bash", () => {
    const bashGroup = postToolUseGroups.find((g) => g.matcher === "Bash");
    expect(bashGroup).toBeDefined();
    const observerHook = bashGroup!.hooks.find((h) =>
      h.command.includes("posttooluse-verification-observe"),
    );
    expect(observerHook).toBeDefined();
    expect(observerHook!.timeout).toBe(5);
  });

  test("verification observer is registered for non-Bash tools", () => {
    const nonBashGroup = postToolUseGroups.find(
      (g) => g.matcher.includes("Read") && g.matcher.includes("WebFetch"),
    );
    expect(nonBashGroup).toBeDefined();
    expect(nonBashGroup!.matcher).toBe("Read|Edit|Write|Glob|Grep|WebFetch");

    const observerHook = nonBashGroup!.hooks.find((h) =>
      h.command.includes("posttooluse-verification-observe"),
    );
    expect(observerHook).toBeDefined();
    expect(observerHook!.timeout).toBe(5);
  });

  test("non-Bash observer group does NOT include shadcn-font-fix or bash-chain", () => {
    const nonBashGroup = postToolUseGroups.find(
      (g) => g.matcher.includes("Read") && g.matcher.includes("WebFetch"),
    );
    expect(nonBashGroup).toBeDefined();
    const hasUnrelated = nonBashGroup!.hooks.some(
      (h) => h.command.includes("shadcn-font-fix") || h.command.includes("bash-chain"),
    );
    expect(hasUnrelated).toBe(false);
  });

  test("Bash-only hooks remain scoped to Bash matcher only", () => {
    const bashGroup = postToolUseGroups.find((g) => g.matcher === "Bash");
    expect(bashGroup).toBeDefined();
    const hasShadcn = bashGroup!.hooks.some((h) => h.command.includes("shadcn-font-fix"));
    const hasBashChain = bashGroup!.hooks.some((h) => h.command.includes("bash-chain"));
    expect(hasShadcn).toBe(true);
    expect(hasBashChain).toBe(true);
  });

  test("fixture matrix: every registered tool name reaches observer", () => {
    // Build a map of tool_name -> whether observer is reachable
    const toolNames = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"];
    const matrix: Record<string, boolean> = {};
    for (const tool of toolNames) {
      const reachable = postToolUseGroups.some((g) => {
        const matcherRegex = new RegExp(`^(${g.matcher})$`);
        return matcherRegex.test(tool) && g.hooks.some((h) =>
          h.command.includes("posttooluse-verification-observe"),
        );
      });
      matrix[tool] = reachable;
    }
    // All tools must reach the observer
    for (const tool of toolNames) {
      expect(matrix[tool]).toBe(true);
    }
  });
});

describe("hooks.json SubagentStop", () => {
  const groups = hooksJson.hooks.SubagentStop;

  test("array exists with at least one entry", () => {
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  test("matcher is '.+'", () => {
    expect(groups[0].matcher).toBe(".+");
  });

  test("hook has timeout set to 5", () => {
    expect(groups[0].hooks[0].timeout).toBe(5);
  });
});
