#!/usr/bin/env bun
/**
 * Convenience entry point for `bun run scripts/explain.ts <file-or-command>`.
 * Delegates to the CLI explain command.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { explain, formatExplainResult, type ExplainOptions } from "../src/cli/explain.ts";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`Usage: bun run scripts/explain.ts <file-or-command> [--json] [--likely-skills s1,s2] [--budget <bytes>]

Examples:
  bun run scripts/explain.ts vercel.json
  bun run scripts/explain.ts 'npx vercel deploy'
  bun run scripts/explain.ts middleware.ts --json
  bun run scripts/explain.ts app/api/chat/route.ts --likely-skills ai-sdk,nextjs`);
  process.exit(0);
}

let target = "";
let jsonOutput = false;
let likelySkills: string | undefined;
let budgetBytes: number | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") {
    jsonOutput = true;
  } else if (arg === "--likely-skills") {
    i++;
    likelySkills = args[i];
  } else if (arg === "--budget") {
    i++;
    budgetBytes = parseInt(args[i], 10);
  } else if (!target) {
    target = arg;
  }
}

if (!target) {
  console.error("Error: provide a file path or bash command as argument");
  process.exit(1);
}

const projectRoot = resolve(import.meta.dir, "..");
const skillsDir = resolve(projectRoot, "skills");
if (!existsSync(skillsDir)) {
  console.error(`Error: no skills/ directory found at ${projectRoot}`);
  process.exit(2);
}

try {
  const options: ExplainOptions = {};
  if (likelySkills) options.likelySkills = likelySkills;
  if (budgetBytes && Number.isFinite(budgetBytes) && budgetBytes > 0) options.budgetBytes = budgetBytes;

  const result = explain(target, projectRoot, options);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatExplainResult(result));
  }

  process.exit(result.matches.length > 0 ? 0 : 1);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(2);
}
