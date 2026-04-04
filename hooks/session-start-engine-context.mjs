#!/usr/bin/env node

// hooks/src/session-start-engine-context.mts
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import {
  pluginRoot,
  readSessionFile,
  writeSessionFile
} from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import {
  profileProjectDetections
} from "./session-start-profiler.mjs";
import { createSkillStore } from "./skill-store.mjs";
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
    return [
      {
        skill,
        summary: (config.summary ?? "").trim(),
        summarySource: loaded.origins[skill]?.source ?? "unknown",
        sessionStartEligible: resolveSessionStartEligibility(config, body),
        body,
        bodySource: body ? payload?.source ?? null : null
      }
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
      bodySource: entry.bodySource
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
function buildTier1Block(likelySkills, projectFacts, skillEntries) {
  const teaserLines = buildSummaryTeasers(skillEntries, 2);
  const lines = [
    `<!-- vercel-plugin:session-start tier="1" state="summary-only" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, "summary-only"),
    "",
    "### Ready now",
    ...teaserLines.length > 0 ? teaserLines : [
      "- Matching skills were detected, but no startup summaries were available."
    ],
    "",
    ...buildPresentationFooter("summary-only"),
    `<!-- /vercel-plugin:session-start -->`
  ];
  return lines.join("\n");
}
function buildTier2Block(likelySkills, projectFacts, skillEntries) {
  const teaserLines = buildSummaryTeasers(skillEntries, 3);
  const lines = [
    `<!-- vercel-plugin:session-start tier="2" state="summary-only" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, "summary-only"),
    "",
    "### Ready now",
    ...teaserLines.length > 0 ? teaserLines : [
      "- Matching skills were detected, but no startup summaries were available."
    ],
    "",
    ...buildPresentationFooter("summary-only"),
    `<!-- /vercel-plugin:session-start -->`
  ];
  return lines.join("\n");
}
function buildTier3Block(likelySkills, projectFacts, skillEntries) {
  const bodyCandidate = selectBodyCandidate(skillEntries);
  const state = bodyCandidate ? "body-selected" : "summary-only";
  const lines = [
    `<!-- vercel-plugin:session-start tier="3" state="${state}" -->`,
    ...buildPresentationHeader(likelySkills, projectFacts, state),
    ""
  ];
  const teaserLines = buildSummaryTeasers(
    skillEntries,
    bodyCandidate ? 2 : 4
  );
  if (teaserLines.length > 0) {
    lines.push(
      bodyCandidate ? "### Also relevant" : "### Ready now",
      ...teaserLines,
      ""
    );
  }
  if (bodyCandidate) {
    log.summary("session-start-engine-context:body-selected", {
      skill: bodyCandidate.skill,
      bodySource: bodyCandidate.bodySource,
      bodyBytes: Buffer.byteLength(bodyCandidate.body, "utf8")
    });
    lines.push(
      "### Loaded now",
      `- \`${bodyCandidate.skill}\` from ${bodyCandidate.bodySource ?? "unknown-source"}`,
      "",
      trimBodyPreview(bodyCandidate.body),
      ""
    );
  } else {
    log.summary("session-start-engine-context:no-body-selected", {
      eligibleSkills: presentableSkillEntries(skillEntries).filter((entry) => entry.sessionStartEligible !== "none").map((entry) => ({
        skill: entry.skill,
        sessionStartEligible: entry.sessionStartEligible,
        summarySource: entry.summarySource,
        bodySource: entry.bodySource
      }))
    });
    lines.push(
      "### Full guide not loaded yet",
      "- No cached skill body was selected for startup preview.",
      "- That is okay: the plugin will still inject the right guide when you open matching files.",
      ""
    );
  }
  lines.push(...buildPresentationFooter(state));
  lines.push(`<!-- /vercel-plugin:session-start -->`);
  return lines.join("\n");
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
  const bodyCandidate = selectBodyCandidate(args.skillEntries);
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
    const skillEntries = resolveSessionStartSkillEntries(cwd, likelySkills);
    const parts = [];
    if (tier === 0) {
      if (isGreenfield) {
        log.summary("session-start-engine-context:greenfield-rendered", {
          tier,
          isGreenfield,
          likelySkills,
          projectFacts
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
        bodySource: entry.bodySource
      })),
      emittedBytes: Buffer.byteLength(output, "utf8")
    });
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
  buildTier3Block,
  computeSessionTier,
  resolveSessionStartSkillEntries
};
