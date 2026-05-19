import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import {
  dedupClaimDirPath,
  dedupFilePath,
  listSessionKeys,
  readSessionFile,
  tryClaimSessionKey,
  writeSessionFile,
} from "./src/hook-env.mts";
import { formatOutput as formatPreToolOutput } from "./src/pretooluse-skill-inject.mts";
import { mergeSeenSkillStatesWithCompactionReset } from "./src/patterns.mts";
import {
  formatOutput,
  parsePromptInput,
  resolvePromptSeenSkillState,
  syncPromptSeenSkillClaims,
} from "./src/user-prompt-submit-skill-inject.mts";

const SESSION_KIND = "seen-skills";
const originalSeenSkills = process.env.VERCEL_PLUGIN_SEEN_SKILLS;
const originalContextCompacted = process.env.VERCEL_PLUGIN_CONTEXT_COMPACTED;
const originalDedupMode = process.env.VERCEL_PLUGIN_HOOK_DEDUP;
const touchedSessionIds = new Set<string>();

function restoreEnv(
  name: "VERCEL_PLUGIN_SEEN_SKILLS" | "VERCEL_PLUGIN_CONTEXT_COMPACTED" | "VERCEL_PLUGIN_HOOK_DEDUP",
  value: string | undefined,
): void {
  if (typeof value === "string") {
    process.env[name] = value;
    return;
  }
  delete process.env[name];
}

function cleanupSession(sessionId: string): void {
  rmSync(dedupFilePath(sessionId, SESSION_KIND), { force: true });
  rmSync(dedupClaimDirPath(sessionId, SESSION_KIND), { recursive: true, force: true });
}

function newSessionId(name: string): string {
  const sessionId = `user-prompt-submit-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  touchedSessionIds.add(sessionId);
  return sessionId;
}

afterEach(() => {
  restoreEnv("VERCEL_PLUGIN_SEEN_SKILLS", originalSeenSkills);
  restoreEnv("VERCEL_PLUGIN_CONTEXT_COMPACTED", originalContextCompacted);
  restoreEnv("VERCEL_PLUGIN_HOOK_DEDUP", originalDedupMode);
  for (const sessionId of touchedSessionIds) {
    cleanupSession(sessionId);
  }
  touchedSessionIds.clear();
});

describe("user prompt seen-skills dedup state", () => {
  it("test_resolvePromptSeenSkillState_merges_file_and_claims_when_session_id_present", () => {
    const sessionId = newSessionId("merge");

    process.env.VERCEL_PLUGIN_HOOK_DEDUP = "";
    process.env.VERCEL_PLUGIN_SEEN_SKILLS = "skill-env,shared";
    writeSessionFile(sessionId, SESSION_KIND, "skill-file,shared");
    tryClaimSessionKey(sessionId, SESSION_KIND, "skill-claim");

    const state = resolvePromptSeenSkillState(sessionId);

    expect(state.dedupOff).toBe(false);
    expect(state.hasFileDedup).toBe(true);
    expect(state.seenEnv).toBe("skill-env,shared");
    expect(state.seenClaims).toBe("skill-claim");
    expect(state.seenState).toBe("shared,skill-claim,skill-file");
    expect(readSessionFile(sessionId, SESSION_KIND)).toBe(state.seenState);
    expect(process.env.VERCEL_PLUGIN_SEEN_SKILLS).toBe("skill-env,shared");
  });

  it("test_syncPromptSeenSkillClaims_updates_claims_and_session_file_when_skills_injected", () => {
    const sessionId = newSessionId("sync");

    process.env.VERCEL_PLUGIN_SEEN_SKILLS = "skill-env";
    const synced = syncPromptSeenSkillClaims(sessionId, ["skill-new", "skill-env"]);

    expect(synced).toBe("skill-env,skill-new");
    expect(readSessionFile(sessionId, SESSION_KIND)).toBe("skill-env,skill-new");
    expect(process.env.VERCEL_PLUGIN_SEEN_SKILLS).toBe("skill-env");
  });

  it("test_mergeSeenSkillStatesWithCompactionReset_clears_only_high_priority_skills_across_session_artifacts", () => {
    const sessionId = newSessionId("compact-reset");
    const scopeId = "subagent-compact-reset";

    process.env.VERCEL_PLUGIN_SEEN_SKILLS = "ai-sdk,low-skill,shared";
    process.env.VERCEL_PLUGIN_CONTEXT_COMPACTED = "true";

    writeSessionFile(sessionId, SESSION_KIND, "ai-sdk,low-skill");
    writeSessionFile(sessionId, SESSION_KIND, "low-skill,workflow", scopeId);
    tryClaimSessionKey(sessionId, SESSION_KIND, "ai-sdk");
    tryClaimSessionKey(sessionId, SESSION_KIND, "low-skill");
    tryClaimSessionKey(sessionId, SESSION_KIND, "workflow", scopeId);
    tryClaimSessionKey(sessionId, SESSION_KIND, "low-skill", scopeId);

    const result = mergeSeenSkillStatesWithCompactionReset(
      process.env.VERCEL_PLUGIN_SEEN_SKILLS,
      readSessionFile(sessionId, SESSION_KIND),
      listSessionKeys(sessionId, SESSION_KIND).join(","),
      {
        sessionId,
        includeEnv: false,
        skillMap: {
          "ai-sdk": { priority: 7 },
          workflow: { priority: 8 },
          "low-skill": { priority: 6 },
        },
      },
    );

    expect(result.compactionResetApplied).toBe(true);
    expect(result.clearedSkills).toEqual(["ai-sdk", "workflow"]);
    expect(result.seenState).toBe("low-skill");
    expect(process.env.VERCEL_PLUGIN_SEEN_SKILLS).toBe("low-skill,shared");
    expect(process.env.VERCEL_PLUGIN_CONTEXT_COMPACTED).toBe("");
    expect(readSessionFile(sessionId, SESSION_KIND)).toBe("low-skill");
    expect(readSessionFile(sessionId, SESSION_KIND, scopeId)).toBe("low-skill");
    expect(listSessionKeys(sessionId, SESSION_KIND)).toEqual(["low-skill"]);
    expect(listSessionKeys(sessionId, SESSION_KIND, scopeId)).toEqual(["low-skill"]);
    expect(tryClaimSessionKey(sessionId, SESSION_KIND, "ai-sdk")).toBe(true);
    expect(tryClaimSessionKey(sessionId, SESSION_KIND, "workflow", scopeId)).toBe(true);
  });
});

describe("user prompt cursor compatibility", () => {
  it("test_parsePromptInput_normalizes_cursor_fields_when_workspace_root_present", () => {
    const parsed = parsePromptInput(
      JSON.stringify({
        conversation_id: "cursor-conversation",
        workspace_roots: ["/tmp/cursor-workspace", "/tmp/ignored"],
        cursor_version: "1.0.0",
        prompt: "Use the AI SDK for streaming text generation",
      }),
    );

    expect(parsed).toEqual({
      prompt: "Use the AI SDK for streaming text generation",
      platform: "cursor",
      sessionId: "cursor-conversation",
      cwd: "/tmp/cursor-workspace",
    });
  });

  it("test_parsePromptInput_uses_cursor_message_and_project_dir_fallbacks", () => {
    const parsed = parsePromptInput(
      JSON.stringify({
        conversation_id: "cursor-conversation",
        cursor_version: "1.0.0",
        message: "Use ai elements for streaming markdown in this chat UI",
      }),
      undefined,
      {
        ...process.env,
        CURSOR_PROJECT_DIR: "/tmp/cursor-project",
        CLAUDE_PROJECT_ROOT: "/tmp/claude-project",
      },
    );

    expect(parsed).toEqual({
      prompt: "Use ai elements for streaming markdown in this chat UI",
      platform: "cursor",
      sessionId: "cursor-conversation",
      cwd: "/tmp/cursor-project",
    });
  });

  it("test_formatOutput_returns_cursor_flat_shape_with_continue_and_env", () => {
    const output = JSON.parse(formatOutput(
      ["You must run the Skill(ai-sdk) tool."],
      ["ai-sdk"],
      ["ai-sdk"],
      [],
      [],
      [],
      [],
      { "ai-sdk": "matched AI SDK" },
      undefined,
      "cursor",
      { VERCEL_PLUGIN_SEEN_SKILLS: "ai-sdk" },
    ));

    expect(output.continue).toBe(true);
    expect(output.additional_context).toContain("Skill(ai-sdk)");
    expect(output.additional_context).toContain("skillInjection");
    expect(output.env).toEqual({ VERCEL_PLUGIN_SEEN_SKILLS: "ai-sdk" });
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it("test_formatOutput_omits_droppedByCap_from_prettooluse_injected_metadata_comment", () => {
    const output = JSON.parse(formatPreToolOutput({
      parts: ["You must run the Skill(ai-sdk) tool."],
      matched: new Set(["ai-sdk", "workflow"]),
      injectedSkills: ["ai-sdk"],
      summaryOnly: [],
      droppedByCap: ["workflow"],
      droppedByBudget: [],
      toolName: "Write",
      toolTarget: "app/page.tsx",
      platform: "claude-code",
    }));

    const context = output.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("skillInjection");
    expect(context).not.toContain('"droppedByCap"');
    expect(context).toContain('"droppedByBudget":[]');
  });
});
