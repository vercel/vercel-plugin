import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_VALUE_BYTES = 100_000;
const TRUNCATION_SUFFIX = "[TRUNCATED]";

const BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
const FLUSH_TIMEOUT_MS = 3_000;

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

export function isTelemetryEnabled(): boolean {
  if (process.env.VERCEL_PLUGIN_TELEMETRY === "on") return true;

  // Fallback: read the preference file directly in case the env var
  // wasn't propagated to this process (new session, env file not sourced yet)
  try {
    const prefPath = join(homedir(), ".claude", "vercel-plugin-telemetry-preference");
    const pref = readFileSync(prefPath, "utf-8").trim();
    return pref === "enabled";
  } catch {
    return false;
  }
}

export async function trackEvent(sessionId: string, key: string, value: string): Promise<void> {
  if (!isTelemetryEnabled()) return;

  const event: TelemetryEvent = {
    id: randomUUID(),
    event_time: Date.now(),
    key,
    value: truncateValue(value),
  };

  await send(sessionId, [event]);
}

export async function trackEvents(
  sessionId: string,
  entries: Array<{ key: string; value: string }>,
): Promise<void> {
  if (!isTelemetryEnabled() || entries.length === 0) return;

  const now = Date.now();
  const events: TelemetryEvent[] = entries.map((entry) => ({
    id: randomUUID(),
    event_time: now,
    key: entry.key,
    value: truncateValue(entry.value),
  }));

  await send(sessionId, events);
}
