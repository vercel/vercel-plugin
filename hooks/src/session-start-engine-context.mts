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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pluginRoot,
  readSessionFile,
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
import { createSkillStore } from "./skill-store.mjs";

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
// Context block builders — skill store integration
// ---------------------------------------------------------------------------

type SessionStartEligible = "body" | "summary" | "none";

interface SessionStartSkillEntry {
  skill: string;
  summary: string;
  summarySource: string;
  sessionStartEligible: SessionStartEligible;
  body: string | null;
  bodySource: string | null;
}

function resolveSessionStartEligibility(
  config: { summary?: string; sessionStartEligible?: string },
  body: string | null,
): SessionStartEligible {
  if (
    config.sessionStartEligible === "body" ||
    config.sessionStartEligible === "summary" ||
    config.sessionStartEligible === "none"
  ) {
    return config.sessionStartEligible;
  }
  if (body && body.trim().length > 100) {
    return "body";
  }
  if ((config.summary ?? "").trim() !== "") {
    return "summary";
  }
  return "none";
}

export function resolveSessionStartSkillEntries(
  projectRoot: string,
  skills: string[],
): SessionStartSkillEntry[] {
  if (skills.length === 0) {
    return [];
  }

  const store = createSkillStore({
    projectRoot,
    pluginRoot: pluginRoot(),
    includeRulesManifest:
      process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
  });

  const loaded = store.loadSkillSet(log);
  if (!loaded) {
    log.debug("session-start-engine-context:no-skill-store-data", {
      projectRoot,
      requestedSkills: skills,
    });
    return [];
  }

  const entries = skills.flatMap((skill): SessionStartSkillEntry[] => {
    const config = loaded.skillMap[skill];
    if (!config) {
      return [];
    }

    const payload = store.resolveSkillPayload(skill, log);
    const body =
      payload?.mode === "body" && payload.body
        ? payload.body.trim()
        : null;

    return [
      {
        skill,
        summary: (config.summary ?? "").trim(),
        summarySource: loaded.origins[skill]?.source ?? "unknown",
        sessionStartEligible: resolveSessionStartEligibility(config, body),
        body,
        bodySource: body ? (payload?.source ?? null) : null,
      },
    ];
  });

  log.debug("session-start-engine-context:resolved-skills", {
    projectRoot,
    requestedSkills: skills,
    resolvedSkills: entries.map((entry) => ({
      skill: entry.skill,
      eligible: entry.sessionStartEligible,
      hasSummary: entry.summary !== "",
      hasBody: entry.body !== null,
      summarySource: entry.summarySource,
      bodySource: entry.bodySource,
    })),
  });

  return entries;
}

function appendSkillSummaries(
  lines: string[],
  skillEntries: SessionStartSkillEntry[],
): void {
  for (const entry of skillEntries) {
    if (entry.summary === "" || entry.sessionStartEligible === "none") {
      continue;
    }
    lines.push(`- ${entry.skill}: ${entry.summary}`);
  }
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
  likelySkills: string[],
  projectFacts: ProjectFact[],
  skillEntries: SessionStartSkillEntry[],
): string {
  const displayedSkills =
    skillEntries.length > 0
      ? skillEntries.map((entry) => entry.skill)
      : likelySkills;

  const lines = [
    `<!-- vercel-plugin:session-start tier="2" -->`,
    `Vercel project detected.`,
    `Detected skills: ${displayedSkills.join(", ")}`,
  ];

  if (projectFacts.length > 0) {
    lines.push(`Project facts: ${projectFacts.join(", ")}`);
  }

  appendSkillSummaries(lines, skillEntries);

  lines.push(`Policy: Detailed guidance loads automatically when you work with matching files.`);
  lines.push(`<!-- /vercel-plugin:session-start -->`);
  return lines.join("\n");
}

export function buildTier3Block(
  likelySkills: string[],
  projectFacts: ProjectFact[],
  skillEntries: SessionStartSkillEntry[],
): string {
  const displayedSkills =
    skillEntries.length > 0
      ? skillEntries.map((entry) => entry.skill)
      : likelySkills;

  const lines = [
    `<!-- vercel-plugin:session-start tier="3" -->`,
    `Vercel project detected.`,
    `Detected skills: ${displayedSkills.join(", ")}`,
  ];

  if (projectFacts.length > 0) {
    lines.push(`Project facts: ${projectFacts.join(", ")}`);
  }

  appendSkillSummaries(lines, skillEntries);

  const aiSkills = ["ai-sdk", "ai-elements", "ai-gateway"];
  const preferredOrder = [
    ...aiSkills.filter((skill) => displayedSkills.includes(skill)),
    ...displayedSkills.filter((skill) => !aiSkills.includes(skill)),
  ];

  const bodyCandidate = preferredOrder
    .map((skill) => skillEntries.find((entry) => entry.skill === skill) ?? null)
    .find(
      (entry): entry is SessionStartSkillEntry =>
        entry !== null &&
        entry.sessionStartEligible === "body" &&
        entry.body !== null &&
        entry.body.trim() !== "",
    );

  if (bodyCandidate) {
    log.debug("session-start-engine-context:body-selected", {
      skill: bodyCandidate.skill,
      source: bodyCandidate.bodySource,
      bytes: Buffer.byteLength(bodyCandidate.body!, "utf8"),
    });
    lines.push("");
    lines.push(`### Loaded Skill(${bodyCandidate.skill})`);
    const MAX_BODY = 4096;
    lines.push(
      bodyCandidate.body!.length > MAX_BODY
        ? `${bodyCandidate.body!.slice(0, MAX_BODY)}\n[...truncated]`
        : bodyCandidate.body!,
    );
  } else {
    log.debug("session-start-engine-context:body-missing", {
      requestedSkills: displayedSkills,
      candidates: skillEntries.map((entry) => ({
        skill: entry.skill,
        eligible: entry.sessionStartEligible,
        hasBody: entry.body !== null,
        bodySource: entry.bodySource,
      })),
    });
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

    const skillEntries = resolveSessionStartSkillEntries(cwd, likelySkills);

    const parts: string[] = [];

    if (tier === 0) {
      if (isGreenfield) {
        parts.push(GREENFIELD_CONTEXT);
      }
    } else {
      if (tier === 1) {
        parts.push(buildTier1Block(likelySkills));
      } else if (tier === 2) {
        parts.push(buildTier2Block(likelySkills, projectFacts, skillEntries));
      } else {
        parts.push(buildTier3Block(likelySkills, projectFacts, skillEntries));
      }

      if (isGreenfield) {
        parts.push(GREENFIELD_CONTEXT);
      }
    }

    if (parts.length === 0) return;

    log.summary("session-start-engine-context:complete", {
      sessionId,
      tier,
      likelySkills,
      resolvedSkills: skillEntries.map((entry) => ({
        skill: entry.skill,
        eligible: entry.sessionStartEligible,
        source: entry.bodySource ?? entry.summarySource,
      })),
      emittedBytes: Buffer.byteLength(parts.join("\n\n"), "utf8"),
    });

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
