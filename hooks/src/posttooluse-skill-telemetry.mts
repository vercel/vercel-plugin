#!/usr/bin/env node
/**
 * PostToolUse hook (matcher: Skill): report which vercel-plugin skill was
 * invoked in the current session.
 *
 * Privacy contract:
 * - Only the bare slug of a skill or command shipped by this plugin, invoked
 *   under this plugin's namespace, is sent. Other plugins' skills, personal
 *   skills, skill arguments, prompt text, and file paths are never read past
 *   the allowlist check and never leave the machine.
 * - Honors VERCEL_PLUGIN_TELEMETRY=off.
 * - The network request runs in a detached background process (this same file
 *   re-invoked with `--send`) so the hook returns immediately and never delays
 *   the agent.
 *
 * Payloads are normalized through compat.mts, so Claude Code (`session_id`,
 * `tool_response`) and Cursor's Claude-compatible hook bridge
 * (`conversation_id`, `tool_output`) are both accepted.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeInput } from "./compat.mjs";
import { pluginRoot } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  buildSkillTelemetryPayload,
  parseSendPayload,
  spawnDetachedSkillTelemetrySender,
  type SkillTelemetryPayload,
} from "./skill-telemetry.mjs";
import {
  SKILL_INVOKED_EVENT_KEY,
  normalizeSkillInvocation,
  trackSkillEvents,
} from "./telemetry.mjs";

const log = createLogger();

/** Tool names that load a skill, across the harnesses that speak this hook contract. */
const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(["Skill"]);

export function parseSkillTelemetryHookInput(raw: string): Record<string, unknown> | null {
  try {
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Skills and commands shipped by this plugin: every `skills/<slug>/SKILL.md`
 * plus every `commands/<slug>.md` (conventions files prefixed with `_` excluded).
 */
export function loadKnownPluginSkills(root: string = pluginRoot(import.meta.url)): Set<string> {
  const known = new Set<string>();

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

/**
 * Decide what (if anything) to report for a hook payload. Returns null when
 * telemetry is disabled, the tool is not a skill loader, or the skill is not
 * one shipped by this plugin under its own namespace.
 */
export function buildSkillInvocationPayload(
  input: Record<string, unknown> | null,
  knownSkills: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): SkillTelemetryPayload | null {
  if (!input) return null;

  const normalized = normalizeInput(input);
  if (!normalized.toolName || !SKILL_TOOL_NAMES.has(normalized.toolName)) return null;

  const skill = normalizeSkillInvocation(normalized.toolInput?.skill, knownSkills);
  if (!skill) return null;

  return buildSkillTelemetryPayload(SKILL_INVOKED_EVENT_KEY, [skill], normalized.sessionId || null, env);
}

async function main(entrypoint: string): Promise<void> {
  const sendPayload = parseSendPayload(process.argv);
  if (sendPayload) {
    await trackSkillEvents(sendPayload.key, sendPayload.skills, {
      telemetrySessionId: sendPayload.telemetrySessionId,
      agentHarness: sendPayload.agentHarness,
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

const SKILL_TELEMETRY_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSkillTelemetryEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === SKILL_TELEMETRY_ENTRYPOINT
  : false;

if (isSkillTelemetryEntrypoint) {
  main(SKILL_TELEMETRY_ENTRYPOINT);
}
