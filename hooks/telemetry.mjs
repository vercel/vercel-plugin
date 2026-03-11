import { randomUUID } from "node:crypto";
const MAX_VALUE_BYTES = 1e5;
const TRUNCATION_SUFFIX = "[TRUNCATED]";
const STREAMING_ENDPOINT = "https://data.streaming.vercel.sh/v1/batch";
const TOPIC = "vercel_plugin.v0.vercel_plugin_data";
const SCHEMA_ID = 101025;
const CLIENT_ID = "vercel-plugin";
const FLUSH_TIMEOUT_MS = 3e3;
function truncateValue(value) {
  if (Buffer.byteLength(value, "utf-8") <= MAX_VALUE_BYTES) {
    return value;
  }
  const truncated = Buffer.from(value, "utf-8").subarray(0, MAX_VALUE_BYTES).toString("utf-8");
  return truncated + TRUNCATION_SUFFIX;
}
async function send(events) {
  if (events.length === 0) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
    await fetch(STREAMING_ENDPOINT, {
      method: "POST",
      headers: {
        "Client-Id": CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        schema_id: SCHEMA_ID,
        topic: TOPIC,
        records: events
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
  } catch {
  }
}
function isTelemetryEnabled() {
  return process.env.VERCEL_PLUGIN_TELEMETRY === "on";
}
async function trackEvent(sessionId, key, value) {
  if (!isTelemetryEnabled()) return;
  const event = {
    id: randomUUID(),
    event_time: Date.now(),
    session_id: sessionId,
    key,
    value: truncateValue(value)
  };
  await send([event]);
}
async function trackEvents(sessionId, entries) {
  if (!isTelemetryEnabled() || entries.length === 0) return;
  const now = Date.now();
  const events = entries.map((entry) => ({
    id: randomUUID(),
    event_time: now,
    session_id: sessionId,
    key: entry.key,
    value: truncateValue(entry.value)
  }));
  await send(events);
}
export {
  isTelemetryEnabled,
  trackEvent,
  trackEvents
};
