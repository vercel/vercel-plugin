import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const MAX_VALUE_BYTES = 100_000;
const TRUNCATION_SUFFIX = "[TRUNCATED]";

const BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
const FLUSH_TIMEOUT_MS = 3_000;

const DEVICE_ID_PATH = join(homedir(), ".claude", "vercel-plugin-device-id");

export interface TelemetryEvent {
  id: string;
  event_time: number;
  key: string;
  value: string;
}

function truncateValue(value: string): string {
  if (Buffer.byteLength(value, "utf-8") <= MAX_VALUE_BYTES) {
    return value;
  }
  const truncated = Buffer.from(value, "utf-8").subarray(0, MAX_VALUE_BYTES).toString("utf-8");
  return truncated + TRUNCATION_SUFFIX;
}

async function send(sessionId: string, events: TelemetryEvent[]): Promise<void> {
  if (events.length === 0) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    await fetch(BRIDGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-plugin-session-id": sessionId,
        "x-vercel-plugin-topic-id": "generic",
      },
      body: JSON.stringify(events),
      signal: controller.signal,
    });
  } catch {
    // Best-effort
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Device ID — stable anonymous identifier per machine (always-on)
// ---------------------------------------------------------------------------

/**
 * Returns a stable anonymous device ID. Creates one on first call.
 * The ID is a random UUID stored at ~/.claude/vercel-plugin-device-id
 * and is not tied to any user account or PII.
 */
export function getOrCreateDeviceId(): string {
  try {
    const existing = readFileSync(DEVICE_ID_PATH, "utf-8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // File doesn't exist yet
  }

  const deviceId = randomUUID();
  try {
    mkdirSync(dirname(DEVICE_ID_PATH), { recursive: true });
    writeFileSync(DEVICE_ID_PATH, deviceId);
  } catch {
    // Best-effort — return the generated ID even if we can't persist it
  }
  return deviceId;
}

// ---------------------------------------------------------------------------
// Telemetry tiers
// ---------------------------------------------------------------------------

/**
 * Content-level telemetry (opt-in): requires explicit user consent.
 * Currently gates prompt:text only.
 */
export function getTelemetryOverride(env: NodeJS.ProcessEnv = process.env): "off" | null {
  const value = env.VERCEL_PLUGIN_TELEMETRY?.trim().toLowerCase();
  if (value === "off") return value;
  return null;
}

/**
 * Base telemetry is enabled by default, but users can disable all telemetry
 * with VERCEL_PLUGIN_TELEMETRY=off.
 */
export function isBaseTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getTelemetryOverride(env) !== "off";
}

/**
 * Content-level telemetry (opt-in): requires explicit user consent.
 * VERCEL_PLUGIN_TELEMETRY=off disables it entirely.
 */
export function isContentTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = getTelemetryOverride(env);
  if (override === "off") return false;

  try {
    const prefPath = join(homedir(), ".claude", "vercel-plugin-telemetry-preference");
    const pref = readFileSync(prefPath, "utf-8").trim();
    return pref === "enabled";
  } catch {
    return false;
  }
}

/**
 * Backward-compatible alias for older callers that still refer to prompt telemetry.
 */
export function isPromptTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isContentTelemetryEnabled(env);
}

// ---------------------------------------------------------------------------
// Always-on base telemetry (session, tool, skill injection events)
// ---------------------------------------------------------------------------

export async function trackBaseEvent(sessionId: string, key: string, value: string): Promise<void> {
  if (!isBaseTelemetryEnabled()) return;

  const event: TelemetryEvent = {
    id: randomUUID(),
    event_time: Date.now(),
    key,
    value: truncateValue(value),
  };

  await send(sessionId, [event]);
}

export async function trackBaseEvents(
  sessionId: string,
  entries: Array<{ key: string; value: string }>,
): Promise<void> {
  if (!isBaseTelemetryEnabled() || entries.length === 0) return;

  const now = Date.now();
  const events: TelemetryEvent[] = entries.map((entry) => ({
    id: randomUUID(),
    event_time: now,
    key: entry.key,
    value: truncateValue(entry.value),
  }));

  await send(sessionId, events);
}

// ---------------------------------------------------------------------------
// Opt-in telemetry (raw prompt content)
// ---------------------------------------------------------------------------

export async function trackContentEvent(sessionId: string, key: string, value: string): Promise<void> {
  if (!isContentTelemetryEnabled()) return;

  const event: TelemetryEvent = {
    id: randomUUID(),
    event_time: Date.now(),
    key,
    value: truncateValue(value),
  };

  await send(sessionId, [event]);
}

export async function trackContentEvents(
  sessionId: string,
  entries: Array<{ key: string; value: string }>,
): Promise<void> {
  if (!isContentTelemetryEnabled() || entries.length === 0) return;

  const now = Date.now();
  const events: TelemetryEvent[] = entries.map((entry) => ({
    id: randomUUID(),
    event_time: now,
    key: entry.key,
    value: truncateValue(entry.value),
  }));

  await send(sessionId, events);
}

/**
 * Backward-compatible aliases for older callers that still refer to prompt telemetry.
 */
export async function trackEvent(sessionId: string, key: string, value: string): Promise<void> {
  await trackContentEvent(sessionId, key, value);
}

export async function trackEvents(
  sessionId: string,
  entries: Array<{ key: string; value: string }>,
): Promise<void> {
  await trackContentEvents(sessionId, entries);
}
