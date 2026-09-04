#!/usr/bin/env node

// hooks/src/posttooluse-skill-telemetry.mts
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { normalizeInput } from "./compat.mjs";
import { pluginRoot } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  buildSkillTelemetryPayload,
  parseSendPayload,
  spawnDetachedSkillTelemetrySender
} from "./skill-telemetry.mjs";
import {
  SKILL_INVOKED_EVENT_KEY,
  normalizeSkillInvocation,
  trackSkillEvents
} from "./telemetry.mjs";
var log = createLogger();
var SKILL_TOOL_NAMES = /* @__PURE__ */ new Set(["Skill"]);
function parseSkillTelemetryHookInput(raw) {
  try {
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
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
function buildSkillInvocationPayload(input, knownSkills, env = process.env) {
  if (!input) return null;
  const normalized = normalizeInput(input);
  if (!normalized.toolName || !SKILL_TOOL_NAMES.has(normalized.toolName)) return null;
  const skill = normalizeSkillInvocation(normalized.toolInput?.skill, knownSkills);
  if (!skill) return null;
  return buildSkillTelemetryPayload(SKILL_INVOKED_EVENT_KEY, [skill], normalized.sessionId || null, env);
}
async function main(entrypoint) {
  const sendPayload = parseSendPayload(process.argv);
  if (sendPayload) {
    await trackSkillEvents(sendPayload.key, sendPayload.skills, {
      telemetrySessionId: sendPayload.telemetrySessionId,
      agentHarness: sendPayload.agentHarness
    }).catch(() => false);
    process.exit(0);
  }
  const input = parseSkillTelemetryHookInput(readFileSync(0, "utf8"));
  const payload = buildSkillInvocationPayload(input, loadKnownPluginSkills());
  if (payload) {
    log.debug("skill-telemetry:queued", { key: payload.key, skills: payload.skills, agentHarness: payload.agentHarness });
    spawnDetachedSkillTelemetrySender(payload, entrypoint);
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
  parseSkillTelemetryHookInput
};
