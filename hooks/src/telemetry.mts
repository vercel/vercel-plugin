import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

declare const __VERCEL_PLUGIN_VERSION__: string;

const BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
const FLUSH_TIMEOUT_MS = 3_000;
export const PLUGIN_VERSION = typeof __VERCEL_PLUGIN_VERSION__ === "string" ? __VERCEL_PLUGIN_VERSION__ : "0.48.0";
const ACTIVE_SESSION_TTL_MS = 60 * 60 * 1000;

const DAU_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "dau-stamp");
const FIRST_USE_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "first-use-stamp");
const INSTALLATION_ID_PATH = join(homedir(), ".config", "vercel-plugin", "installation-id");
const ACTIVE_SESSION_MARKER_PATH = join(homedir(), ".config", "vercel-plugin", "active-session.json");

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AgentHarness =
  | "claude-code"
  | "cursor"
  | "codex"
  | "github-copilot"
  | "kimi"
  | "grok"
  | "unknown";

export interface TelemetryContext {
  agentHarness?: AgentHarness;
}

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

async function sendTelemetry(
  events: TelemetryEvent[],
  installationId: string | null,
  agentHarness: AgentHarness,
): Promise<boolean> {
  if (events.length === 0) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-vercel-plugin-topic-id": "dau",
      "x-vercel-plugin-session-id": randomUUID(),
      "x-vercel-plugin-version": PLUGIN_VERSION,
      "x-vercel-plugin-agent-harness": agentHarness,
    };
    if (installationId) {
      headers["x-vercel-plugin-installation-id"] = installationId;
    }

    const response = await fetch(BRIDGE_ENDPOINT, {
      method: "POST",
      headers,
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

export function getInstallationIdPath(): string {
  return INSTALLATION_ID_PATH;
}

export function getActiveSessionMarkerPath(): string {
  return ACTIVE_SESSION_MARKER_PATH;
}

function readInstallationId(): string | null {
  try {
    const value = readFileSync(INSTALLATION_ID_PATH, "utf8").trim();
    return UUID_V4_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

function getOrCreateInstallationId(): string | null {
  const existing = readInstallationId();
  if (existing) return existing;

  try {
    mkdirSync(dirname(INSTALLATION_ID_PATH), { recursive: true, mode: 0o700 });
    const installationId = randomUUID();
    writeFileSync(INSTALLATION_ID_PATH, `${installationId}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return installationId;
  } catch {
    // Another process may have created the file first. Never send an
    // ephemeral identifier when a stable value cannot be read from disk.
    return readInstallationId();
  }
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

export async function trackDauActiveToday(
  now: Date = new Date(),
  context: TelemetryContext = {},
): Promise<void> {
  if (!isDauTelemetryEnabled()) return;

  const installationId = getOrCreateInstallationId();
  const agentHarness = context.agentHarness ?? "unknown";
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

  const sent = await sendTelemetry(events, installationId, agentHarness);

  if (sent) {
    for (const event of events) {
      if (event.key === "dau:active_today") markDauPingSent(now);
      if (event.key === "plugin:first_use") markFirstUsePingSent();
    }
  }
}
