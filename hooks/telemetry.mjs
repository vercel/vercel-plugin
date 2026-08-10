// hooks/src/telemetry.mts
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
var BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
var FLUSH_TIMEOUT_MS = 3e3;
var PLUGIN_VERSION = true ? "0.47.0" : "0.43.0";
var ACTIVE_SESSION_TTL_MS = 60 * 60 * 1e3;
var DAU_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "dau-stamp");
var FIRST_USE_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "first-use-stamp");
var INSTALLATION_ID_PATH = join(homedir(), ".config", "vercel-plugin", "installation-id");
var ACTIVE_SESSION_MARKER_PATH = join(homedir(), ".config", "vercel-plugin", "active-session.json");
var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function sendTelemetry(events, installationId, agentHarness) {
  if (events.length === 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const headers = {
      "Content-Type": "application/json",
      "x-vercel-plugin-topic-id": "dau",
      "x-vercel-plugin-session-id": randomUUID(),
      "x-vercel-plugin-version": PLUGIN_VERSION,
      "x-vercel-plugin-agent-harness": agentHarness
    };
    if (installationId) {
      headers["x-vercel-plugin-installation-id"] = installationId;
    }
    const response = await fetch(BRIDGE_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(events),
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
function getDauStampPath() {
  return DAU_STAMP_PATH;
}
function getFirstUseStampPath() {
  return FIRST_USE_STAMP_PATH;
}
function getInstallationIdPath() {
  return INSTALLATION_ID_PATH;
}
function getActiveSessionMarkerPath() {
  return ACTIVE_SESSION_MARKER_PATH;
}
function readInstallationId() {
  try {
    const value = readFileSync(INSTALLATION_ID_PATH, "utf8").trim();
    return UUID_V4_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}
function getOrCreateInstallationId() {
  const existing = readInstallationId();
  if (existing) return existing;
  try {
    mkdirSync(dirname(INSTALLATION_ID_PATH), { recursive: true, mode: 448 });
    const installationId = randomUUID();
    writeFileSync(INSTALLATION_ID_PATH, `${installationId}
`, {
      flag: "wx",
      mode: 384
    });
    return installationId;
  } catch {
    return readInstallationId();
  }
}
function utcDayStamp(date) {
  return date.toISOString().slice(0, 10);
}
function shouldSendDauPing(now = /* @__PURE__ */ new Date()) {
  try {
    const existingMtime = statSync(DAU_STAMP_PATH).mtime;
    return utcDayStamp(existingMtime) !== utcDayStamp(now);
  } catch {
    return true;
  }
}
function shouldSendFirstUsePing() {
  try {
    statSync(FIRST_USE_STAMP_PATH);
    return false;
  } catch {
    return true;
  }
}
function markDauPingSent(now = /* @__PURE__ */ new Date()) {
  void now;
  try {
    mkdirSync(dirname(DAU_STAMP_PATH), { recursive: true });
    writeFileSync(DAU_STAMP_PATH, "", { flag: "w" });
  } catch {
  }
}
function markFirstUsePingSent() {
  try {
    mkdirSync(dirname(FIRST_USE_STAMP_PATH), { recursive: true });
    writeFileSync(FIRST_USE_STAMP_PATH, "", { flag: "w" });
  } catch {
  }
}
function removeActiveSessionMarker() {
  try {
    rmSync(ACTIVE_SESSION_MARKER_PATH, { force: true });
  } catch {
  }
}
function getTelemetryOverride(env = process.env) {
  const value = env.VERCEL_PLUGIN_TELEMETRY?.trim().toLowerCase();
  if (value === "off") return value;
  return null;
}
function isDauTelemetryEnabled(env = process.env) {
  return getTelemetryOverride(env) !== "off";
}
function refreshActiveSessionMarker(now = /* @__PURE__ */ new Date()) {
  if (!isDauTelemetryEnabled()) {
    removeActiveSessionMarker();
    return;
  }
  const updatedAt = now.getTime();
  const marker = {
    schema: 1,
    active: true,
    pluginVersion: PLUGIN_VERSION,
    updatedAt,
    expiresAt: updatedAt + ACTIVE_SESSION_TTL_MS
  };
  try {
    mkdirSync(dirname(ACTIVE_SESSION_MARKER_PATH), { recursive: true });
    writeFileSync(ACTIVE_SESSION_MARKER_PATH, `${JSON.stringify(marker)}
`, { flag: "w" });
  } catch {
  }
}
async function trackDauActiveToday(now = /* @__PURE__ */ new Date(), context = {}) {
  if (!isDauTelemetryEnabled()) return;
  const installationId = getOrCreateInstallationId();
  const agentHarness = context.agentHarness ?? "unknown";
  const eventTime = now.getTime();
  const events = [];
  if (shouldSendDauPing(now)) {
    events.push({
      id: randomUUID(),
      event_time: eventTime,
      key: "dau:active_today",
      value: "1"
    });
  }
  if (shouldSendFirstUsePing()) {
    events.push({
      id: randomUUID(),
      event_time: eventTime,
      key: "plugin:first_use",
      value: "1"
    });
  }
  if (events.length > 0) {
    events.push({
      id: randomUUID(),
      event_time: eventTime,
      key: "plugin:version",
      value: PLUGIN_VERSION
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
export {
  PLUGIN_VERSION,
  getActiveSessionMarkerPath,
  getDauStampPath,
  getFirstUseStampPath,
  getInstallationIdPath,
  getTelemetryOverride,
  isDauTelemetryEnabled,
  markDauPingSent,
  markFirstUsePingSent,
  refreshActiveSessionMarker,
  removeActiveSessionMarker,
  shouldSendDauPing,
  shouldSendFirstUsePing,
  trackDauActiveToday
};
