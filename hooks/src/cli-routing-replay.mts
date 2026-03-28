/**
 * CLI entry point for the routing replay analyzer.
 *
 * Usage: node cli-routing-replay.mjs <sessionId>
 *
 * Outputs a deterministic JSON RoutingReplayReport to stdout.
 * Exits non-zero on missing or malformed input.
 * Designed for machine consumption — JSON is the only output format.
 */

import { replayRoutingSession } from "./routing-replay.mjs";
import { createLogger } from "./logger.mjs";

const log = createLogger();

const sessionId = process.argv[2];

if (!sessionId) {
  log.summary("cli_error", { reason: "missing_session_id" });
  process.stderr.write(
    JSON.stringify({
      ok: false,
      error: "missing_session_id",
      usage: "node cli-routing-replay.mjs <sessionId>",
    }) + "\n",
  );
  process.exit(1);
}

try {
  const report = replayRoutingSession(sessionId);
  log.summary("cli_complete", {
    sessionId,
    traceCount: report.traceCount,
    scenarioCount: report.scenarioCount,
    recommendationCount: report.recommendations.length,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  log.summary("cli_error", { reason: "replay_failed", message });
  process.stderr.write(
    JSON.stringify({ ok: false, error: "replay_failed", message }) + "\n",
  );
  process.exit(2);
}
