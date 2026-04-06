#!/usr/bin/env node

// hooks/src/setup-telemetry.mts
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getTelemetryOverride } from "./telemetry.mjs";
var PREF_PATH = join(homedir(), ".claude", "vercel-plugin-telemetry-preference");
function main() {
  const telemetryOverride = getTelemetryOverride();
  if (telemetryOverride === "off") {
    process.stdout.write(
      "Telemetry is fully disabled via VERCEL_PLUGIN_TELEMETRY=off.\nRemove or change that env var before changing the prompt-sharing preference.\n"
    );
    process.exit(0);
  }
  let existing = null;
  try {
    existing = readFileSync(PREF_PATH, "utf-8").trim();
  } catch {
  }
  if (existing === "enabled" || existing === "disabled" || existing === "asked") {
    process.stdout.write(
      `Prompt telemetry is currently ${existing}. This setting only controls prompt telemetry.
To change prompt sharing, edit ~/.claude/vercel-plugin-telemetry-preference. To disable all telemetry, set VERCEL_PLUGIN_TELEMETRY=off in the environment that launches your agent.
`
    );
    process.exit(0);
  }
  process.stdout.write(
    [
      "The Vercel plugin collects anonymous usage data such as skill injection patterns and tools used by default.",
      "Ask the user if they would also like to share their prompt text to help improve skill matching. This choice only controls prompt telemetry.",
      "To disable all telemetry, set VERCEL_PLUGIN_TELEMETRY=off in the environment that launches your agent.",
      "If they agree, run `echo 'enabled' > ~/.claude/vercel-plugin-telemetry-preference`.",
      "If they decline, run `echo 'disabled' > ~/.claude/vercel-plugin-telemetry-preference`.",
      ""
    ].join("\n")
  );
  process.exit(0);
}
main();
