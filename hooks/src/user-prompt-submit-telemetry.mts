#!/usr/bin/env node
/**
 * UserPromptSubmit hook: content telemetry opt-in + prompt text tracking.
 *
 * Fires on every user message. Two responsibilities:
 *
 * 1. Track prompt:text telemetry (awaited) for every prompt >= 10 chars
 *    when content telemetry is enabled. This runs independently of skill
 *    matching so prompts are never silently dropped.
 *
 * 2. On the first message of a session where the user hasn't recorded a
 *    content telemetry preference, return additionalContext asking the model
 *    to prompt the user for opt-in. Writes "asked" immediately so the user
 *    is never re-prompted. session-end-cleanup converts "asked" → "disabled".
 *
 * Note: Base telemetry is enabled by default, but users can disable all
 * telemetry with VERCEL_PLUGIN_TELEMETRY=off. This hook only gates prompt
 * text and full bash command collection when telemetry is otherwise enabled.
 *
 * Input:  JSON on stdin with { session_id, prompt }
 * Output: JSON on stdout with { hookSpecificOutput: { hookEventName, additionalContext } } or {}
 */

import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { getTelemetryOverride, isContentTelemetryEnabled, trackContentEvents } from "./telemetry.mjs";

const PREF_PATH = join(homedir(), ".claude", "vercel-plugin-telemetry-preference");
const MIN_PROMPT_LENGTH = 10;

function parseStdin(): Record<string, unknown> | null {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveSessionId(input: Record<string, unknown>): string {
  return (input.session_id as string) || (input.conversation_id as string) || "";
}

function resolvePrompt(input: Record<string, unknown>): string {
  return (input.prompt as string) || (input.message as string) || "";
}

async function main(): Promise<void> {
  const input = parseStdin();
  const sessionId = input ? resolveSessionId(input) : "";
  const prompt = input ? resolvePrompt(input) : "";
  const telemetryOverride = getTelemetryOverride();

  // Prompt text tracking — opt-in only
  if (isContentTelemetryEnabled() && sessionId && prompt.length >= MIN_PROMPT_LENGTH) {
    await trackContentEvents(sessionId, [
      { key: "prompt:text", value: prompt },
    ]).catch(() => {});
  }

  // A global kill switch means the user has already disabled telemetry.
  if (telemetryOverride === "off") {
    process.stdout.write("{}");
    process.exit(0);
  }

  // Already opted in, out, or asked — nothing more to do
  try {
    const pref = readFileSync(PREF_PATH, "utf-8").trim();
    if (pref === "enabled" || pref === "disabled" || pref === "asked") {
      process.stdout.write("{}");
      process.exit(0);
    }
  } catch {
    // File doesn't exist — user hasn't decided yet
  }

  // Once-per-session guard: don't ask again after the first message
  if (sessionId) {
    const flagPath = join(tmpdir(), `vercel-plugin-telemetry-asked-${sessionId}`);
    if (existsSync(flagPath)) {
      process.stdout.write("{}");
      process.exit(0);
    }
    try {
      mkdirSync(dirname(flagPath), { recursive: true });
      writeFileSync(flagPath, "1", { flag: "wx" });
    } catch {
      // Race or permission issue — skip this time
      process.stdout.write("{}");
      process.exit(0);
    }
  }

  // Write "asked" immediately so we never re-prompt across sessions
  try {
    mkdirSync(dirname(PREF_PATH), { recursive: true });
    writeFileSync(PREF_PATH, "asked");
  } catch {
    // If we can't write, fall through — tmpdir flag still guards this session
  }

  const message = [
    "After responding to the user's message, use the AskUserQuestion tool to ask about telemetry.",
    "Use this exact question configuration:",
    '- question: "The Vercel plugin collects anonymous usage data such as skill injection patterns and tools used by default. Would you like to also share raw content telemetry, including your prompt text and full bash commands, to help improve skill matching and command understanding? This choice only controls content telemetry."',
    '- header: "Telemetry"',
    '- options: [{"label": "Share content", "description": "Share prompt text and full bash commands in addition to default anonymous usage data"}, {"label": "No thanks", "description": "Keep prompt text and full bash commands private. This only disables content telemetry"}]',
    "- multiSelect: false",
    "",
    "After the user responds:",
    "- If they chose \"Share content\", run: `echo 'enabled' > ~/.claude/vercel-plugin-telemetry-preference`",
    "- If they chose \"No thanks\" or anything else, run: `echo 'disabled' > ~/.claude/vercel-plugin-telemetry-preference`",
  ].join("\n");

  const output: SyncHookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit" as const,
      additionalContext: message,
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
