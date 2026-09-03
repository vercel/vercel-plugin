#!/usr/bin/env node

// hooks/src/posttooluse-skill-telemetry.mts
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dedupFilePath, pluginRoot, readSessionFile, writeSessionFile } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  isDauTelemetryEnabled,
  isValidTelemetrySessionId,
  normalizeSkillInvocation,
  trackSkillInvocation
} from "./telemetry.mjs";
var log = createLogger();
var SEND_FLAG = "--send";
var TELEMETRY_SESSION_ID_KIND = "telemetry-session-id";
function parseSkillTelemetryHookInput(raw) {
  try {
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function loadKnownPluginSkills(root = pluginRoot(import.meta.url)) {
  const known = /* @__PURE__ */ new Set();
  try {
    for (const entry of readdirSync(join(root, "skills"), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, "skills", entry.name, "SKILL.md"))) {
        known.add(entry.name);
      }
    }
  } catch (error) {
    logCaughtError(log, "skill-telemetry:read-skills-dir-failed", error, { root });
  }
  try {
    for (const entry of readdirSync(join(root, "commands"), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
        known.add(entry.name.slice(0, -".md".length));
      }
    }
  } catch (error) {
    logCaughtError(log, "skill-telemetry:read-commands-dir-failed", error, { root });
  }
  return known;
}
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
function buildSkillInvocationPayload(input, knownSkills, env = process.env) {
  if (!input || !isDauTelemetryEnabled(env)) return null;
  if (input.tool_name !== "Skill") return null;
  const toolInput = input.tool_input;
  const rawSkill = toolInput && typeof toolInput === "object" ? toolInput.skill : void 0;
  const skill = normalizeSkillInvocation(rawSkill, knownSkills);
  if (!skill) return null;
  const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
  const telemetrySessionId = resolveTelemetrySessionId(sessionId);
  return telemetrySessionId ? { skill, telemetrySessionId } : { skill };
}
function parseSendPayload(argv) {
  const flagIndex = argv.indexOf(SEND_FLAG);
  if (flagIndex === -1) return null;
  try {
    const parsed = JSON.parse(argv[flagIndex + 1] ?? "");
    if (!parsed || typeof parsed !== "object") return null;
    const { skill, telemetrySessionId } = parsed;
    if (typeof skill !== "string") return null;
    return isValidTelemetrySessionId(telemetrySessionId) ? { skill, telemetrySessionId } : { skill };
  } catch {
    return null;
  }
}
function spawnDetachedSender(entrypoint, payload) {
  try {
    const child = spawn(process.execPath, [entrypoint, SEND_FLAG, JSON.stringify(payload)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  } catch (error) {
    logCaughtError(log, "skill-telemetry:spawn-failed", error, { skill: payload.skill });
  }
}
async function main(entrypoint) {
  const sendPayload = parseSendPayload(process.argv);
  if (sendPayload) {
    await trackSkillInvocation(sendPayload.skill, {
      telemetrySessionId: sendPayload.telemetrySessionId
    }).catch(() => false);
    process.exit(0);
  }
  const input = parseSkillTelemetryHookInput(readFileSync(0, "utf8"));
  const payload = buildSkillInvocationPayload(input, loadKnownPluginSkills());
  if (payload) {
    log.debug("skill-telemetry:queued", { skill: payload.skill });
    spawnDetachedSender(entrypoint, payload);
  }
  process.exit(0);
}
var SKILL_TELEMETRY_ENTRYPOINT = fileURLToPath(import.meta.url);
var isSkillTelemetryEntrypoint = process.argv[1] ? resolve(process.argv[1]) === SKILL_TELEMETRY_ENTRYPOINT : false;
if (isSkillTelemetryEntrypoint) {
  main(SKILL_TELEMETRY_ENTRYPOINT);
}
export {
  buildSkillInvocationPayload,
  loadKnownPluginSkills,
  parseSendPayload,
  parseSkillTelemetryHookInput,
  resolveTelemetrySessionId
};
