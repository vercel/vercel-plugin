#!/usr/bin/env node

// hooks/src/setup-telemetry.mts
import { getTelemetryOverride } from "./telemetry.mjs";
function main() {
  const telemetryOverride = getTelemetryOverride();
  if (telemetryOverride === "off") {
    process.stdout.write("Telemetry is fully disabled via VERCEL_PLUGIN_TELEMETRY=off.\n");
    process.exit(0);
  }
  process.stdout.write(
    [
      "The default telemetry profile sends a once-per-day DAU phone-home (dau:active_today) and the name of each vercel-plugin skill loaded via the Skill tool (skill:invoked). Skill arguments and non-plugin skill names are never sent.",
      "To disable all telemetry, set VERCEL_PLUGIN_TELEMETRY=off.",
      ""
    ].join("\n")
  );
  process.exit(0);
}
main();
