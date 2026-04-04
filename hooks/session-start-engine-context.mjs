#!/usr/bin/env node

// hooks/src/session-start-engine-context.mts
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  pluginRoot,
  readSessionFile,
  safeReadFile,
  safeReadJson,
  writeSessionFile
} from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  profileProjectDetections
} from "./session-start-profiler.mjs";
var log = createLogger();
var STRONG_DEPENDENCY_PREFIXES = ["ai", "@ai-sdk/", "@vercel/"];
function isStrongReason(reason) {
  if (reason.kind === "vercel-json") return true;
  if (reason.source === "vercel.json") return true;
  if (reason.kind === "dependency" && STRONG_DEPENDENCY_PREFIXES.some((prefix) => reason.source.startsWith(prefix))) {
    return true;
  }
  if (reason.kind === "file" && (reason.source === ".vercel" || reason.source.startsWith(".vercel/"))) {
    return true;
  }
  return false;
}
function computeSessionTier(detections, projectFacts) {
  if (detections.length === 0) return 0;
  const hasStrongSignal = detections.some(
    (d) => d.reasons.some((r) => isStrongReason(r))
  );
  if (hasStrongSignal && projectFacts.includes("greenfield")) return 3;
  if (hasStrongSignal || detections.length >= 3) return 2;
  return 1;
}
function loadManifest() {
  return safeReadJson(join(pluginRoot(), "generated", "skill-rules.json"));
}
function loadCachedSkillBody(cwd, slug) {
  const skillPath = join(cwd, ".claude", "skills", slug, "SKILL.md");
  return safeReadFile(skillPath);
}
function buildTier1Block(skills) {
  return [
    `<!-- vercel-plugin:session-start tier="1" -->`,
    `Vercel project detected.`,
    `Detected skills: ${skills.join(", ")}`,
    `Policy: Detailed guidance loads automatically when you work with matching files.`,
    `<!-- /vercel-plugin:session-start -->`
  ].join("\n");
}
function buildTier2Block(skills, projectFacts, manifest) {
  const lines = [
    `<!-- vercel-plugin:session-start tier="2" -->`,
    `Vercel project detected.`,
    `Detected skills: ${skills.join(", ")}`
  ];
  if (projectFacts.length > 0) {
    lines.push(`Project facts: ${projectFacts.join(", ")}`);
  }
  if (manifest?.skills) {
    for (const skill of skills) {
      const entry = manifest.skills[skill];
      if (entry?.summary) {
        lines.push(`- ${skill}: ${entry.summary}`);
      }
    }
  }
  lines.push(`Policy: Detailed guidance loads automatically when you work with matching files.`);
  lines.push(`<!-- /vercel-plugin:session-start -->`);
  return lines.join("\n");
}
function buildTier3Block(skills, projectFacts, manifest, cwd) {
  const lines = [
    `<!-- vercel-plugin:session-start tier="3" -->`,
    `Vercel project detected.`,
    `Detected skills: ${skills.join(", ")}`
  ];
  if (projectFacts.length > 0) {
    lines.push(`Project facts: ${projectFacts.join(", ")}`);
  }
  if (manifest?.skills) {
    for (const skill of skills) {
      const entry = manifest.skills[skill];
      if (entry?.summary) {
        lines.push(`- ${skill}: ${entry.summary}`);
      }
    }
  }
  const aiSkills = ["ai-sdk", "ai-elements", "ai-gateway"];
  const foundationalOrder = [
    ...aiSkills.filter((s) => skills.includes(s)),
    ...skills.filter((s) => !aiSkills.includes(s))
  ];
  for (const slug of foundationalOrder) {
    const body = loadCachedSkillBody(cwd, slug);
    if (body) {
      lines.push("");
      lines.push(`### Loaded Skill(${slug})`);
      const MAX_BODY = 4096;
      lines.push(body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n[...truncated]" : body);
      break;
    }
  }
  lines.push(`Policy: Detailed guidance loads automatically when you work with matching files.`);
  lines.push(`<!-- /vercel-plugin:session-start -->`);
  return lines.join("\n");
}
function parseInput(raw) {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
var GREENFIELD_CONTEXT = `<!-- vercel-plugin:greenfield-execution -->
## Greenfield execution mode

This directory is empty.
Do not stop in planning mode or spin up a read-only planning subagent.
Choose sensible defaults immediately.
Start executing with real tool calls.
Use non-interactive scaffolding commands (--yes) where available.
Only ask follow-up questions when blocked by missing credentials or irreversible decisions.`;
function main() {
  try {
    const input = parseInput(readFileSync(0, "utf8"));
    const sessionId = input?.session_id ?? null;
    const cwd = process.cwd();
    const likelySkillsRaw = sessionId ? readSessionFile(sessionId, "likely-skills") : process.env.VERCEL_PLUGIN_LIKELY_SKILLS ?? "";
    const likelySkills = likelySkillsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const isGreenfield = sessionId ? readSessionFile(sessionId, "greenfield") === "true" : process.env.VERCEL_PLUGIN_GREENFIELD === "true";
    const detections = isGreenfield ? likelySkills.map((skill) => ({
      skill,
      reasons: [{ kind: "greenfield", source: "project-root", detail: "greenfield" }]
    })) : profileProjectDetections(cwd);
    const projectFacts = [];
    if (isGreenfield) projectFacts.push("greenfield");
    const projectFactsRaw = process.env.VERCEL_PLUGIN_PROJECT_FACTS;
    if (projectFactsRaw) {
      for (const fact of projectFactsRaw.split(",")) {
        const trimmed = fact.trim();
        if (trimmed && !projectFacts.includes(trimmed)) {
          projectFacts.push(trimmed);
        }
      }
    }
    const tier = computeSessionTier(detections, projectFacts);
    if (sessionId) {
      writeSessionFile(sessionId, "session-tier", String(tier));
    }
    const parts = [];
    if (tier === 0) {
      if (isGreenfield) {
        parts.push(GREENFIELD_CONTEXT);
      }
    } else {
      const manifest = loadManifest();
      if (tier === 1) {
        parts.push(buildTier1Block(likelySkills));
      } else if (tier === 2) {
        parts.push(buildTier2Block(likelySkills, projectFacts, manifest));
      } else {
        parts.push(buildTier3Block(likelySkills, projectFacts, manifest, cwd));
      }
      if (isGreenfield) {
        parts.push(GREENFIELD_CONTEXT);
      }
    }
    if (parts.length === 0) return;
    process.stdout.write(parts.join("\n\n"));
  } catch (error) {
    logCaughtError(log, "session-start-engine-context:main-crash", error, {});
  }
}
var ENTRYPOINT = fileURLToPath(import.meta.url);
var isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === ENTRYPOINT : false;
if (isEntrypoint) {
  main();
}
export {
  computeSessionTier
};
