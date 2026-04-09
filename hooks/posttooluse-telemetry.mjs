#!/usr/bin/env node

// hooks/src/posttooluse-telemetry.mts
import { readFileSync } from "fs";
function parseStdin() {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function main() {
  parseStdin();
  process.stdout.write("{}");
  process.exit(0);
}
main();
