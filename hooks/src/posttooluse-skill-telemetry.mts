#!/usr/bin/env node
/**
 * PostToolUse hook (matcher: Skill): report which vercel-plugin skill was
 * invoked in the current session.
 *
 * Privacy contract:
 * - Only the bare slug of a skill or command shipped by this plugin is sent.
 *   Third-party skill names, skill arguments, prompt text, and file paths are
 *   never read past the allowlist check and never leave the machine.
 * - Honors VERCEL_PLUGIN_TELEMETRY=off.
 * - The network request runs in a detached background process so the hook
 *   returns immediately and never delays the agent.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupFilePath, pluginRoot, readSessionFile, writeSessionFile } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  isDauTelemetryEnabled,
  isValidTelemetrySessionId,
  normalizeSkillInvocation,
  trackSkillInvocation,
} from "./telemetry.mjs";

const log = createLogger();

const SEND_FLAG = "--send";
const TELEMETRY_SESSION_ID_KIND = "telemetry-session-id";

interface SkillTelemetryHookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  [key: string]: unknown;
}

export interface SkillInvocationPayload {
  skill: string;
  telemetrySessionId?: string;
}

export function parseSkillTelemetryHookInput(raw: string): SkillTelemetryHookInput | null {
  try {
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SkillTelemetryHookInput) : null;
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
 * Random UUID minted once per agent session and stored in a session-scoped temp
 * file (removed by session-end-cleanup). Lets skill events from one session be
 * grouped without ever sending the harness's own session identifier.
 */
export function resolveTelemetrySessionId(sessionId: string | null): string | undefined {
  if (!sessionId) return undefined;

  if (existsSync(dedupFilePath(sessionId, TELEMETRY_SESSION_ID_KIND))) {
    const existing = readSessionFile(sessionId, TELEMETRY_SESSION_ID_KIND).trim();
    if (isValidTelemetrySessionId(existing)) return existing;
  }

  const minted = randomUUID();
  writeSessionFile(sessionId, TELEMETRY_SESSION_ID_KIND, minted);
  return minted;
}

/**
 * Decide what (if anything) to report for a hook payload. Returns null when
 * telemetry is disabled, the tool is not `Skill`, or the skill is not one
 * shipped by this plugin.
 */
export function buildSkillInvocationPayload(
  input: SkillTelemetryHookInput | null,
  knownSkills: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): SkillInvocationPayload | null {
  if (!input || !isDauTelemetryEnabled(env)) return null;
  if (input.tool_name !== "Skill") return null;

  const toolInput = input.tool_input;
  const rawSkill = toolInput && typeof toolInput === "object"
    ? (toolInput as { skill?: unknown }).skill
    : undefined;

  const skill = normalizeSkillInvocation(rawSkill, knownSkills);
  if (!skill) return null;

  const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
  const telemetrySessionId = resolveTelemetrySessionId(sessionId);

  return telemetrySessionId ? { skill, telemetrySessionId } : { skill };
}

export function parseSendPayload(argv: readonly string[]): SkillInvocationPayload | null {
  const flagIndex = argv.indexOf(SEND_FLAG);
  if (flagIndex === -1) return null;

  try {
    const parsed: unknown = JSON.parse(argv[flagIndex + 1] ?? "");
    if (!parsed || typeof parsed !== "object") return null;
    const { skill, telemetrySessionId } = parsed as Partial<SkillInvocationPayload>;
    if (typeof skill !== "string") return null;
    return isValidTelemetrySessionId(telemetrySessionId)
      ? { skill, telemetrySessionId }
      : { skill };
  } catch {
    return null;
  }
}

function spawnDetachedSender(entrypoint: string, payload: SkillInvocationPayload): void {
  try {
    const child = spawn(process.execPath, [entrypoint, SEND_FLAG, JSON.stringify(payload)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    logCaughtError(log, "skill-telemetry:spawn-failed", error, { skill: payload.skill });
  }
}

async function main(entrypoint: string): Promise<void> {
  const sendPayload = parseSendPayload(process.argv);
  if (sendPayload) {
    await trackSkillInvocation(sendPayload.skill, {
      telemetrySessionId: sendPayload.telemetrySessionId,
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

const SKILL_TELEMETRY_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSkillTelemetryEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === SKILL_TELEMETRY_ENTRYPOINT
  : false;

if (isSkillTelemetryEntrypoint) {
  main(SKILL_TELEMETRY_ENTRYPOINT);
}
