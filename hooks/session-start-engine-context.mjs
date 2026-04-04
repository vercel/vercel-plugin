#!/usr/bin/env node

// hooks/src/session-start-engine-context.mts
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import {
  pluginRoot,
  profileCachePath,
  readSessionFile,
  safeReadJson,
  writeSessionFile
} from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  profileProjectDetections
} from "./session-start-profiler.mjs";
import { createSkillStore } from "./skill-store.mjs";
var log = createLogger();
function loadSessionProfileSnapshot(sessionId, fallbackProjectRoot) {
  const cached = sessionId ? safeReadJson(profileCachePath(sessionId)) : null;
  const projectRoot = typeof cached?.projectRoot === "string" && cached.projectRoot.trim() !== "" ? cached.projectRoot : fallbackProjectRoot;
  const likelySkills = Array.isArray(cached?.likelySkills) && cached.likelySkills.length > 0 ? [...new Set(cached.likelySkills.map((s) => s.trim()).filter(Boolean))] : (sessionId ? readSessionFile(sessionId, "likely-skills") : process.env.VERCEL_PLUGIN_LIKELY_SKILLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const greenfield = cached?.greenfield === true || (sessionId ? readSessionFile(sessionId, "greenfield") === "true" : process.env.VERCEL_PLUGIN_GREENFIELD === "true");
  const projectFacts = [];
  if (greenfield) projectFacts.push("greenfield");
  if (Array.isArray(cached?.projectFacts)) {
    for (const fact of cached.projectFacts) {
      if (fact && !projectFacts.includes(fact)) {
        projectFacts.push(fact);
      }
    }
  }
  const projectFactsRaw = process.env.VERCEL_PLUGIN_PROJECT_FACTS ?? "";
  for (const fact of projectFactsRaw.split(",")) {
    const trimmed = fact.trim();
    if (trimmed && !projectFacts.includes(trimmed)) {
      projectFacts.push(trimmed);
    }
  }
  let detections;
  if (Array.isArray(cached?.detections) && cached.detections.length > 0) {
    detections = cached.detections.map((entry) => ({
      skill: entry.skill,
      reasons: entry.reasons.map((reason) => ({
        kind: reason.kind,
        source: reason.source,
        detail: reason.detail
      }))
    }));
  } else if (greenfield) {
    detections = likelySkills.map((skill) => ({
      skill,
      reasons: [
        {
          kind: "greenfield",
          source: "project-root",
          detail: "greenfield"
        }
      ]
    }));
    log.debug("session-start-engine-context:profile-cache-fallback", {
      sessionId,
      reason: "greenfield_without_cached_detections",
      projectRoot
    });
  } else {
    detections = profileProjectDetections(projectRoot);
    log.debug("session-start-engine-context:profile-cache-fallback", {
      sessionId,
      reason: "cache_miss",
      projectRoot,
      detectionCount: detections.length
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
    nextActionCount: nextActions.length
  });
  return { projectRoot, likelySkills, detections, projectFacts, nextActions, greenfield };
}
function normalizeNextActions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value) => Boolean(value) && typeof value === "object"
  ).map((value) => ({
    id: typeof value.id === "string" ? value.id : "unknown",
    title: typeof value.title === "string" ? value.title : "",
    reason: typeof value.reason === "string" ? value.reason : "",
    command: typeof value.command === "string" && value.command.trim() !== "" ? value.command : null,
    priority: typeof value.priority === "number" ? value.priority : 0
  })).filter((value) => value.title !== "").sort((left, right) => right.priority - left.priority);
}
function renderFastLaneBlock(actions) {
  if (actions.length === 0) return null;
  return [
    "## Fast Lane",
    ...actions.slice(0, 3).map(
      (action) => `- ${action.title}${action.reason ? ` \u2014 ${action.reason}` : ""}${action.command ? ` (\`${action.command}\`)` : ""}`
    )
  ].join("\n");
}
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
function resolveSessionStartEligibility(config, body) {
  if (config.sessionStartEligible === "body" || config.sessionStartEligible === "summary" || config.sessionStartEligible === "none") {
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
function resolveSessionStartSkillEntries(projectRoot, skills) {
  if (skills.length === 0) {
    return [];
  }
  const store = createSkillStore({
    projectRoot,
    pluginRoot: pluginRoot(),
    includeRulesManifest: process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1"
  });
  const loaded = store.loadSkillSet(log);
  if (!loaded) {
    log.debug("session-start-engine-context:no-skill-store-data", {
      projectRoot,
      requestedSkills: skills
    });
    return [];
  }
  const entries = skills.flatMap((skill) => {
    const config = loaded.skillMap[skill];
    if (!config) {
      return [];
    }
    const payload = store.resolveSkillPayload(skill, log);
    const body = payload?.mode === "body" && payload.body ? payload.body.trim() : null;
    const source = payload?.source ?? "missing";
    const summary = (config.summary ?? "").trim() || null;
    const eligible = resolveSessionStartEligibility(config, body);
    log.debug("session-start-engine-context:skill-entry", {
      projectRoot,
      skill,
      source,
      eligible,
      summaryBytes: summary ? Buffer.byteLength(summary, "utf8") : 0,
      bodyBytes: body ? Buffer.byteLength(body, "utf8") : 0
    });
    return [
      {
        skill,
        summary,
        body,
        source,
        sessionStartEligible: eligible
      }
    ];
  });
  log.summary("session-start-engine-context:skill-entry-summary", {
    projectRoot,
    requestedSkills: skills,
    resolvedSkills: entries.map((entry) => ({
      skill: entry.skill,
      source: entry.source,
      eligible: entry.sessionStartEligible
    }))
  });
  return entries;
}
function presentableSkillEntries(skillEntries) {
  return skillEntries.filter(
    (entry) => entry !== null
  );
}
function formatSkillTags(skills) {
  return skills.length === 0 ? "_none_" : skills.map((skill) => `\`${skill}\``).join(" ");
}
function formatProjectFactTags(projectFacts) {
  return projectFacts.length === 0 ? null : projectFacts.map((fact) => `\`${fact}\``).join(" ");
}
function selectBodyCandidate(skillEntries) {
  return presentableSkillEntries(skillEntries).find(
    (entry) => entry.sessionStartEligible === "body" && entry.body !== null && entry.body.trim() !== ""
  ) ?? null;
}
function buildSummaryTeasers(skillEntries, limit = 3) {
  return presentableSkillEntries(skillEntries).filter((entry) => entry.summary !== null && entry.summary.trim() !== "").slice(0, limit).map((entry) => `- \`${entry.skill}\` \u2014 ${entry.summary.trim()}`);
}
function trimBodyPreview(body, maxBytes = 2200) {
  const trimmed = body.trim();
  const buffer = Buffer.from(trimmed, "utf8");
  if (buffer.byteLength <= maxBytes) return trimmed;
  return buffer.subarray(0, maxBytes).toString("utf8").trimEnd() + "\n[...truncated]";
}
function buildPresentationHeader(likelySkills, projectFacts, state) {
  const lines = [
    "## Vercel context ready",
    state === "body-selected" ? "High-confidence project signals detected. One foundational guide is loaded now." : state === "summary-only" ? "High-confidence project signals detected. Summaries are ready now; fuller guidance loads on first touch." : "Fresh project detected. Start building immediately.",
    `Skills in play: ${formatSkillTags(likelySkills)}`
  ];
  const factTags = formatProjectFactTags(projectFacts);
  if (factTags) {
    lines.push(`Project facts: ${factTags}`);
  }
  return lines;
}
function buildPresentationFooter(state) {
  if (state === "greenfield") {
    return [
      "### Next best move",
      "- Start with real tool calls.",
      "- Prefer sensible defaults.",
      "- Use non-interactive scaffolding commands (`--yes`) where available.",
      "- Only ask follow-up questions for credentials or irreversible decisions."
    ];
  }
  if (state === "body-selected") {
    return [
      "### What happens next",
      "- Keep moving. Matching files and prompts will pull in more guidance automatically."
    ];
  }
  return [
    "### What happens next",
    "- The plugin will load fuller guidance automatically when you touch matching files or prompts."
  ];
}
function buildSessionStartBlock(tier, likelySkills, projectFacts, skillEntries) {
  const bodyCandidate = tier >= 3 ? selectBodyCandidate(skillEntries) : null;
  const state = bodyCandidate ? "body-selected" : "summary-only";
  const teaserLimit = bodyCandidate ? 2 : tier <= 1 ? 2 : 3;
  const teaserLines = buildSummaryTeasers(skillEntries, teaserLimit);
  const lines = [
    `<!-- vercel-plugin:session-start tier="${tier}" state="${state}" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, state),
    ""
  ];
  if (teaserLines.length > 0) {
    lines.push(
      bodyCandidate ? "### Also relevant" : "### Ready now",
      ...teaserLines,
      ""
    );
  } else {
    lines.push(
      "### Ready now",
      "- Matching skills were detected, but no startup summaries were available.",
      ""
    );
  }
  if (bodyCandidate) {
    log.summary("session-start-engine-context:body-selected", {
      skill: bodyCandidate.skill,
      source: bodyCandidate.source,
      bodyBytes: Buffer.byteLength(bodyCandidate.body, "utf8")
    });
    lines.push(
      "### Loaded now",
      `- \`${bodyCandidate.skill}\` from ${bodyCandidate.source}`,
      "",
      trimBodyPreview(bodyCandidate.body),
      ""
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
    outputBytes: Buffer.byteLength(block, "utf8")
  });
  return block;
}
function buildGreenfieldBlock(likelySkills, projectFacts) {
  const lines = [
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
    `<!-- /vercel-plugin:session-start -->`
  ];
  return lines.join("\n");
}
function logPresentationState(args) {
  const bodyCandidate = args.tier >= 3 ? selectBodyCandidate(args.skillEntries) : null;
  const state = args.projectFacts.includes("greenfield") && args.tier === 0 ? "greenfield" : bodyCandidate ? "body-selected" : "summary-only";
  log.summary("session-start-engine-context:presentation-state", {
    tier: args.tier,
    state,
    likelySkills: args.likelySkills,
    projectFacts: args.projectFacts,
    displayedSkillCount: presentableSkillEntries(args.skillEntries).length,
    selectedBodySkill: bodyCandidate?.skill ?? null,
    emittedBytes: Buffer.byteLength(args.emittedText, "utf8")
  });
}
function parseInput(raw) {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function main() {
  try {
    const input = parseInput(readFileSync(0, "utf8"));
    const sessionId = input?.session_id ?? null;
    const cwd = process.cwd();
    const snapshot = loadSessionProfileSnapshot(sessionId, cwd);
    const { projectRoot, likelySkills, detections, projectFacts, greenfield } = snapshot;
    const tier = computeSessionTier(detections, projectFacts);
    if (sessionId) {
      writeSessionFile(sessionId, "session-tier", String(tier));
    }
    const skillEntries = tier > 0 ? resolveSessionStartSkillEntries(projectRoot, likelySkills) : [];
    const parts = [];
    const fastLaneBlock = renderFastLaneBlock(snapshot.nextActions);
    if (fastLaneBlock) {
      parts.push(fastLaneBlock);
      log.debug("session-start-engine-context:fast-lane-rendered", {
        sessionId,
        actionCount: snapshot.nextActions.length,
        actionIds: snapshot.nextActions.map((action) => action.id)
      });
    }
    if (tier === 0) {
      if (greenfield) {
        parts.push(buildGreenfieldBlock(likelySkills, projectFacts));
      }
    } else {
      parts.push(
        buildSessionStartBlock(tier, likelySkills, projectFacts, skillEntries)
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
      emittedText: output
    });
    process.stdout.write(output);
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
  buildSessionStartBlock,
  computeSessionTier,
  resolveSessionStartSkillEntries
};
