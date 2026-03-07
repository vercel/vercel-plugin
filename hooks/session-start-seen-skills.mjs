#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { requireEnvFile } from "./hook-env.mjs";
const envFile = requireEnvFile();
try {
  appendFileSync(envFile, 'export VERCEL_PLUGIN_SEEN_SKILLS=""\n');
} catch {
}
