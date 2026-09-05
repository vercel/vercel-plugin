// hooks/src/skill-telemetry.mts
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { dedupFilePath, readSessionFile, writeSessionFile } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  isAgentHarness,
  isDauTelemetryEnabled,
  isSkillTelemetryKey,
  isValidTelemetrySessionId
} from "./telemetry.mjs";
var log = createLogger();
var SEND_FLAG = "--send";
var TELEMETRY_SESSION_ID_KIND = "telemetry-session-id";
var AGENT_HARNESS_KIND = "agent-harness";
var SENDER_BASENAME = "posttooluse-skill-telemetry.mjs";
function resolveTelemetrySessionId(sessionId) {
  if (!sessionId) return void 0;
  if (existsSync(dedupFilePath(sessionId, TELEMETRY_SESSION_ID_KIND))) {
    const existing = readSessionFile(sessionId, TELEMETRY_SESSION_ID_KIND).trim();
    if (isValidTelemetrySessionId(existing)) return existing;
  }
  const minted = randomUUID();
  writeSessionFile(sessionId, TELEMETRY_SESSION_ID_KIND, minted);
  return minted;
}
function writeSessionAgentHarness(sessionId, agentHarness) {
  writeSessionFile(sessionId, AGENT_HARNESS_KIND, agentHarness);
}
function readSessionAgentHarness(sessionId) {
  if (!sessionId) return void 0;
  if (!existsSync(dedupFilePath(sessionId, AGENT_HARNESS_KIND))) return void 0;
  const value = readSessionFile(sessionId, AGENT_HARNESS_KIND).trim();
  return isAgentHarness(value) ? value : void 0;
}
function buildSkillTelemetryPayload(key, skills, sessionId, env = process.env) {
  if (!isDauTelemetryEnabled(env)) return null;
  const uniqueSkills = [...new Set(skills)];
  if (uniqueSkills.length === 0) return null;
  const payload = { key, skills: uniqueSkills };
  const telemetrySessionId = resolveTelemetrySessionId(sessionId);
  if (telemetrySessionId) payload.telemetrySessionId = telemetrySessionId;
  const agentHarness = readSessionAgentHarness(sessionId);
  if (agentHarness) payload.agentHarness = agentHarness;
  return payload;
}
function parseSendPayload(argv) {
  const flagIndex = argv.indexOf(SEND_FLAG);
  if (flagIndex === -1) return null;
  try {
    const parsed = JSON.parse(argv[flagIndex + 1] ?? "");
    if (!parsed || typeof parsed !== "object") return null;
    const { key, skills, telemetrySessionId, agentHarness } = parsed;
    if (!isSkillTelemetryKey(key)) return null;
    if (!Array.isArray(skills)) return null;
    const validSkills = skills.filter((skill) => typeof skill === "string" && skill.length > 0);
    if (validSkills.length === 0) return null;
    const payload = { key, skills: validSkills };
    if (isValidTelemetrySessionId(telemetrySessionId)) payload.telemetrySessionId = telemetrySessionId;
    if (isAgentHarness(agentHarness)) payload.agentHarness = agentHarness;
    return payload;
  } catch {
    return null;
  }
}
function senderEntrypoint() {
  return join(dirname(fileURLToPath(import.meta.url)), SENDER_BASENAME);
}
function spawnDetachedSkillTelemetrySender(payload, entrypoint = senderEntrypoint()) {
  try {
    const child = spawn(process.execPath, [entrypoint, SEND_FLAG, JSON.stringify(payload)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return true;
  } catch (error) {
    logCaughtError(log, "skill-telemetry:spawn-failed", error, { key: payload.key, skills: payload.skills });
    return false;
  }
}
function queueSkillTelemetry(key, skills, sessionId, env = process.env) {
  try {
    const payload = buildSkillTelemetryPayload(key, skills, sessionId, env);
    if (!payload) return null;
    log.debug("skill-telemetry:queued", { key, skills: payload.skills, agentHarness: payload.agentHarness });
    spawnDetachedSkillTelemetrySender(payload);
    return payload;
  } catch (error) {
    logCaughtError(log, "skill-telemetry:queue-failed", error, { key });
    return null;
  }
}
export {
  SEND_FLAG,
  buildSkillTelemetryPayload,
  parseSendPayload,
  queueSkillTelemetry,
  readSessionAgentHarness,
  resolveTelemetrySessionId,
  spawnDetachedSkillTelemetrySender,
  writeSessionAgentHarness
};
