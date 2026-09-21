/**
 * Shared plumbing for skill telemetry (`skill:invoked`, `skill:injected`).
 *
 * Hooks call `queueSkillTelemetry()`, which validates, attaches the
 * plugin-minted session UUID and the harness detected at session start, and
 * hands the batch to a detached `posttooluse-skill-telemetry.mjs --send`
 * process so the calling hook never waits on the network.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupFilePath, readSessionFile, writeSessionFile } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  isAgentHarness,
  isDauTelemetryEnabled,
  isSkillTelemetryKey,
  isValidTelemetrySessionId,
  type AgentHarness,
  type SkillTelemetryKey,
} from "./telemetry.mjs";

const log = createLogger();

export const SEND_FLAG = "--send";
const TELEMETRY_SESSION_ID_KIND = "telemetry-session-id";
const AGENT_HARNESS_KIND = "agent-harness";
const SENDER_BASENAME = "posttooluse-skill-telemetry.mjs";

export interface SkillTelemetryPayload {
  key: SkillTelemetryKey;
  skills: string[];
  telemetrySessionId?: string;
  agentHarness?: AgentHarness;
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

/** Written by the session-start profiler so later hooks can tag events. */
export function writeSessionAgentHarness(sessionId: string, agentHarness: AgentHarness): void {
  writeSessionFile(sessionId, AGENT_HARNESS_KIND, agentHarness);
}

export function readSessionAgentHarness(sessionId: string | null): AgentHarness | undefined {
  if (!sessionId) return undefined;
  if (!existsSync(dedupFilePath(sessionId, AGENT_HARNESS_KIND))) return undefined;

  const value = readSessionFile(sessionId, AGENT_HARNESS_KIND).trim();
  return isAgentHarness(value) ? value : undefined;
}

/**
 * Assemble the payload for a batch of plugin skill slugs. Returns null when
 * telemetry is disabled or there is nothing to report. Callers are responsible
 * for having already reduced skills to plugin-shipped slugs.
 */
export function buildSkillTelemetryPayload(
  key: SkillTelemetryKey,
  skills: readonly string[],
  sessionId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): SkillTelemetryPayload | null {
  if (!isDauTelemetryEnabled(env)) return null;

  const uniqueSkills = [...new Set(skills)];
  if (uniqueSkills.length === 0) return null;

  const payload: SkillTelemetryPayload = { key, skills: uniqueSkills };

  const telemetrySessionId = resolveTelemetrySessionId(sessionId);
  if (telemetrySessionId) payload.telemetrySessionId = telemetrySessionId;

  const agentHarness = readSessionAgentHarness(sessionId);
  if (agentHarness) payload.agentHarness = agentHarness;

  return payload;
}

export function parseSendPayload(argv: readonly string[]): SkillTelemetryPayload | null {
  const flagIndex = argv.indexOf(SEND_FLAG);
  if (flagIndex === -1) return null;

  try {
    const parsed: unknown = JSON.parse(argv[flagIndex + 1] ?? "");
    if (!parsed || typeof parsed !== "object") return null;

    const { key, skills, telemetrySessionId, agentHarness } = parsed as Partial<SkillTelemetryPayload>;
    if (!isSkillTelemetryKey(key)) return null;
    if (!Array.isArray(skills)) return null;

    const validSkills = skills.filter((skill): skill is string => typeof skill === "string" && skill.length > 0);
    if (validSkills.length === 0) return null;

    const payload: SkillTelemetryPayload = { key, skills: validSkills };
    if (isValidTelemetrySessionId(telemetrySessionId)) payload.telemetrySessionId = telemetrySessionId;
    if (isAgentHarness(agentHarness)) payload.agentHarness = agentHarness;
    return payload;
  } catch {
    return null;
  }
}

function senderEntrypoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), SENDER_BASENAME);
}

export function spawnDetachedSkillTelemetrySender(
  payload: SkillTelemetryPayload,
  entrypoint: string = senderEntrypoint(),
): boolean {
  try {
    const child = spawn(process.execPath, [entrypoint, SEND_FLAG, JSON.stringify(payload)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (error) {
    logCaughtError(log, "skill-telemetry:spawn-failed", error, { key: payload.key, skills: payload.skills });
    return false;
  }
}

/**
 * Fire-and-forget entry point for hooks: build the payload and hand it to the
 * detached sender. Never throws.
 */
export function queueSkillTelemetry(
  key: SkillTelemetryKey,
  skills: readonly string[],
  sessionId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): SkillTelemetryPayload | null {
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
