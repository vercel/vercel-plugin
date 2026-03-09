#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createLogger, logCaughtError } from "./logger.mjs";
const log = createLogger();
function parseInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function ledgerPath(sessionId) {
  return resolve(tmpdir(), `vercel-plugin-${sessionId}-subagent-ledger.jsonl`);
}
function appendLedger(entry) {
  const path = ledgerPath(entry.session_id);
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch (error) {
    logCaughtError(log, "subagent-stop-sync:append-ledger-failed", error, { path });
  }
}
function main() {
  const input = parseInput();
  if (!input) {
    process.exit(0);
  }
  const sessionId = input.session_id;
  if (!sessionId) {
    process.exit(0);
  }
  const agentId = input.agent_id ?? "unknown";
  const agentType = input.agent_type ?? "unknown";
  log.debug("subagent-stop-sync", { sessionId, agentId, agentType });
  appendLedger({
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    session_id: sessionId,
    agent_id: agentId,
    agent_type: agentType,
    agent_transcript_path: input.agent_transcript_path
  });
  process.exit(0);
}
const ENTRYPOINT = fileURLToPath(import.meta.url);
const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === ENTRYPOINT : false;
if (isEntrypoint) {
  main();
}
export {
  appendLedger,
  ledgerPath,
  main,
  parseInput
};
