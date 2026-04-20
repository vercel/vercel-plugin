#!/usr/bin/env bun
/**
 * vercel-plugin CLI entry point.
 *
 * Usage:
 *   vercel-plugin explain <target> [--json] [--project <path>]
 *   vercel-plugin explain --help
 */

import { existsSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { explain, formatExplainResult } from "./explain.ts";
import { doctor, formatDoctorResult } from "../commands/doctor.ts";
import { loadAntigravityEnv } from "../../hooks/src/antigravity-env.mts";

// Load persistence if running under Antigravity
loadAntigravityEnv();

function validateProjectRoot(projectRoot: string): void {
  const skillsDir = join(projectRoot, "skills");
  if (!existsSync(skillsDir)) {
    console.error(`Error: no skills/ directory found at ${projectRoot}`);
    console.error("Use --project to specify the plugin root directory");
    process.exit(2);
  }
}

const args = process.argv.slice(2);

function printUsage() {
  console.log(`Usage: vercel-plugin <command> [options]

Commands:
  explain <target>    Show which skills match a file path or bash command
  doctor              Run self-diagnosis checks on the plugin setup
  install             Automate installation and platform integration

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
  vercel-plugin explain app/api/chat/route.ts --project /path/to/plugin
  vercel-plugin install --antigravity`);
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
} else if (command === "install") {
  runInstall(args.slice(1));
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
  validateProjectRoot(projectRoot);

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

  validateProjectRoot(projectRoot);

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

function runInstall(installArgs: string[]) {
  let platform: "antigravity" | undefined;
  let projectRoot = resolve(import.meta.dir, "../..");

  for (let i = 0; i < installArgs.length; i++) {
    const arg = installArgs[i];
    if (arg === "--antigravity") {
      platform = "antigravity";
    } else if (arg === "--project") {
      i++;
      if (i >= installArgs.length) {
        console.error("Error: --project requires a path argument");
        process.exit(1);
      }
      projectRoot = resolve(installArgs[i]);
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Error: unexpected argument "${arg}"`);
      process.exit(1);
    }
  }

  if (!platform) {
    console.error("Error: install requires a platform flag (e.g. --antigravity)");
    process.exit(1);
  }

  if (platform === "antigravity") {
    const antigravitySkillsDir = join(homedir(), ".gemini", "antigravity", "skills");
    const junctionPath = join(antigravitySkillsDir, "nextjs");
    const skillsSource = join(projectRoot, "skills");
    const contextStateDir = join(homedir(), ".gemini", "antigravity", "context_state");

    console.log("Installing vercel-plugin for Antigravity...");

    try {
      // 1. Ensure skills dir exists
      if (!existsSync(antigravitySkillsDir)) {
        console.log(`Creating ${antigravitySkillsDir}...`);
        mkdirSync(antigravitySkillsDir, { recursive: true });
      }

      // 2. Create skills junction
      if (!existsSync(junctionPath)) {
        console.log(`Linking ${skillsSource} to ${junctionPath}...`);
        symlinkSync(skillsSource, junctionPath, "junction");
      } else {
        console.log(`Link already exists at ${junctionPath}`);
      }

      // 3. Ensure context_state exists
      if (!existsSync(contextStateDir)) {
        console.log(`Creating ${contextStateDir}...`);
        mkdirSync(contextStateDir, { recursive: true });
      }

      console.log("\nSuccess: vercel-plugin is now integrated with Antigravity.");
      console.log("You can verify with: $env:ANTIGRAVITY_AGENT='1'; vercel-plugin doctor");
      process.exit(0);
    } catch (err: any) {
      console.error(`Error during installation: ${err.message}`);
      process.exit(2);
    }
  }
}
