#!/usr/bin/env node

// hooks/src/user-prompt-submit-telemetry.mts
import { readFileSync } from "fs";
function parseStdin() {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function resolveSessionId(input) {
  return input.session_id || input.conversation_id || "";
}
function resolvePrompt(input) {
  return input.prompt || input.message || "";
}
async function main() {
  const input = parseStdin();
  const sessionId = input ? resolveSessionId(input) : "";
  const prompt = input ? resolvePrompt(input) : "";
  void sessionId;
  void prompt;
  process.stdout.write("{}");
  process.exit(0);
}
main();
