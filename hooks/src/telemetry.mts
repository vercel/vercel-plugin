import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

declare const __VERCEL_PLUGIN_VERSION__: string;

const BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
const FLUSH_TIMEOUT_MS = 3_000;
export const PLUGIN_VERSION = __VERCEL_PLUGIN_VERSION__;
const ACTIVE_SESSION_TTL_MS = 60 * 60 * 1000;

const DAU_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "dau-stamp");
const FIRST_USE_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "first-use-stamp");
const ACTIVE_SESSION_MARKER_PATH = join(homedir(), ".config", "vercel-plugin", "active-session.json");

export interface TelemetryEvent {
  id: string;
  event_time: number;
  key: string;
  value: string;
}

export interface ActiveSessionMarker {
  schema: 1;
  active: true;
  pluginVersion: string;
  updatedAt: number;
  expiresAt: number;
}

async function sendTelemetry(events: TelemetryEvent[]): Promise<boolean> {
  if (events.length === 0) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const response = await fetch(BRIDGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-plugin-topic-id": "dau",
        "x-vercel-plugin-session-id": randomUUID(),
        "x-vercel-plugin-version": PLUGIN_VERSION,
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

export function getFirstUseStampPath(): string {
  return FIRST_USE_STAMP_PATH;
}

export function getActiveSessionMarkerPath(): string {
  return ACTIVE_SESSION_MARKER_PATH;
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

export function shouldSendFirstUsePing(): boolean {
  try {
    statSync(FIRST_USE_STAMP_PATH);
    return false;
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

export function markFirstUsePingSent(): void {
  try {
    mkdirSync(dirname(FIRST_USE_STAMP_PATH), { recursive: true });
    writeFileSync(FIRST_USE_STAMP_PATH, "", { flag: "w" });
  } catch {
    // Best-effort
  }
}

export function removeActiveSessionMarker(): void {
  try {
    rmSync(ACTIVE_SESSION_MARKER_PATH, { force: true });
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
 * Plugin telemetry is enabled by default, but users can disable all telemetry
 * with VERCEL_PLUGIN_TELEMETRY=off.
 */
export function isDauTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getTelemetryOverride(env) !== "off";
}

export function refreshActiveSessionMarker(now: Date = new Date()): void {
  if (!isDauTelemetryEnabled()) {
    removeActiveSessionMarker();
    return;
  }

  const updatedAt = now.getTime();
  const marker: ActiveSessionMarker = {
    schema: 1,
    active: true,
    pluginVersion: PLUGIN_VERSION,
    updatedAt,
    expiresAt: updatedAt + ACTIVE_SESSION_TTL_MS,
  };

  try {
    mkdirSync(dirname(ACTIVE_SESSION_MARKER_PATH), { recursive: true });
    writeFileSync(ACTIVE_SESSION_MARKER_PATH, `${JSON.stringify(marker)}\n`, { flag: "w" });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// DAU telemetry (default-on, opt-out via VERCEL_PLUGIN_TELEMETRY=off)
// ---------------------------------------------------------------------------

export async function trackDauActiveToday(now: Date = new Date()): Promise<void> {
  if (!isDauTelemetryEnabled()) return;

  const eventTime = now.getTime();
  const events: TelemetryEvent[] = [];

  if (shouldSendDauPing(now)) {
    events.push({
      id: randomUUID(),
      event_time: eventTime,
      key: "dau:active_today",
      value: "1",
    });
  }

  if (shouldSendFirstUsePing()) {
    events.push({
      id: randomUUID(),
      event_time: eventTime,
      key: "plugin:first_use",
      value: "1",
    });
  }

  if (events.length > 0) {
    events.push({
      id: randomUUID(),
      event_time: eventTime,
      key: "plugin:version",
      value: PLUGIN_VERSION,
    });
  }

  const sent = await sendTelemetry(events);

  if (sent) {
    for (const event of events) {
      if (event.key === "dau:active_today") markDauPingSent(now);
      if (event.key === "plugin:first_use") markFirstUsePingSent();
    }
  }
}
