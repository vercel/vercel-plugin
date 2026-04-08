// hooks/src/telemetry.mts
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
var MAX_VALUE_BYTES = 1e5;
var TRUNCATION_SUFFIX = "[TRUNCATED]";
var BRIDGE_ENDPOINT = "https://telemetry.vercel.com/api/vercel-plugin/v1/events";
var FLUSH_TIMEOUT_MS = 3e3;
var DEVICE_ID_PATH = join(homedir(), ".claude", "vercel-plugin-device-id");
function truncateValue(value) {
  if (Buffer.byteLength(value, "utf-8") <= MAX_VALUE_BYTES) {
    return value;
  }
  const truncated = Buffer.from(value, "utf-8").subarray(0, MAX_VALUE_BYTES).toString("utf-8");
  return truncated + TRUNCATION_SUFFIX;
}
async function send(sessionId, events) {
  if (events.length === 0) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    await fetch(BRIDGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-plugin-session-id": sessionId,
        "x-vercel-plugin-topic-id": "generic"
      },
      body: JSON.stringify(events),
      signal: controller.signal
    });
  } catch {
  } finally {
    clearTimeout(timeout);
  }
}
function getOrCreateDeviceId() {
  try {
    const existing = readFileSync(DEVICE_ID_PATH, "utf-8").trim();
    if (existing.length > 0) return existing;
  } catch {
  }
  const deviceId = randomUUID();
  try {
    mkdirSync(dirname(DEVICE_ID_PATH), { recursive: true });
    writeFileSync(DEVICE_ID_PATH, deviceId);
  } catch {
  }
  return deviceId;
}
function getTelemetryOverride(env = process.env) {
  const value = env.VERCEL_PLUGIN_TELEMETRY?.trim().toLowerCase();
  if (value === "off") return value;
  return null;
}
function isBaseTelemetryEnabled(env = process.env) {
  return getTelemetryOverride(env) !== "off";
}
function isPromptTelemetryEnabled(env = process.env) {
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
async function trackBaseEvent(sessionId, key, value) {
  if (!isBaseTelemetryEnabled()) return;
  const event = {
    id: randomUUID(),
    event_time: Date.now(),
    key,
    value: truncateValue(value)
  };
  await send(sessionId, [event]);
}
async function trackBaseEvents(sessionId, entries) {
  if (!isBaseTelemetryEnabled() || entries.length === 0) return;
  const now = Date.now();
  const events = entries.map((entry) => ({
    id: randomUUID(),
    event_time: now,
    key: entry.key,
    value: truncateValue(entry.value)
  }));
  await send(sessionId, events);
}
async function trackEvent(sessionId, key, value) {
  if (!isPromptTelemetryEnabled()) return;
  const event = {
    id: randomUUID(),
    event_time: Date.now(),
    key,
    value: truncateValue(value)
  };
  await send(sessionId, [event]);
}
async function trackEvents(sessionId, entries) {
  if (!isPromptTelemetryEnabled() || entries.length === 0) return;
  const now = Date.now();
  const events = entries.map((entry) => ({
    id: randomUUID(),
    event_time: now,
    key: entry.key,
    value: truncateValue(entry.value)
  }));
  await send(sessionId, events);
}
export {
  getOrCreateDeviceId,
  getTelemetryOverride,
  isBaseTelemetryEnabled,
  isPromptTelemetryEnabled,
  trackBaseEvent,
  trackBaseEvents,
  trackEvent,
  trackEvents
};
