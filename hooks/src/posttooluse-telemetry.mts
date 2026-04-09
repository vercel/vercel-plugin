#!/usr/bin/env node

import { readFileSync } from "node:fs";

function parseStdin(): Record<string, unknown> | null {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  parseStdin();

  process.stdout.write("{}");
  process.exit(0);
}

main();
