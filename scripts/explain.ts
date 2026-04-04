#!/usr/bin/env bun
/**
 * Convenience entry point for `bun run scripts/explain.ts <file-or-command>`.
 * Delegates to the CLI explain command.
 */

import { resolve } from "node:path";
import { explain, formatExplainResult, type ExplainOptions } from "../src/cli/explain.ts";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`Usage: bun run scripts/explain.ts [<ToolName> <target> | --file <path> | --bash <command> | <target>] [--json] [--likely-skills s1,s2] [--budget <bytes>]

Examples:
  bun run scripts/explain.ts -- Read vercel.json
  bun run scripts/explain.ts -- Bash 'npx turbo build'
  bun run scripts/explain.ts --file vercel.json
  bun run scripts/explain.ts --bash 'npx turbo build'
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
let toolName: string | undefined;

const TOOL_NAMES = new Set(["Read", "Edit", "Write", "Bash"]);

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
  } else if (arg === "--file" || arg === "--bash") {
    i++;
    target = args[i];
    if (arg === "--bash") toolName = "Bash";
    else toolName = "Read";
  } else if (!toolName && !target && TOOL_NAMES.has(arg)) {
    // Support `Read vercel.json` / `Bash 'npx turbo build'` syntax
    toolName = arg;
  } else if (!target) {
    target = arg;
  }
}

if (!target) {
  console.error("Error: provide a file path or bash command as argument");
  process.exit(1);
}

const projectRoot = resolve(import.meta.dir, "..");

try {
  const options: ExplainOptions = {};
  if (likelySkills) options.likelySkills = likelySkills;
  if (budgetBytes && Number.isFinite(budgetBytes) && budgetBytes > 0) options.budgetBytes = budgetBytes;
  if (toolName) options.toolName = toolName;

  const result = explain(target, projectRoot, options);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatExplainResult(result));
  }

  process.exit(0);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
