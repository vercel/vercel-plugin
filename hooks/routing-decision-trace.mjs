// hooks/src/routing-decision-trace.mts
import {
  appendFileSync,
  mkdirSync,
  readFileSync
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
var SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function safeSessionSegment(sessionId) {
  if (!sessionId) return "no-session";
  if (SAFE_SESSION_ID_RE.test(sessionId)) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}
function normalizeTrace(raw) {
  if (raw.version === 2) {
    const trace = raw;
    return {
      ...trace,
      causes: trace.causes ?? [],
      edges: trace.edges ?? []
    };
  }
  const v1 = raw;
  return {
    ...v1,
    version: 2,
    primaryStory: {
      id: v1.primaryStory.id,
      kind: v1.primaryStory.kind,
      storyRoute: v1.primaryStory.route,
      targetBoundary: v1.primaryStory.targetBoundary
    },
    observedRoute: v1.primaryStory.route,
    // best-effort: v1 conflated the two
    causes: [],
    edges: []
  };
}
function traceDir(sessionId) {
  return join(
    tmpdir(),
    `vercel-plugin-${safeSessionSegment(sessionId)}-trace`
  );
}
function tracePath(sessionId) {
  return join(traceDir(sessionId), "routing-decision-trace.jsonl");
}
function createDecisionId(input) {
  const timestamp = input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
  return createHash("sha256").update(
    [
      input.hook,
      input.sessionId ?? "",
      input.toolName,
      input.toolTarget,
      timestamp
    ].join("|")
  ).digest("hex").slice(0, 16);
}
function appendRoutingDecisionTrace(trace) {
  mkdirSync(traceDir(trace.sessionId), { recursive: true });
  appendFileSync(
    tracePath(trace.sessionId),
    JSON.stringify(trace) + "\n",
    "utf8"
  );
}
function readRoutingDecisionTrace(sessionId) {
  try {
    const content = readFileSync(tracePath(sessionId), "utf8");
    return content.split("\n").filter((line) => line.trim() !== "").map((line) => normalizeTrace(JSON.parse(line)));
  } catch {
    return [];
  }
}
export {
  appendRoutingDecisionTrace,
  createDecisionId,
  readRoutingDecisionTrace,
  traceDir,
  tracePath
};
