#!/usr/bin/env node

import { getTelemetryOverride } from "./telemetry.mjs";

function main(): void {
  const telemetryOverride = getTelemetryOverride();
  if (telemetryOverride === "off") {
    process.stdout.write(
      "Telemetry is fully disabled via VERCEL_PLUGIN_TELEMETRY=off.\nPrompt text telemetry is currently disabled in the plugin, so there is no separate prompt-sharing preference to change.\n",
    );
    process.exit(0);
  }

  process.stdout.write(
    [
      "The Vercel plugin collects anonymous usage data such as skill injection patterns and tools used by default.",
      "Prompt text telemetry is currently disabled in the plugin, so there is no consent prompt to show.",
      "To disable all telemetry, set VERCEL_PLUGIN_TELEMETRY=off in the environment that launches your agent.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

main();
