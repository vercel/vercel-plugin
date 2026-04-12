import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
const FLUSH_TIMEOUT_MS = 3_000;

const DAU_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "dau-stamp");

export interface TelemetryEvent {
  id: string;
  event_time: number;
  key: string;
  value: string;
}

async function sendDau(events: TelemetryEvent[]): Promise<boolean> {
  if (events.length === 0) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const response = await fetch(BRIDGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-plugin-topic-id": "dau",
      },
      body: JSON.stringify(events),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// DAU stamp — local once-per-day throttle (always-on unless opted out)
// ---------------------------------------------------------------------------

export function getDauStampPath(): string {
  return DAU_STAMP_PATH;
}

function utcDayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function shouldSendDauPing(now: Date = new Date()): boolean {
  try {
    const existingMtime = statSync(DAU_STAMP_PATH).mtime;
    return utcDayStamp(existingMtime) !== utcDayStamp(now);
  } catch {
    return true;
  }
}

export function markDauPingSent(now: Date = new Date()): void {
  void now;
  try {
    mkdirSync(dirname(DAU_STAMP_PATH), { recursive: true });
    writeFileSync(DAU_STAMP_PATH, "", { flag: "w" });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Telemetry controls
// ---------------------------------------------------------------------------

export function getTelemetryOverride(env: NodeJS.ProcessEnv = process.env): "off" | null {
  const value = env.VERCEL_PLUGIN_TELEMETRY?.trim().toLowerCase();
  if (value === "off") return value;
  return null;
}

/**
 * DAU telemetry is enabled by default, but users can disable all telemetry with
 * VERCEL_PLUGIN_TELEMETRY=off.
 */
export function isDauTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getTelemetryOverride(env) !== "off";
}

// ---------------------------------------------------------------------------
// DAU telemetry (default-on, opt-out via VERCEL_PLUGIN_TELEMETRY=off)
// ---------------------------------------------------------------------------

export async function trackDauActiveToday(now: Date = new Date()): Promise<void> {
  if (!isDauTelemetryEnabled() || !shouldSendDauPing(now)) return;

  const eventTime = now.getTime();
  const sent = await sendDau([{
    id: randomUUID(),
    event_time: eventTime,
    key: "dau:active_today",
    value: "1",
  }]);

  if (sent) {
    markDauPingSent(now);
  }
}
