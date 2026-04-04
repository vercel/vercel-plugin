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
  profileCachePath,
  readSessionFile,
  safeReadJson,
  writeSessionFile,
} from "./hook-env.mjs";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";
import {
  type DetectionReason,
  type SkillDetection,
} from "./orchestrator-install-plan.mjs";
import {
  type ProfileNextAction,
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
// Profile cache loading
// ---------------------------------------------------------------------------

interface CachedDetectionReason {
  kind: DetectionReason["kind"] | "greenfield" | "profiler-default";
  source: string;
  detail: string;
}

interface CachedSkillDetection {
  skill: string;
  reasons: CachedDetectionReason[];
}

interface ProfileCache {
  projectRoot: string;
  likelySkills: string[];
  detections?: CachedSkillDetection[];
  projectFacts?: ProjectFact[];
  nextActions?: ProfileNextAction[];
  greenfield: boolean;
  installedSkills?: string[];
  missingSkills?: string[];
  zeroBundleReady?: boolean;
  projectSkillManifestPath?: string | null;
  bootstrapHints: string[];
  resourceHints: string[];
  setupMode: boolean;
  agentBrowserAvailable: boolean;
  timestamp: string;
}

interface SessionProfileSnapshot {
  projectRoot: string;
  likelySkills: string[];
  detections: SkillDetection[];
  projectFacts: ProjectFact[];
  nextActions: ProfileNextAction[];
  greenfield: boolean;
}

function loadSessionProfileSnapshot(
  sessionId: string | null,
  fallbackProjectRoot: string,
): SessionProfileSnapshot {
  const cached = sessionId
    ? safeReadJson<ProfileCache>(profileCachePath(sessionId))
    : null;

  const projectRoot =
    typeof cached?.projectRoot === "string" && cached.projectRoot.trim() !== ""
      ? cached.projectRoot
      : fallbackProjectRoot;

  const likelySkills =
    Array.isArray(cached?.likelySkills) && cached!.likelySkills.length > 0
      ? [...new Set(cached!.likelySkills.map((s) => s.trim()).filter(Boolean))]
      : (
          sessionId
            ? readSessionFile(sessionId, "likely-skills")
            : (process.env.VERCEL_PLUGIN_LIKELY_SKILLS ?? "")
        )
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  const greenfield =
    cached?.greenfield === true ||
    (sessionId
      ? readSessionFile(sessionId, "greenfield") === "true"
      : process.env.VERCEL_PLUGIN_GREENFIELD === "true");

  const projectFacts: ProjectFact[] = [];
  if (greenfield) projectFacts.push("greenfield");
  if (Array.isArray(cached?.projectFacts)) {
    for (const fact of cached!.projectFacts) {
      if (fact && !projectFacts.includes(fact)) {
        projectFacts.push(fact);
      }
    }
  }
  const projectFactsRaw = process.env.VERCEL_PLUGIN_PROJECT_FACTS ?? "";
  for (const fact of projectFactsRaw.split(",")) {
    const trimmed = fact.trim() as ProjectFact;
    if (trimmed && !projectFacts.includes(trimmed)) {
      projectFacts.push(trimmed);
    }
  }

  let detections: SkillDetection[];
  if (Array.isArray(cached?.detections) && cached!.detections.length > 0) {
    detections = cached!.detections.map((entry) => ({
      skill: entry.skill,
      reasons: entry.reasons.map((reason) => ({
        kind: reason.kind as DetectionReason["kind"],
        source: reason.source,
        detail: reason.detail,
      })),
    }));
  } else if (greenfield) {
    detections = likelySkills.map((skill) => ({
      skill,
      reasons: [
        {
          kind: "greenfield" as const,
          source: "project-root",
          detail: "greenfield",
        },
      ],
    }));
    log.debug("session-start-engine-context:profile-cache-fallback", {
      sessionId,
      reason: "greenfield_without_cached_detections",
      projectRoot,
    });
  } else {
    detections = profileProjectDetections(projectRoot);
    log.debug("session-start-engine-context:profile-cache-fallback", {
      sessionId,
      reason: "cache_miss",
      projectRoot,
      detectionCount: detections.length,
    });
  }

  const nextActions = normalizeNextActions(cached?.nextActions);

  log.debug("session-start-engine-context:profile-cache", {
    sessionId,
    cacheHit: Boolean(cached?.detections?.length),
    projectRoot,
    likelySkills,
    greenfield,
    detectionCount: detections.length,
    nextActionCount: nextActions.length,
  });

  return { projectRoot, likelySkills, detections, projectFacts, nextActions, greenfield };
}

// ---------------------------------------------------------------------------
// Next-action normalization and Fast Lane rendering
// ---------------------------------------------------------------------------

function normalizeNextActions(raw: unknown): ProfileNextAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object",
    )
    .map((value) => ({
      id: (typeof value.id === "string" ? value.id : "unknown") as ProfileNextAction["id"],
      title: typeof value.title === "string" ? value.title : "",
      reason: typeof value.reason === "string" ? value.reason : "",
      command:
        typeof value.command === "string" && value.command.trim() !== ""
          ? value.command
          : null,
      priority: typeof value.priority === "number" ? value.priority : 0,
    }))
    .filter((value) => value.title !== "")
    .sort((left, right) => right.priority - left.priority);
}

function renderFastLaneBlock(actions: ProfileNextAction[]): string | null {
  if (actions.length === 0) return null;
  return [
    "## Fast Lane",
    ...actions.slice(0, 3).map(
      (action) =>
        `- ${action.title}${action.reason ? ` — ${action.reason}` : ""}${action.command ? ` (\`${action.command}\`)` : ""}`,
    ),
  ].join("\n");
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
  summary: string | null;
  body: string | null;
  source: string;
  sessionStartEligible: SessionStartEligible;
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

    const source = payload?.source ?? "missing";
    const summary = (config.summary ?? "").trim() || null;
    const eligible = resolveSessionStartEligibility(config, body);

    log.debug("session-start-engine-context:skill-entry", {
      projectRoot,
      skill,
      source,
      eligible,
      summaryBytes: summary ? Buffer.byteLength(summary, "utf8") : 0,
      bodyBytes: body ? Buffer.byteLength(body, "utf8") : 0,
    });

    return [
      {
        skill,
        summary,
        body,
        source,
        sessionStartEligible: eligible,
      },
    ];
  });

  log.summary("session-start-engine-context:skill-entry-summary", {
    projectRoot,
    requestedSkills: skills,
    resolvedSkills: entries.map((entry) => ({
      skill: entry.skill,
      source: entry.source,
      eligible: entry.sessionStartEligible,
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
// Unified session-start block builder
// ---------------------------------------------------------------------------

export function buildSessionStartBlock(
  tier: number,
  likelySkills: string[],
  projectFacts: ProjectFact[],
  skillEntries: SessionStartSkillEntry[],
): string {
  const bodyCandidate = tier >= 3 ? selectBodyCandidate(skillEntries) : null;
  const state: SessionPresentationState = bodyCandidate
    ? "body-selected"
    : "summary-only";

  const teaserLimit = bodyCandidate ? 2 : tier <= 1 ? 2 : 3;
  const teaserLines = buildSummaryTeasers(skillEntries, teaserLimit);

  const lines: string[] = [
    `<!-- vercel-plugin:session-start tier="${tier}" state="${state}" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, state),
    "",
  ];

  if (teaserLines.length > 0) {
    lines.push(
      bodyCandidate ? "### Also relevant" : "### Ready now",
      ...teaserLines,
      "",
    );
  } else {
    lines.push(
      "### Ready now",
      "- Matching skills were detected, but no startup summaries were available.",
      "",
    );
  }

  if (bodyCandidate) {
    log.summary("session-start-engine-context:body-selected", {
      skill: bodyCandidate.skill,
      source: bodyCandidate.source,
      bodyBytes: Buffer.byteLength(bodyCandidate.body!, "utf8"),
    });
    lines.push(
      "### Loaded now",
      `- \`${bodyCandidate.skill}\` from ${bodyCandidate.source}`,
      "",
      trimBodyPreview(bodyCandidate.body!),
      "",
    );
  }

  lines.push(...buildPresentationFooter(state));
  lines.push(`<!-- /vercel-plugin:session-start -->`);

  const block = lines.join("\n");
  log.summary("session-start-engine-context:rendered", {
    tier,
    state,
    likelySkills,
    teaserCount: teaserLines.length,
    bodySkill: bodyCandidate?.skill ?? null,
    outputBytes: Buffer.byteLength(block, "utf8"),
  });

  return block;
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
  const bodyCandidate =
    args.tier >= 3 ? selectBodyCandidate(args.skillEntries) : null;
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

    const snapshot = loadSessionProfileSnapshot(sessionId, cwd);
    const { projectRoot, likelySkills, detections, projectFacts, greenfield } =
      snapshot;

    const tier = computeSessionTier(detections, projectFacts);

    if (sessionId) {
      writeSessionFile(sessionId, "session-tier", String(tier));
    }

    const skillEntries =
      tier > 0
        ? resolveSessionStartSkillEntries(projectRoot, likelySkills)
        : [];

    const parts: string[] = [];

    // Fast Lane: render cached next-actions near the top of the context
    const fastLaneBlock = renderFastLaneBlock(snapshot.nextActions);
    if (fastLaneBlock) {
      parts.push(fastLaneBlock);
      log.debug("session-start-engine-context:fast-lane-rendered", {
        sessionId,
        actionCount: snapshot.nextActions.length,
        actions: snapshot.nextActions.map((action) => ({
          id: action.id,
          priority: action.priority,
          command: action.command,
        })),
      });
    }

    if (tier === 0) {
      if (greenfield) {
        parts.push(buildGreenfieldBlock(likelySkills, projectFacts));
      }
    } else {
      parts.push(
        buildSessionStartBlock(tier, likelySkills, projectFacts, skillEntries),
      );
      if (greenfield) {
        parts.push(buildGreenfieldBlock(likelySkills, projectFacts));
      }
    }

    if (parts.length === 0) return;

    const output = parts.join("\n\n");

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
