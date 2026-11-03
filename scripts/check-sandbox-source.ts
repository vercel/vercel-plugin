#!/usr/bin/env bun

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractUpstreamBody, UPSTREAM_DIRS } from "./build-skills";

const ROOT = resolve(import.meta.dir, "..");

type Files = Map<string, Buffer>;

function filesIn(directory: string, prefix = ""): Files {
  if (!lstatSync(directory).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  const files: Files = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, bytes] of filesIn(path, `${name}/`)) files.set(child, bytes);
    } else if (entry.isFile()) {
      files.set(name, readFileSync(path));
    } else {
      throw new Error(`Expected a regular file or directory: ${path}`);
    }
  }
  return files;
}

function compare(expected: Files, actual: Files, label: string): string[] {
  const differences: string[] = [];
  for (const name of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    if (!actual.has(name)) differences.push(`${label}: missing ${name}`);
    else if (!expected.has(name)) differences.push(`${label}: extra ${name}`);
    else if (!expected.get(name)!.equals(actual.get(name)!)) differences.push(`${label}: changed ${name}`);
  }
  return differences;
}

export function checkSandboxSource(canonicalDirectory: string, pluginRoot = ROOT): string[] {
  const skillDirectory = join(pluginRoot, "skills/vercel-sandbox");
  const canonical = filesIn(canonicalDirectory);
  const bundled = filesIn(join(skillDirectory, "upstream"));
  if (!canonical.has("SKILL.md") || !bundled.has("SKILL.md")) {
    throw new Error("Both canonical and bundled directories must contain SKILL.md");
  }
  if (!canonical.get("SKILL.md")!.toString("utf8").trim() || !bundled.get("SKILL.md")!.toString("utf8").trim()) {
    throw new Error("Canonical and bundled SKILL.md must not be empty");
  }
  const differences = compare(canonical, bundled, "Bundled source");
  const overlay = readFileSync(join(skillDirectory, "overlay.yaml"), "utf8");
  const generated = Buffer.from(`---\n${overlay}---\n${extractUpstreamBody(join(skillDirectory, "upstream/SKILL.md"))}`);
  const expected: Files = new Map([["SKILL.md", generated]]);
  const actual: Files = new Map();
  // Only files copied by build-skills belong to the generated comparison.
  const isGenerated = (name: string) => name === "SKILL.md" || name === "AGENTS.md" ||
    UPSTREAM_DIRS.some((directory) => name.startsWith(`${directory}/`));
  for (const [name, bytes] of bundled) {
    if (name !== "SKILL.md" && isGenerated(name)) expected.set(name, bytes);
  }
  for (const [name, bytes] of filesIn(skillDirectory)) {
    if (isGenerated(name)) actual.set(name, bytes);
  }
  return [...differences, ...compare(expected, actual, "Generated skill")];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.error("Usage: bun run check:sandbox-source <vercel/sandbox checkout>/skills/sandbox");
    process.exit(2);
  }
  try {
    const differences = checkSandboxSource(resolve(args[0]));
    if (differences.length) {
      console.error("Sandbox skill source drift detected:");
      for (const difference of differences) console.error(`- ${difference}`);
      console.error("Review vercel/sandbox skills/sandbox, refresh skills/vercel-sandbox/upstream, remove files and generated references deleted upstream, then run bun run build:skills vercel-sandbox and review the diff. Preserve overlay.yaml and verify CLI release availability.");
      process.exitCode = 1;
    } else {
      console.log("Sandbox source and generated skill match. Plugin overlay preserved.");
    }
  } catch (error) {
    console.error(`Sandbox source check could not complete: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
