#!/usr/bin/env node
/**
 * SessionStart hook: emit a tiered profile block based on profiler output.
 *
 * Replaces inject-claude-md.mjs. Reads profiler state from session files
 * and emits a compact, tiered context block instead of the full 52KB vercel.md.
 *
 * Tier 0 (0B):       No likely skills detected → no output
 * Tier 1 (300-800B): 1-2 weak signals only → tiny profile block
 * Tier 2 (800B-2KB): Strong signals or 3+ skills → profile + one-line summaries
 * Tier 3 (2-6KB):    Strong signals + foundational need → profile + summaries + one skill body
 *
 * Output: plain text on stdout (SessionStart hooks emit raw text for claude-code).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pluginRoot,
  readSessionFile,
  safeReadFile,
  safeReadJson,
  writeSessionFile,
} from "./hook-env.mjs";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";
import {
  type DetectionReason,
  type SkillDetection,
} from "./orchestrator-install-plan.mjs";
import {
  type ProjectFact,
  profileProjectDetections,
} from "./session-start-profiler.mjs";

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionStartInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

interface ManifestSkill {
  summary?: string;
  priority?: number;
  [key: string]: unknown;
}

interface Manifest {
  skills?: Record<string, ManifestSkill>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tier computation
// ---------------------------------------------------------------------------

/** Strong signal sources — vercel.json keys, AI deps, Vercel platform deps. */
const STRONG_DEPENDENCY_PREFIXES = ["ai", "@ai-sdk/", "@vercel/"];

function isStrongReason(reason: DetectionReason): boolean {
  if (reason.kind === "vercel-json") return true;
  if (reason.source === "vercel.json") return true;
  if (
    reason.kind === "dependency" &&
    STRONG_DEPENDENCY_PREFIXES.some((prefix) => reason.source.startsWith(prefix))
  ) {
    return true;
  }
  if (
    reason.kind === "file" &&
    (reason.source === ".vercel" || reason.source.startsWith(".vercel/"))
  ) {
    return true;
  }
  return false;
}

export function computeSessionTier(
  detections: SkillDetection[],
  projectFacts: ProjectFact[],
): number {
  if (detections.length === 0) return 0;

  const hasStrongSignal = detections.some((d) =>
    d.reasons.some((r) => isStrongReason(r)),
  );

  if (hasStrongSignal && projectFacts.includes("greenfield")) return 3;
  if (hasStrongSignal || detections.length >= 3) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Context block builders
// ---------------------------------------------------------------------------

function loadManifest(): Manifest | null {
  return safeReadJson<Manifest>(join(pluginRoot(), "generated", "skill-rules.json"));
}

function loadCachedSkillBody(cwd: string, slug: string): string | null {
  const skillPath = join(cwd, ".claude", "skills", slug, "SKILL.md");
  return safeReadFile(skillPath);
}

function buildTier1Block(skills: string[]): string {
  return [
    `<!-- vercel-plugin:session-start tier="1" -->`,
    `Vercel project detected.`,
    `Detected skills: ${skills.join(", ")}`,
    `Policy: Detailed guidance loads automatically when you work with matching files.`,
    `<!-- /vercel-plugin:session-start -->`,
  ].join("\n");
}

function buildTier2Block(
  skills: string[],
  projectFacts: ProjectFact[],
  manifest: Manifest | null,
): string {
  const lines = [
    `<!-- vercel-plugin:session-start tier="2" -->`,
    `Vercel project detected.`,
    `Detected skills: ${skills.join(", ")}`,
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

function buildTier3Block(
  skills: string[],
  projectFacts: ProjectFact[],
  manifest: Manifest | null,
  cwd: string,
): string {
  const lines = [
    `<!-- vercel-plugin:session-start tier="3" -->`,
    `Vercel project detected.`,
    `Detected skills: ${skills.join(", ")}`,
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

  // Try to load one cached skill body — prefer AI-related foundational skills
  const aiSkills = ["ai-sdk", "ai-elements", "ai-gateway"];
  const foundationalOrder = [
    ...aiSkills.filter((s) => skills.includes(s)),
    ...skills.filter((s) => !aiSkills.includes(s)),
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

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function parseInput(raw: string): SessionStartInput | null {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw) as SessionStartInput;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Greenfield context (preserved from inject-claude-md)
// ---------------------------------------------------------------------------

const GREENFIELD_CONTEXT = `<!-- vercel-plugin:greenfield-execution -->
## Greenfield execution mode

This directory is empty.
Do not stop in planning mode or spin up a read-only planning subagent.
Choose sensible defaults immediately.
Start executing with real tool calls.
Use non-interactive scaffolding commands (--yes) where available.
Only ask follow-up questions when blocked by missing credentials or irreversible decisions.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  try {
    const input = parseInput(readFileSync(0, "utf8"));
    const sessionId = input?.session_id ?? null;
    const cwd = process.cwd();

    // Read profiler output from session files
    const likelySkillsRaw = sessionId
      ? readSessionFile(sessionId, "likely-skills")
      : (process.env.VERCEL_PLUGIN_LIKELY_SKILLS ?? "");
    const likelySkills = likelySkillsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const isGreenfield = sessionId
      ? readSessionFile(sessionId, "greenfield") === "true"
      : process.env.VERCEL_PLUGIN_GREENFIELD === "true";

    // Reconstruct detections for tier computation.
    // Re-profiling is cheap — just marker files + package.json scan.
    const detections: SkillDetection[] = isGreenfield
      ? likelySkills.map((skill) => ({
          skill,
          reasons: [{ kind: "greenfield" as const, source: "project-root", detail: "greenfield" }],
        }))
      : profileProjectDetections(cwd);

    // Collect project facts from env (set by profiler)
    const projectFacts: ProjectFact[] = [];
    if (isGreenfield) projectFacts.push("greenfield");
    const projectFactsRaw = process.env.VERCEL_PLUGIN_PROJECT_FACTS;
    if (projectFactsRaw) {
      for (const fact of projectFactsRaw.split(",")) {
        const trimmed = fact.trim() as ProjectFact;
        if (trimmed && !projectFacts.includes(trimmed)) {
          projectFacts.push(trimmed);
        }
      }
    }

    const tier = computeSessionTier(detections, projectFacts);

    // Persist tier to session file
    if (sessionId) {
      writeSessionFile(sessionId, "session-tier", String(tier));
    }

    const parts: string[] = [];

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

const ENTRYPOINT = fileURLToPath(import.meta.url);
const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === ENTRYPOINT : false;

if (isEntrypoint) {
  main();
}
