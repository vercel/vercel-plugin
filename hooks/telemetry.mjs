// hooks/src/telemetry.mts
import { randomUUID } from "crypto";
import { mkdirSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
var BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
var FLUSH_TIMEOUT_MS = 3e3;
var PLUGIN_VERSION = "0.41.0";
var DAU_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "dau-stamp");
var FIRST_USE_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "first-use-stamp");
async function sendTelemetry(events) {
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
        "x-vercel-plugin-version": PLUGIN_VERSION
      },
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
function getTelemetryOverride(env = process.env) {
  const value = env.VERCEL_PLUGIN_TELEMETRY?.trim().toLowerCase();
  if (value === "off") return value;
  return null;
}
function isDauTelemetryEnabled(env = process.env) {
  return getTelemetryOverride(env) !== "off";
}
async function trackDauActiveToday(now = /* @__PURE__ */ new Date()) {
  if (!isDauTelemetryEnabled()) return;
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
  const sent = await sendTelemetry(events);
  if (sent) {
    for (const event of events) {
      if (event.key === "dau:active_today") markDauPingSent(now);
      if (event.key === "plugin:first_use") markFirstUsePingSent();
    }
  }
}
export {
  getDauStampPath,
  getFirstUseStampPath,
  getTelemetryOverride,
  isDauTelemetryEnabled,
  markDauPingSent,
  markFirstUsePingSent,
  shouldSendDauPing,
  shouldSendFirstUsePing,
  trackDauActiveToday
};
