#!/usr/bin/env bun
/**
 * vercel-plugin CLI entry point.
 *
 * Usage:
 *   vercel-plugin explain <target> [--json] [--project <path>]
 *   vercel-plugin explain --help
 */

import { resolve } from "node:path";
import { explain, formatExplainResult } from "./explain.ts";
import { doctor, formatDoctorResult } from "../commands/doctor.ts";

const args = process.argv.slice(2);

function printUsage() {
  console.log(`Usage: vercel-plugin <command> [options]

Commands:
  explain <target>    Show which skills match a file path or bash command
  doctor              Run self-diagnosis checks on the plugin setup

Options for explain:
  --json              Output machine-readable JSON
  --project <path>    Project root (default: current plugin directory)
  --likely-skills s1,s2  Simulate session-start profiler boost (+5 priority)
  --budget <bytes>    Override injection byte budget (default: 12000)
  --help, -h          Show this help message

Examples:
  vercel-plugin explain middleware.ts
  vercel-plugin explain "vercel deploy --prod"
  vercel-plugin explain vercel.json --json
  vercel-plugin explain app/api/chat/route.ts --project /path/to/plugin`);
}

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  printUsage();
  process.exit(0);
}

const command = args[0];

if (command === "explain") {
  runExplain(args.slice(1));
} else if (command === "doctor") {
  runDoctor(args.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

function runExplain(explainArgs: string[]) {
  let target = "";
  let jsonOutput = false;
  let projectRoot = resolve(import.meta.dir, "../..");
  let likelySkills: string | undefined;
  let budgetBytes: number | undefined;

  for (let i = 0; i < explainArgs.length; i++) {
    const arg = explainArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--project") {
      i++;
      if (i >= explainArgs.length) {
        console.error("Error: --project requires a path argument");
        process.exit(1);
      }
      projectRoot = resolve(explainArgs[i]);
    } else if (arg === "--likely-skills") {
      i++;
      if (i >= explainArgs.length) {
        console.error("Error: --likely-skills requires a comma-delimited list");
        process.exit(1);
      }
      likelySkills = explainArgs[i];
    } else if (arg === "--budget") {
      i++;
      if (i >= explainArgs.length) {
        console.error("Error: --budget requires a byte count");
        process.exit(1);
      }
      budgetBytes = parseInt(explainArgs[i], 10);
      if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
        console.error("Error: --budget must be a positive integer");
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!target) {
      target = arg;
    } else {
      console.error(`Error: unexpected argument "${arg}"`);
      process.exit(1);
    }
  }

  if (!target) {
    console.error("Error: explain requires a <target> argument (file path or bash command)");
    printUsage();
    process.exit(1);
  }

  // Validate project path has skills/
  const { existsSync } = require("node:fs");
  const { join } = require("node:path");
  const skillsDir = join(projectRoot, "skills");
  if (!existsSync(skillsDir)) {
    console.error(`Error: no skills/ directory found at ${projectRoot}`);
    console.error("Use --project to specify the plugin root directory");
    process.exit(2);
  }

  try {
    const result = explain(target, projectRoot, { likelySkills, budgetBytes });

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatExplainResult(result));
    }

    process.exit(0);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
}

function runDoctor(doctorArgs: string[]) {
  let jsonOutput = false;
  let projectRoot = resolve(import.meta.dir, "../..");

  for (let i = 0; i < doctorArgs.length; i++) {
    const arg = doctorArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--project") {
      i++;
      if (i >= doctorArgs.length) {
        console.error("Error: --project requires a path argument");
        process.exit(1);
      }
      projectRoot = resolve(doctorArgs[i]);
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Error: unexpected argument "${arg}"`);
      process.exit(1);
    }
  }

  const { existsSync } = require("node:fs");
  const { join } = require("node:path");
  const skillsDir = join(projectRoot, "skills");
  if (!existsSync(skillsDir)) {
    console.error(`Error: no skills/ directory found at ${projectRoot}`);
    console.error("Use --project to specify the plugin root directory");
    process.exit(2);
  }

  try {
    const result = doctor(projectRoot);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatDoctorResult(result));
    }

    const hasErrors = result.issues.some((i) => i.severity === "error");
    process.exit(hasErrors ? 1 : 0);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
}
