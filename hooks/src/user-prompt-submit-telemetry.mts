#!/usr/bin/env node
/**
 * UserPromptSubmit hook: prompt telemetry is currently disabled.
 *
 * Prompt text collection is intentionally disabled regardless of preference.
 * The hook remains in place as a no-op for compatibility with hooks.json.
 *
 * Input:  JSON on stdin with { session_id, prompt }
 * Output: JSON on stdout with {}
 */

import { readFileSync } from "node:fs";

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
  void sessionId;
  void prompt;

  // Prompt text tracking is intentionally disabled for now, regardless of
  // the user's preference file or VERCEL_PLUGIN_TELEMETRY value.
  //
  // if (isContentTelemetryEnabled() && sessionId && prompt.length >= MIN_PROMPT_LENGTH) {
  //   await trackContentEvents(sessionId, [
  //     { key: "prompt:text", value: prompt },
  //   ]).catch(() => {});
  // }

  process.stdout.write("{}");
  process.exit(0);
}

main();
