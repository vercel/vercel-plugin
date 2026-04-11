// hooks/src/telemetry.mts
import { randomUUID } from "crypto";
import { mkdirSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
var BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
var FLUSH_TIMEOUT_MS = 3e3;
var DAU_STAMP_PATH = join(homedir(), ".config", "vercel-plugin", "dau-stamp");
async function sendDau(events) {
  if (events.length === 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const response = await fetch(BRIDGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-plugin-topic-id": "dau"
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
function markDauPingSent(now = /* @__PURE__ */ new Date()) {
  void now;
  try {
    mkdirSync(dirname(DAU_STAMP_PATH), { recursive: true });
    writeFileSync(DAU_STAMP_PATH, "", { flag: "w" });
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
  if (!isDauTelemetryEnabled() || !shouldSendDauPing(now)) return;
  const eventTime = now.getTime();
  const sent = await sendDau([{
    id: randomUUID(),
    event_time: eventTime,
    key: "dau:active_today",
    value: "1"
  }]);
  if (sent) {
    markDauPingSent(now);
  }
}
export {
  getDauStampPath,
  getTelemetryOverride,
  isDauTelemetryEnabled,
  markDauPingSent,
  shouldSendDauPing,
  trackDauActiveToday
};
