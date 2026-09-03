import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

declare const __VERCEL_PLUGIN_VERSION__: string;

const BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
const FLUSH_TIMEOUT_MS = 3_000;
export const PLUGIN_VERSION = typeof __VERCEL_PLUGIN_VERSION__ === "string" ? __VERCEL_PLUGIN_VERSION__ : "0.49.0";
const ACTIVE_SESSION_TTL_MS = 60 * 60 * 1000;

const DAU_TOPIC_ID = "dau";
// The bridge routes on this header; "generic" is the topic provisioned for
// non-DAU plugin events.
const SKILL_TOPIC_ID = "generic";
export const SKILL_INVOKED_EVENT_KEY = "skill:invoked";
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  | "other"
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

interface SendTelemetryOptions {
  topicId: string;
  /** Defaults to a fresh random UUID so requests cannot be linked to each other. */
  sessionId?: string;
}

async function sendTelemetry(
  events: TelemetryEvent[],
  options: SendTelemetryOptions = { topicId: DAU_TOPIC_ID },
): Promise<boolean> {
  if (events.length === 0) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-vercel-plugin-topic-id": options.topicId,
      "x-vercel-plugin-session-id": options.sessionId ?? randomUUID(),
      "x-vercel-plugin-version": PLUGIN_VERSION,
    };

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

export function getAgentHarnessStampPath(agentHarness: AgentHarness): string {
  return join(homedir(), ".config", "vercel-plugin", `harness-stamp-${agentHarness}`);
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

  const installationId = randomUUID();
  try {
    mkdirSync(dirname(INSTALLATION_ID_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(INSTALLATION_ID_PATH, `${installationId}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return installationId;
  } catch {
    // Another process may have created the file first — prefer its value.
    const raced = readInstallationId();
    if (raced) return raced;

    // Nothing valid is on disk, so replace the unusable file. Re-read after
    // writing so a concurrent repair adopts the value currently on disk.
    try {
      writeFileSync(INSTALLATION_ID_PATH, `${installationId}\n`, {
        flag: "w",
        mode: 0o600,
      });
      return readInstallationId();
    } catch {
      // A concurrent repair may still have succeeded. Never send an
      // identifier that cannot be confirmed on disk.
      return readInstallationId();
    }
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

export function shouldSendAgentHarnessPing(
  agentHarness: AgentHarness,
  now: Date = new Date(),
): boolean {
  try {
    const existingMtime = statSync(getAgentHarnessStampPath(agentHarness)).mtime;
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

export function markFirstUsePingSent(): void {
  try {
    mkdirSync(dirname(FIRST_USE_STAMP_PATH), { recursive: true });
    writeFileSync(FIRST_USE_STAMP_PATH, "", { flag: "w" });
  } catch {
    // Best-effort
  }
}

export function markAgentHarnessPingSent(agentHarness: AgentHarness): void {
  const stampPath = getAgentHarnessStampPath(agentHarness);
  try {
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, "", { flag: "w" });
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
  const shouldSendAgentHarness = shouldSendAgentHarnessPing(agentHarness, now);
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

  if (events.length > 0 || shouldSendAgentHarness) {
    events.push({
      id: randomUUID(),
      event_time: eventTime,
      key: "plugin:version",
      value: PLUGIN_VERSION,
    });
    if (installationId) {
      events.push({
        id: randomUUID(),
        event_time: eventTime,
        key: "plugin:install_id",
        value: installationId,
      });
    }
    if (shouldSendAgentHarness) {
      events.push({
        id: randomUUID(),
        event_time: eventTime,
        key: "plugin:agent_harness",
        value: agentHarness,
      });
    }
  }

  const sent = await sendTelemetry(events);

  if (sent) {
    for (const event of events) {
      if (event.key === "dau:active_today") markDauPingSent(now);
      if (event.key === "plugin:first_use") markFirstUsePingSent();
      if (event.key === "plugin:agent_harness") markAgentHarnessPingSent(agentHarness);
    }
  }
}

// ---------------------------------------------------------------------------
// Skill invocation telemetry (default-on, opt-out via VERCEL_PLUGIN_TELEMETRY=off)
// ---------------------------------------------------------------------------

/**
 * Reduce a Skill tool input (e.g. "vercel:nextjs", "/vercel-plugin:deploy",
 * "nextjs") to a bare plugin skill slug. Returns null unless the slug is one of
 * the skills or commands shipped by this plugin, so third-party skill names and
 * arbitrary strings are never sent.
 */
export function normalizeSkillInvocation(
  rawSkill: unknown,
  knownSkills: ReadonlySet<string>,
): string | null {
  if (typeof rawSkill !== "string") return null;

  const trimmed = rawSkill.trim().replace(/^\/+/, "");
  if (!trimmed) return null;

  const slug = trimmed.slice(trimmed.lastIndexOf(":") + 1).toLowerCase();
  if (!SKILL_SLUG_RE.test(slug)) return null;

  return knownSkills.has(slug) ? slug : null;
}

export function isValidTelemetrySessionId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

export function buildSkillInvocationEvents(
  skill: string,
  now: Date = new Date(),
  installationId: string | null = readInstallationId(),
): TelemetryEvent[] {
  const eventTime = now.getTime();
  const events: TelemetryEvent[] = [
    {
      id: randomUUID(),
      event_time: eventTime,
      key: SKILL_INVOKED_EVENT_KEY,
      value: skill,
    },
    {
      id: randomUUID(),
      event_time: eventTime,
      key: "plugin:version",
      value: PLUGIN_VERSION,
    },
  ];

  if (installationId) {
    events.push({
      id: randomUUID(),
      event_time: eventTime,
      key: "plugin:install_id",
      value: installationId,
    });
  }

  return events;
}

export interface SkillInvocationContext {
  /**
   * Plugin-generated random UUID shared by every skill event in one agent
   * session. Never the harness's own session identifier.
   */
  telemetrySessionId?: string;
}

export async function trackSkillInvocation(
  skill: string,
  context: SkillInvocationContext = {},
  now: Date = new Date(),
): Promise<boolean> {
  if (!isDauTelemetryEnabled()) return false;

  const events = buildSkillInvocationEvents(skill, now, getOrCreateInstallationId());
  return sendTelemetry(events, {
    topicId: SKILL_TOPIC_ID,
    sessionId: isValidTelemetrySessionId(context.telemetrySessionId)
      ? context.telemetrySessionId
      : undefined,
  });
}
