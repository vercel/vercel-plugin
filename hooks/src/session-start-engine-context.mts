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

type SessionPresentationState = "greenfield" | "body-selected" | "summary-only";

interface SessionPresentationSnapshot {
  state: SessionPresentationState;
  selectedBodySkill: string | null;
  displayedSkills: string[];
  projectFacts: ProjectFact[];
}

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

  log.summary("session-start-engine-context:resolved-skills", {
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

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function presentableSkillEntries(
  skillEntries: SessionStartSkillEntry[],
): SessionStartSkillEntry[] {
  return skillEntries.filter(
    (entry): entry is SessionStartSkillEntry => entry !== null,
  );
}

function formatSkillTags(skills: string[]): string {
  return skills.length === 0
    ? "_none_"
    : skills.map((skill) => `\`${skill}\``).join(" ");
}

function formatProjectFactTags(projectFacts: ProjectFact[]): string | null {
  return projectFacts.length === 0
    ? null
    : projectFacts.map((fact) => `\`${fact}\``).join(" ");
}

function selectBodyCandidate(
  skillEntries: SessionStartSkillEntry[],
): SessionStartSkillEntry | null {
  return (
    presentableSkillEntries(skillEntries).find(
      (entry) =>
        entry.sessionStartEligible === "body" &&
        entry.body !== null &&
        entry.body.trim() !== "",
    ) ?? null
  );
}

function buildSummaryTeasers(
  skillEntries: SessionStartSkillEntry[],
  limit = 3,
): string[] {
  return presentableSkillEntries(skillEntries)
    .filter((entry) => entry.summary !== null && entry.summary.trim() !== "")
    .slice(0, limit)
    .map((entry) => `- \`${entry.skill}\` — ${entry.summary!.trim()}`);
}

function trimBodyPreview(body: string, maxBytes = 2200): string {
  const trimmed = body.trim();
  const buffer = Buffer.from(trimmed, "utf8");
  if (buffer.byteLength <= maxBytes) return trimmed;
  return (
    buffer.subarray(0, maxBytes).toString("utf8").trimEnd() + "\n[...truncated]"
  );
}

function buildPresentationHeader(
  likelySkills: string[],
  projectFacts: ProjectFact[],
  state: SessionPresentationState,
): string[] {
  const lines = [
    "## Vercel context ready",
    state === "body-selected"
      ? "High-confidence project signals detected. One foundational guide is loaded now."
      : state === "summary-only"
        ? "High-confidence project signals detected. Summaries are ready now; fuller guidance loads on first touch."
        : "Fresh project detected. Start building immediately.",
    `Skills in play: ${formatSkillTags(likelySkills)}`,
  ];

  const factTags = formatProjectFactTags(projectFacts);
  if (factTags) {
    lines.push(`Project facts: ${factTags}`);
  }

  return lines;
}

function buildPresentationFooter(state: SessionPresentationState): string[] {
  if (state === "greenfield") {
    return [
      "### Next best move",
      "- Start with real tool calls.",
      "- Prefer sensible defaults.",
      "- Use non-interactive scaffolding commands (`--yes`) where available.",
      "- Only ask follow-up questions for credentials or irreversible decisions.",
    ];
  }

  if (state === "body-selected") {
    return [
      "### What happens next",
      "- Keep moving. Matching files and prompts will pull in more guidance automatically.",
    ];
  }

  return [
    "### What happens next",
    "- The plugin will load fuller guidance automatically when you touch matching files or prompts.",
  ];
}

// ---------------------------------------------------------------------------
// Tier block builders
// ---------------------------------------------------------------------------

function buildTier1Block(
  likelySkills: string[],
  projectFacts: ProjectFact[],
  skillEntries: SessionStartSkillEntry[],
): string {
  const teaserLines = buildSummaryTeasers(skillEntries, 2);
  const lines: string[] = [
    `<!-- vercel-plugin:session-start tier="1" state="summary-only" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, "summary-only"),
    "",
    "### Ready now",
    ...(teaserLines.length > 0
      ? teaserLines
      : [
          "- Matching skills were detected, but no startup summaries were available.",
        ]),
    "",
    ...buildPresentationFooter("summary-only"),
    `<!-- /vercel-plugin:session-start -->`,
  ];
  return lines.join("\n");
}

function buildTier2Block(
  likelySkills: string[],
  projectFacts: ProjectFact[],
  skillEntries: SessionStartSkillEntry[],
): string {
  const teaserLines = buildSummaryTeasers(skillEntries, 3);
  const lines: string[] = [
    `<!-- vercel-plugin:session-start tier="2" state="summary-only" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, "summary-only"),
    "",
    "### Ready now",
    ...(teaserLines.length > 0
      ? teaserLines
      : [
          "- Matching skills were detected, but no startup summaries were available.",
        ]),
    "",
    ...buildPresentationFooter("summary-only"),
    `<!-- /vercel-plugin:session-start -->`,
  ];
  return lines.join("\n");
}

export function buildTier3Block(
  likelySkills: string[],
  projectFacts: ProjectFact[],
  skillEntries: SessionStartSkillEntry[],
): string {
  const bodyCandidate = selectBodyCandidate(skillEntries);
  const state: SessionPresentationState = bodyCandidate
    ? "body-selected"
    : "summary-only";

  const lines: string[] = [
    `<!-- vercel-plugin:session-start tier="3" state="${state}" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, state),
    "",
  ];

  const teaserLines = buildSummaryTeasers(
    skillEntries,
    bodyCandidate ? 2 : 4,
  );
  if (teaserLines.length > 0) {
    lines.push(
      bodyCandidate ? "### Also relevant" : "### Ready now",
      ...teaserLines,
      "",
    );
  }

  if (bodyCandidate) {
    log.summary("session-start-engine-context:body-selected", {
      skill: bodyCandidate.skill,
      bodySource: bodyCandidate.bodySource,
      bodyBytes: Buffer.byteLength(bodyCandidate.body!, "utf8"),
    });
    lines.push(
      "### Loaded now",
      `- \`${bodyCandidate.skill}\` from ${bodyCandidate.bodySource ?? "unknown-source"}`,
      "",
      trimBodyPreview(bodyCandidate.body!),
      "",
    );
  } else {
    log.summary("session-start-engine-context:no-body-selected", {
      eligibleSkills: presentableSkillEntries(skillEntries)
        .filter((entry) => entry.sessionStartEligible !== "none")
        .map((entry) => ({
          skill: entry.skill,
          sessionStartEligible: entry.sessionStartEligible,
          summarySource: entry.summarySource,
          bodySource: entry.bodySource,
        })),
    });
    lines.push(
      "### Full guide not loaded yet",
      "- No cached skill body was selected for startup preview.",
      "- That is okay: the plugin will still inject the right guide when you open matching files.",
      "",
    );
  }

  lines.push(...buildPresentationFooter(state));
  lines.push(`<!-- /vercel-plugin:session-start -->`);
  return lines.join("\n");
}

function buildGreenfieldBlock(
  likelySkills: string[],
  projectFacts: ProjectFact[],
): string {
  const lines: string[] = [
    `<!-- vercel-plugin:session-start tier="0" state="greenfield" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, "greenfield"),
    "",
    "### Starter posture",
    "- Do not stop in planning mode.",
    "- Pick sensible defaults and execute immediately.",
    "- Use real tool calls instead of read-only analysis.",
    "- Only ask follow-up questions for credentials or irreversible product choices.",
    "",
    ...buildPresentationFooter("greenfield"),
    `<!-- /vercel-plugin:session-start -->`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Presentation state logging
// ---------------------------------------------------------------------------

function logPresentationState(args: {
  tier: number;
  likelySkills: string[];
  projectFacts: ProjectFact[];
  skillEntries: SessionStartSkillEntry[];
  emittedText: string;
}): void {
  const bodyCandidate = selectBodyCandidate(args.skillEntries);
  const state: SessionPresentationState =
    args.projectFacts.includes("greenfield") && args.tier === 0
      ? "greenfield"
      : bodyCandidate
        ? "body-selected"
        : "summary-only";

  log.summary("session-start-engine-context:presentation-state", {
    tier: args.tier,
    state,
    likelySkills: args.likelySkills,
    projectFacts: args.projectFacts,
    displayedSkillCount: presentableSkillEntries(args.skillEntries).length,
    selectedBodySkill: bodyCandidate?.skill ?? null,
    emittedBytes: Buffer.byteLength(args.emittedText, "utf8"),
  });
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
        log.summary("session-start-engine-context:greenfield-rendered", {
          tier,
          isGreenfield,
          likelySkills,
          projectFacts,
        });
        parts.push(buildGreenfieldBlock(likelySkills, projectFacts));
      }
    } else {
      if (tier === 1) {
        parts.push(buildTier1Block(likelySkills, projectFacts, skillEntries));
      } else if (tier === 2) {
        parts.push(buildTier2Block(likelySkills, projectFacts, skillEntries));
      } else {
        parts.push(buildTier3Block(likelySkills, projectFacts, skillEntries));
      }
    }

    if (parts.length === 0) return;

    const output = parts.join("\n\n");

    log.summary("session-start-engine-context:assembled", {
      tier,
      likelySkills,
      projectFacts,
      skillEntries: skillEntries.map((entry) => ({
        skill: entry.skill,
        eligible: entry.sessionStartEligible,
        summarySource: entry.summarySource,
        bodySource: entry.bodySource,
      })),
      emittedBytes: Buffer.byteLength(output, "utf8"),
    });

    logPresentationState({
      tier,
      likelySkills,
      projectFacts,
      skillEntries,
      emittedText: output,
    });

    process.stdout.write(output);
  } catch (error) {
    logCaughtError(log, "session-start-engine-context:main-crash", error, {});
  }
}

const ENTRYPOINT = fileURLToPath(import.meta.url);
const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === ENTRYPOINT : false;

if (isEntrypoint) {
  main();
}
