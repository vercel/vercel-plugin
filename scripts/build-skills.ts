#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = join(ROOT, "skills");
const UPSTREAM_DIRS = ["references", "rules", "templates", "command"];

interface BuildResult {
  skill: string;
  status: "updated" | "unchanged" | "error";
  overlayLines: number;
  upstreamBodyLines: number;
  outputLines: number;
  copiedDirs: string[];
  error?: string;
}

function extractUpstreamBody(upstreamPath: string): string {
  const raw = readFileSync(upstreamPath, "utf-8");
  const lines = raw.split("\n");
  let dashCount = 0;
  let bodyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      dashCount++;
      if (dashCount === 2) {
        bodyStart = i + 1;
        break;
      }
    }
  }

  if (bodyStart === -1) return raw;
  return lines.slice(bodyStart).join("\n");
}

function buildSkill(skillName: string): BuildResult {
  const skillDir = join(SKILLS_DIR, skillName);
  const overlayPath = join(skillDir, "overlay.yaml");
  const upstreamSkillPath = join(skillDir, "upstream", "SKILL.md");
  const outputPath = join(skillDir, "SKILL.md");

  const result: BuildResult = {
    skill: skillName,
    status: "unchanged",
    overlayLines: 0,
    upstreamBodyLines: 0,
    outputLines: 0,
    copiedDirs: [],
  };

  try {
    const overlay = readFileSync(overlayPath, "utf-8");
    result.overlayLines = overlay.split("\n").length;

    const upstreamBody = extractUpstreamBody(upstreamSkillPath);
    result.upstreamBodyLines = upstreamBody.split("\n").length;

    const merged = `---\n${overlay}---\n${upstreamBody}`;
    result.outputLines = merged.split("\n").length;

    const existing = existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : "";
    if (existing === merged) {
      result.status = "unchanged";
    } else {
      writeFileSync(outputPath, merged);
      result.status = "updated";
    }

    const upstreamDir = join(skillDir, "upstream");
    for (const dir of UPSTREAM_DIRS) {
      const srcDir = join(upstreamDir, dir);
      const destDir = join(skillDir, dir);
      if (!existsSync(srcDir)) continue;
      if (existsSync(destDir)) rmSync(destDir, { recursive: true });
      cpSync(srcDir, destDir, { recursive: true });
      result.copiedDirs.push(dir);
    }

    const agentsMd = join(upstreamDir, "AGENTS.md");
    if (existsSync(agentsMd)) {
      cpSync(agentsMd, join(skillDir, "AGENTS.md"));
      result.copiedDirs.push("AGENTS.md");
    }

    return result;
  } catch (err) {
    result.status = "error";
    result.error = String((err as Error).message);
    return result;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const filter = args.find((a) => !a.startsWith("--"));

  const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      if (filter && name !== filter) return false;
      return existsSync(join(SKILLS_DIR, name, "overlay.yaml"));
    });

  if (skillDirs.length === 0) {
    console.log("No skills with overlay.yaml found.");
    process.exit(0);
  }

  let updated = 0;
  let unchanged = 0;
  let errors = 0;

  for (const skill of skillDirs.sort()) {
    const result = buildSkill(skill);

    if (result.status === "error") {
      console.error(`  ERROR    ${skill}: ${result.error}`);
      errors++;
    } else if (result.status === "updated") {
      if (check) {
        console.log(`  STALE    ${skill}`);
        errors++;
      } else {
        const dirs = result.copiedDirs.length > 0 ? ` + ${result.copiedDirs.join(", ")}` : "";
        console.log(`  updated  ${skill} (${result.overlayLines}L overlay + ${result.upstreamBodyLines}L body → ${result.outputLines}L${dirs})`);
        updated++;
      }
    } else {
      console.log(`  unchanged  ${skill}`);
      unchanged++;
    }
  }

  const summary = check ? "build:skills --check" : "build:skills";
  console.log(`\n${summary} — ${updated} updated, ${unchanged} unchanged, ${errors} errors`);
  if (errors > 0) process.exit(1);
}
