#!/usr/bin/env bun
/**
 * vercel-plugin CLI entry point.
 *
 * Usage:
 *   vercel-plugin explain <target> [--json] [--project <path>]
 *   vercel-plugin explain --help
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { explain, formatExplainResult } from "./explain.ts";
import { doctor, formatDoctorResult } from "../commands/doctor.ts";
import { runRoutingExplain } from "../commands/routing-explain.ts";
import { runSessionExplain } from "../commands/session-explain.ts";
import { runDecisionCat } from "../commands/decision-cat.ts";
import { createEmptyRoutingPolicy, type RoutingPolicyFile } from "../../hooks/src/routing-policy.mts";
import { runLearnCommand } from "./learn.ts";

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
  routing-explain     Show the latest routing decision trace
  session-explain     Show manifest, routing, verification, and exposure state together
  decision-cat <path> Read and display a decision capsule artifact
  learn               Distill verified routing wins into learned rules
  doctor              Run self-diagnosis checks on the plugin setup

Options for explain:
  --json              Output machine-readable JSON
  --project <path>    Project root (default: current plugin directory)
  --likely-skills s1,s2  Simulate session-start profiler boost (+5 priority)
  --budget <bytes>    Override injection byte budget (default: 12000)
  --policy-file <path>  Load routing policy from a JSON file (default: project tmpdir)
  --help, -h          Show this help message

Options for routing-explain:
  --json              Output machine-readable JSON
  --session <id>      Session ID (reads traces from session trace dir)
  --help, -h          Show this help message

Options for decision-cat:
  --json              Output machine-readable JSON
  --help, -h          Show this help message

Options for learn:
  --json              Output machine-readable JSON
  --write             Write generated/learned-routing-rules.json
  --project <path>    Project root (default: current plugin directory)
  --session <id>      Scope to a single session ID
  --min-support <n>   Minimum support threshold (default: 5)
  --min-precision <n> Minimum precision threshold (default: 0.8)
  --min-lift <n>      Minimum lift threshold (default: 1.5)
  --help, -h          Show this help message

Options for session-explain:
  --json              Output machine-readable JSON
  --session <id>      Session ID
  --project <path>    Project root (default: current plugin directory)
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
} else if (command === "routing-explain") {
  runRoutingExplainCmd(args.slice(1));
} else if (command === "session-explain") {
  runSessionExplainCmd(args.slice(1));
} else if (command === "decision-cat") {
  runDecisionCatCmd(args.slice(1));
} else if (command === "learn") {
  runLearnCmd(args.slice(1));
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
  let policyFilePath: string | undefined;

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
    } else if (arg === "--policy-file") {
      i++;
      if (i >= explainArgs.length) {
        console.error("Error: --policy-file requires a file path");
        process.exit(1);
      }
      policyFilePath = resolve(explainArgs[i]);
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

  // Load policy file if provided
  let policyFile: RoutingPolicyFile | undefined;
  if (policyFilePath) {
    try {
      policyFile = JSON.parse(readFileSync(policyFilePath, "utf-8"));
    } catch {
      console.error(`Error: could not read routing policy file at ${policyFilePath}`);
      process.exit(2);
    }
  }

  try {
    const result = explain(target, projectRoot, { likelySkills, budgetBytes, policyFile });

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

function runRoutingExplainCmd(cmdArgs: string[]) {
  let jsonOutput = false;
  let sessionId: string | null = null;

  for (let i = 0; i < cmdArgs.length; i++) {
    const arg = cmdArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--session") {
      i++;
      if (i >= cmdArgs.length) {
        console.error("Error: --session requires a session ID argument");
        process.exit(1);
      }
      sessionId = cmdArgs[i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Error: unexpected argument "${arg}"`);
      process.exit(1);
    }
  }

  try {
    const output = runRoutingExplain(sessionId, jsonOutput);
    console.log(output);
    process.exit(0);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
}

function runSessionExplainCmd(cmdArgs: string[]) {
  let jsonOutput = false;
  let sessionId: string | null = null;
  let projectRoot = resolve(import.meta.dir, "../..");

  for (let i = 0; i < cmdArgs.length; i++) {
    const arg = cmdArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--session") {
      i++;
      if (i >= cmdArgs.length) {
        console.error("Error: --session requires a session ID argument");
        process.exit(1);
      }
      sessionId = cmdArgs[i];
    } else if (arg === "--project") {
      i++;
      if (i >= cmdArgs.length) {
        console.error("Error: --project requires a path argument");
        process.exit(1);
      }
      projectRoot = resolve(cmdArgs[i]);
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Error: unexpected argument "${arg}"`);
      process.exit(1);
    }
  }

  try {
    const output = runSessionExplain(sessionId, projectRoot, jsonOutput);
    console.log(output);
    process.exit(0);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
}

function runDecisionCatCmd(cmdArgs: string[]) {
  let jsonOutput = false;
  let artifactPath = "";

  for (let i = 0; i < cmdArgs.length; i++) {
    const arg = cmdArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg!.startsWith("-")) {
      console.error(`Error: unexpected option "${arg}"`);
      process.exit(1);
    } else if (!artifactPath) {
      artifactPath = resolve(arg!);
    } else {
      console.error(`Error: unexpected argument "${arg}"`);
      process.exit(1);
    }
  }

  if (!artifactPath) {
    console.error("Error: decision-cat requires an <artifact-path> argument");
    process.exit(1);
  }

  const { output, ok } = runDecisionCat(artifactPath, jsonOutput);

  if (ok) {
    console.log(output);
    process.exit(0);
  } else {
    // For JSON mode, output goes to stdout (structured failure); for text, stderr
    if (jsonOutput) {
      console.log(output);
    } else {
      console.error(output);
    }
    process.exit(2);
  }
}

function runLearnCmd(cmdArgs: string[]) {
  let jsonOutput = false;
  let writeOutput = false;
  let projectRoot = resolve(import.meta.dir, "../..");
  let sessionId: string | undefined;
  let minSupport: number | undefined;
  let minPrecision: number | undefined;
  let minLift: number | undefined;

  for (let i = 0; i < cmdArgs.length; i++) {
    const arg = cmdArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--write") {
      writeOutput = true;
    } else if (arg === "--project") {
      i++;
      if (i >= cmdArgs.length) {
        console.error("Error: --project requires a path argument");
        process.exit(1);
      }
      projectRoot = resolve(cmdArgs[i]);
    } else if (arg === "--session") {
      i++;
      if (i >= cmdArgs.length) {
        console.error("Error: --session requires a session ID argument");
        process.exit(1);
      }
      sessionId = cmdArgs[i];
    } else if (arg === "--min-support") {
      i++;
      if (i >= cmdArgs.length) {
        console.error("Error: --min-support requires a number");
        process.exit(1);
      }
      minSupport = Number(cmdArgs[i]);
    } else if (arg === "--min-precision") {
      i++;
      if (i >= cmdArgs.length) {
        console.error("Error: --min-precision requires a number");
        process.exit(1);
      }
      minPrecision = Number(cmdArgs[i]);
    } else if (arg === "--min-lift") {
      i++;
      if (i >= cmdArgs.length) {
        console.error("Error: --min-lift requires a number");
        process.exit(1);
      }
      minLift = Number(cmdArgs[i]);
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Error: unexpected argument "${arg}"`);
      process.exit(1);
    }
  }

  runLearnCommand({
    project: projectRoot,
    json: jsonOutput,
    write: writeOutput,
    session: sessionId,
    minSupport,
    minPrecision,
    minLift,
  }).then((code) => {
    process.exit(code);
  }).catch((err: any) => {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  });
}
