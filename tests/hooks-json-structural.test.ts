/**
 * Structural validation: the default hook profile stays lightweight.
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

describe("hooks.json lightweight default", () => {
  test("does not register pretool skill injection by default", () => {
    const groups = hooksJson.hooks.PreToolUse ?? [];
    const hasSkillInjection = groups.some((group) =>
      group.hooks.some((hook) => hook.command.includes("pretooluse-skill-inject.mjs")),
    );

    expect(hasSkillInjection).toBe(false);
  });

  test("does not register user-prompt skill injection by default", () => {
    const groups = hooksJson.hooks.UserPromptSubmit ?? [];
    const hasSkillInjection = groups.some((group) =>
      group.hooks.some((hook) => hook.command.includes("user-prompt-submit-skill-inject.mjs")),
    );

    expect(hasSkillInjection).toBe(false);
  });

  test("does not register prompt telemetry hooks by default", () => {
    const groups = hooksJson.hooks.UserPromptSubmit ?? [];
    const hasPromptTelemetry = groups.some((group) =>
      group.hooks.some((hook) => hook.command.includes("user-prompt-submit-telemetry.mjs")),
    );

    expect(hasPromptTelemetry).toBe(false);
  });

  test("does not register post-tool injection hooks by default", () => {
    const groups = hooksJson.hooks.PostToolUse ?? [];
    const hasPostToolInjection = groups.some((group) =>
      group.hooks.some((hook) =>
        hook.command.includes("posttooluse-bash-chain.mjs")
        || hook.command.includes("posttooluse-validate.mjs")
        || hook.command.includes("posttooluse-shadcn-font-fix.mjs"),
      ),
    );

    expect(hasPostToolInjection).toBe(false);
  });

  test("does not register verification observer by default", () => {
    const groups = hooksJson.hooks.PostToolUse ?? [];
    const hasVerificationObserver = groups.some((group) =>
      group.hooks.some((hook) => hook.command.includes("posttooluse-verification-observe.mjs")),
    );

    expect(hasVerificationObserver).toBe(false);
  });

  test("does not register subagent bootstrap hooks by default", () => {
    expect(hooksJson.hooks.SubagentStart ?? []).toEqual([]);
    expect(hooksJson.hooks.SubagentStop ?? []).toEqual([]);
  });
});
