import { describe, expect, it } from "bun:test";
import {
  formatOutput as formatPreToolOutput,
  parseInput as parsePreToolInput,
} from "./src/pretooluse-skill-inject.mts";

describe("platform hook compatibility", () => {
  it("test_parseInput_normalizes_cursor_session_and_workspace_root_for_pretooluse", () => {
    const parsed = parsePreToolInput(
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "app/page.tsx" },
        conversation_id: "cursor-conversation",
        workspace_roots: ["/tmp/cursor-workspace"],
      }),
      undefined,
      {
        ...process.env,
        CURSOR_PROJECT_DIR: "/tmp/cursor-project",
        CLAUDE_PROJECT_ROOT: "/tmp/claude-project",
      },
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.platform).toBe("cursor");
    expect(parsed?.sessionId).toBe("cursor-conversation");
    expect(parsed?.cwd).toBe("/tmp/cursor-workspace");
  });

  it("test_formatOutput_returns_cursor_env_only_payload_when_pretooluse_has_no_context", () => {
    const output = formatPreToolOutput({
      parts: [],
      matched: new Set(),
      injectedSkills: [],
      droppedByCap: [],
      toolName: "Write",
      toolTarget: "app/page.tsx",
      platform: "cursor",
      env: {
        VERCEL_PLUGIN_TSX_EDIT_COUNT: "2",
      },
    });

    expect(JSON.parse(output)).toEqual({
      env: {
        VERCEL_PLUGIN_TSX_EDIT_COUNT: "2",
      },
    });
  });

  it("test_formatOutput_returns_cursor_flat_payload_with_env_for_pretooluse", () => {
    const output = formatPreToolOutput({
      parts: ["You must run the Skill(ai-sdk) tool."],
      matched: new Set(["ai-sdk"]),
      injectedSkills: ["ai-sdk"],
      droppedByCap: [],
      toolName: "Write",
      toolTarget: "app/page.tsx",
      platform: "cursor",
      env: {
        VERCEL_PLUGIN_SEEN_SKILLS: "ai-sdk",
        VERCEL_PLUGIN_TSX_EDIT_COUNT: "1",
      },
    });

    const parsed = JSON.parse(output);
    expect(parsed.additional_context).toContain("Skill(ai-sdk)");
    expect(parsed.env).toEqual({
      VERCEL_PLUGIN_SEEN_SKILLS: "ai-sdk",
      VERCEL_PLUGIN_TSX_EDIT_COUNT: "1",
    });
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

});
