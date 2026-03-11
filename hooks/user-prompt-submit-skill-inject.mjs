#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAuditLog,
  listSessionKeys,
  pluginRoot as resolvePluginRoot,
  readSessionFile,
  syncSessionFileFromClaims,
  tryClaimSessionKey,
  writeSessionFile
} from "./hook-env.mjs";
import { loadSkills, injectSkills } from "./pretooluse-skill-inject.mjs";
import { parseSeenSkills, mergeSeenSkillStates, buildDocsBlock } from "./patterns.mjs";
import { normalizePromptText, compilePromptSignals, matchPromptWithReason, scorePromptWithLexical, classifyTroubleshootingIntent } from "./prompt-patterns.mjs";
import { searchSkills, initializeLexicalIndex } from "./lexical-index.mjs";
import { analyzePrompt } from "./prompt-analysis.mjs";
import { createLogger, logDecision } from "./logger.mjs";
import { isTelemetryEnabled, trackEvents } from "./telemetry.mjs";
const MAX_SKILLS = 2;
const DEFAULT_INJECTION_BUDGET_BYTES = 8e3;
const MIN_PROMPT_LENGTH = 10;
const PLUGIN_ROOT = resolvePluginRoot();
const SKILL_INJECTION_VERSION = 1;
const INVESTIGATION_COMPANION_SKILLS = [
  "workflow",
  "agent-browser-verify",
  "vercel-cli"
];
const log = createLogger();
function getSeenSkillsEnv() {
  return typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string" ? process.env.VERCEL_PLUGIN_SEEN_SKILLS : "";
}
function getInjectionBudget() {
  const envVal = process.env.VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET;
  if (envVal != null && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INJECTION_BUDGET_BYTES;
}
function resolvePromptSeenSkillState(sessionId) {
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasFileDedup = !dedupOff && !!sessionId;
  const seenEnv = typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string" ? process.env.VERCEL_PLUGIN_SEEN_SKILLS : "";
  const seenClaims = hasFileDedup ? listSessionKeys(sessionId, "seen-skills").join(",") : "";
  const seenFile = hasFileDedup ? readSessionFile(sessionId, "seen-skills") : "";
  const seenState = hasFileDedup ? mergeSeenSkillStates(seenEnv, seenFile, seenClaims) : seenEnv;
  if (!dedupOff) {
    process.env.VERCEL_PLUGIN_SEEN_SKILLS = seenState;
  }
  if (hasFileDedup) {
    writeSessionFile(sessionId, "seen-skills", seenState);
  }
  return {
    dedupOff,
    hasFileDedup,
    hasEnvDedup: !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string",
    seenEnv,
    seenClaims,
    seenFile,
    seenState
  };
}
function syncPromptSeenSkillClaims(sessionId, loadedSkills) {
  for (const skill of loadedSkills) {
    tryClaimSessionKey(sessionId, "seen-skills", skill);
  }
  const synced = syncSessionFileFromClaims(sessionId, "seen-skills");
  process.env.VERCEL_PLUGIN_SEEN_SKILLS = mergeSeenSkillStates(
    process.env.VERCEL_PLUGIN_SEEN_SKILLS || "",
    synced
  );
  return synced;
}
function parsePromptInput(raw, logger) {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    l.debug("stdin-empty", {});
    return null;
  }
  let input;
  try {
    input = JSON.parse(trimmed);
  } catch (err) {
    l.issue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON", { error: String(err) });
    return null;
  }
  const prompt = input.prompt || "";
  const sessionId = input.session_id || process.env.SESSION_ID || null;
  const cwdCandidate = input.cwd ?? input.working_directory;
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : null;
  if (prompt.length < MIN_PROMPT_LENGTH) {
    l.debug("prompt-too-short", { length: prompt.length, min: MIN_PROMPT_LENGTH });
    return null;
  }
  l.debug("input-parsed", { promptLength: prompt.length, sessionId });
  return { prompt, sessionId, cwd };
}
function matchPromptSignals(normalizedPrompt, skills, logger, options) {
  const l = logger || log;
  const lexical = options?.lexical ?? false;
  const { skillMap } = skills;
  const matches = [];
  const lexicalHits = lexical ? searchSkills(normalizedPrompt) : void 0;
  for (const [skill, config] of Object.entries(skillMap)) {
    if (!config.promptSignals) continue;
    const compiled = compilePromptSignals(config.promptSignals);
    if (lexical) {
      const lexResult = scorePromptWithLexical(normalizedPrompt, skill, compiled, lexicalHits);
      const isMatched = lexResult.score >= compiled.minScore;
      const reason = lexResult.source === "exact" ? matchPromptWithReason(normalizedPrompt, compiled).reason : `${matchPromptWithReason(normalizedPrompt, compiled).reason}; lexical ${lexResult.source} (score ${lexResult.lexicalScore.toFixed(1)}, tier ${lexResult.boostTier ?? "none"})`;
      l.trace("prompt-signal-eval", {
        skill,
        matched: isMatched,
        score: lexResult.score,
        reason,
        source: lexResult.source,
        boostTier: lexResult.boostTier
      });
      if (isMatched) {
        matches.push({
          skill,
          score: lexResult.score,
          reason,
          priority: config.priority
        });
      }
    } else {
      const result = matchPromptWithReason(normalizedPrompt, compiled);
      l.trace("prompt-signal-eval", {
        skill,
        matched: result.matched,
        score: result.score,
        reason: result.reason
      });
      if (result.matched) {
        matches.push({
          skill,
          score: result.score,
          reason: result.reason,
          priority: config.priority
        });
      }
    }
  }
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.skill.localeCompare(b.skill);
  });
  l.debug("prompt-matches", {
    totalWithSignals: Object.values(skillMap).filter((c) => c.promptSignals).length,
    matched: matches.map((m) => ({ skill: m.skill, score: m.score })),
    lexical
  });
  return matches;
}
function selectInvestigationCompanion(selectedSkills, perSkillResults) {
  if (!selectedSkills.includes("investigation-mode")) {
    return { companion: null, reason: "investigation-mode not selected" };
  }
  let bestCompanion = null;
  let bestScore = -Infinity;
  for (const candidate of INVESTIGATION_COMPANION_SKILLS) {
    const result = perSkillResults[candidate];
    if (result && result.matched && result.score > bestScore) {
      bestScore = result.score;
      bestCompanion = candidate;
    }
  }
  if (!bestCompanion) {
    return { companion: null, reason: "no companion scored high enough" };
  }
  return {
    companion: bestCompanion,
    reason: `companion "${bestCompanion}" scored ${bestScore}`
  };
}
function deduplicateAndInject(matches, skills, logger) {
  const l = logger || log;
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const seenEnv = getSeenSkillsEnv();
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const injectedSkills = hasEnvDedup ? parseSeenSkills(seenEnv) : /* @__PURE__ */ new Set();
  const budget = getInjectionBudget();
  const allMatched = matches.map((m) => m.skill);
  const newMatches = dedupOff ? matches : matches.filter((m) => !injectedSkills.has(m.skill));
  if (newMatches.length === 0) {
    l.debug("all-prompt-matches-deduped", { matched: allMatched, seen: [...injectedSkills] });
    return { parts: [], loaded: [], summaryOnly: [], droppedByCap: [], droppedByBudget: [], matchedSkills: allMatched };
  }
  const rankedSkills = newMatches.slice(0, MAX_SKILLS).map((m) => m.skill);
  const droppedByCap = newMatches.slice(MAX_SKILLS).map((m) => m.skill);
  l.debug("prompt-dedup", {
    rankedSkills,
    droppedByCap,
    previouslyInjected: [...injectedSkills]
  });
  const result = injectSkills(rankedSkills, {
    pluginRoot: PLUGIN_ROOT,
    hasEnvDedup,
    injectedSkills,
    budgetBytes: budget,
    maxSkills: MAX_SKILLS,
    skillMap: skills.skillMap,
    logger: l
  });
  return {
    ...result,
    droppedByCap: [...result.droppedByCap, ...droppedByCap],
    matchedSkills: allMatched
  };
}
function formatOutput(parts, matchedSkills, injectedSkills, summaryOnly, droppedByCap, droppedByBudget, promptMatchReasons, skillMap) {
  if (parts.length === 0) {
    return "{}";
  }
  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    hookEvent: "UserPromptSubmit",
    matchedSkills,
    injectedSkills,
    summaryOnly,
    droppedByCap,
    droppedByBudget
  };
  const metaComment = `<!-- skillInjection: ${JSON.stringify(skillInjection)} -->`;
  const bannerLines = ["[vercel-plugin] Best practices auto-suggested based on prompt analysis:"];
  for (const skill of injectedSkills) {
    const reason = promptMatchReasons?.[skill];
    if (reason) {
      bannerLines.push(`  - "${skill}" matched: ${reason}`);
    } else {
      bannerLines.push(`  - "${skill}"`);
    }
  }
  const banner = bannerLines.join("\n");
  const docsBlock = buildDocsBlock(injectedSkills, skillMap);
  const sections = [banner];
  if (docsBlock) sections.push(docsBlock);
  sections.push(parts.join("\n\n"));
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: sections.join("\n\n") + "\n" + metaComment
    }
  };
  return JSON.stringify(output);
}
function run() {
  const timing = {};
  const tPhase = log.active ? log.now() : 0;
  let raw;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
  const parsed = parsePromptInput(raw, log);
  if (!parsed) return "{}";
  if (log.active) timing.stdin_parse = Math.round(log.now() - tPhase);
  const { prompt, sessionId, cwd } = parsed;
  if (isTelemetryEnabled() && sessionId) {
    trackEvents(sessionId, [
      { key: "prompt:text", value: prompt }
    ]).catch(() => {
    });
  }
  const normalizedPrompt = normalizePromptText(prompt);
  if (!normalizedPrompt) {
    log.debug("normalized-prompt-empty", {});
    return "{}";
  }
  const tSkillmap = log.active ? log.now() : 0;
  const skills = loadSkills(PLUGIN_ROOT, log);
  if (!skills) return "{}";
  if (log.active) timing.skillmap_load = Math.round(log.now() - tSkillmap);
  const tAnalyze = log.active ? log.now() : 0;
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasFileDedup = !dedupOff && !!sessionId;
  const seenEnv = typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string" ? process.env.VERCEL_PLUGIN_SEEN_SKILLS : "";
  const seenClaims = hasFileDedup ? listSessionKeys(sessionId, "seen-skills").join(",") : "";
  const seenFile = hasFileDedup ? readSessionFile(sessionId, "seen-skills") : "";
  const seenState = hasFileDedup ? mergeSeenSkillStates(seenEnv, seenFile, seenClaims) : seenEnv;
  if (!dedupOff) {
    process.env.VERCEL_PLUGIN_SEEN_SKILLS = seenState;
  }
  if (hasFileDedup) {
    writeSessionFile(sessionId, "seen-skills", seenState);
  }
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const budget = getInjectionBudget();
  const lexicalEnabled = process.env.VERCEL_PLUGIN_LEXICAL_PROMPT === "1";
  if (lexicalEnabled) {
    initializeLexicalIndex(new Map(Object.entries(skills.skillMap)));
  }
  const report = analyzePrompt(prompt, skills.skillMap, seenState, budget, MAX_SKILLS, { lexicalEnabled });
  if (log.active) timing.analyze = Math.round(log.now() - tAnalyze);
  log.trace("prompt-analysis-full", report);
  for (const [skill, r] of Object.entries(report.perSkillResults)) {
    log.debug("prompt-signal-eval", {
      skill,
      score: r.score,
      reason: r.reason,
      matched: r.matched,
      suppressed: r.suppressed
    });
  }
  log.debug("prompt-selection", {
    selectedSkills: report.selectedSkills,
    droppedByCap: report.droppedByCap,
    droppedByBudget: report.droppedByBudget,
    dedupStrategy: report.dedupState.strategy,
    filteredByDedup: report.dedupState.filteredByDedup,
    budgetBytes: report.budgetBytes,
    timingMs: report.timingMs
  });
  const intentResult = classifyTroubleshootingIntent(normalizedPrompt);
  if (intentResult.intent) {
    for (const skill of intentResult.skills) {
      if (!report.selectedSkills.includes(skill) && report.selectedSkills.length < MAX_SKILLS) {
        report.selectedSkills.push(skill);
      }
    }
    logDecision(log, {
      hook: "UserPromptSubmit",
      event: "troubleshooting_intent_routed",
      intent: intentResult.intent,
      skills: intentResult.skills,
      reason: intentResult.reason,
      durationMs: log.active ? log.elapsed() : void 0
    });
  } else if (intentResult.reason === "suppressed by test framework mention") {
    const suppressSet = /* @__PURE__ */ new Set(["verification", "investigation-mode", "agent-browser-verify"]);
    const before = report.selectedSkills.length;
    report.selectedSkills = report.selectedSkills.filter((s) => !suppressSet.has(s));
    if (report.selectedSkills.length < before) {
      logDecision(log, {
        hook: "UserPromptSubmit",
        event: "verification_family_suppressed",
        reason: intentResult.reason,
        durationMs: log.active ? log.elapsed() : void 0
      });
    }
  }
  const investigationSkills = ["investigation-mode", "observability", "workflow"];
  const matchedInvestigation = Object.entries(report.perSkillResults).filter(([skill, r]) => r.matched && investigationSkills.includes(skill));
  if (matchedInvestigation.length > 0) {
    logDecision(log, {
      hook: "UserPromptSubmit",
      event: "investigation_intent_detected",
      reason: "frustration_or_debug_signals",
      skills: matchedInvestigation.map(([skill, r]) => ({ skill, score: r.score })),
      durationMs: log.active ? log.elapsed() : void 0
    });
  }
  const companionResult = selectInvestigationCompanion(
    report.selectedSkills,
    report.perSkillResults
  );
  if (companionResult.companion) {
    const companion = companionResult.companion;
    const newSelected = ["investigation-mode"];
    if (!report.selectedSkills.includes(companion)) {
      newSelected.push(companion);
    } else {
      newSelected.push(companion);
    }
    report.selectedSkills.length = 0;
    report.selectedSkills.push(...newSelected);
    logDecision(log, {
      hook: "UserPromptSubmit",
      event: "companion_selected",
      skill: "investigation-mode",
      companion,
      reason: companionResult.reason,
      durationMs: log.active ? log.elapsed() : void 0
    });
  } else if (report.selectedSkills.length > 1) {
    logDecision(log, {
      hook: "UserPromptSubmit",
      event: "companion_selected",
      skill: report.selectedSkills[0],
      companion: report.selectedSkills[1],
      reason: "multi_skill_prompt_match",
      durationMs: log.active ? log.elapsed() : void 0
    });
  }
  const allMatched = Object.entries(report.perSkillResults).filter(([, r]) => r.matched).map(([skill]) => skill);
  if (allMatched.length === 0) {
    log.debug("prompt-analysis-issue", {
      issue: "no_prompt_matches",
      evaluatedSkills: Object.keys(report.perSkillResults),
      suppressedSkills: Object.entries(report.perSkillResults).filter(([, r]) => r.suppressed).map(([skill]) => skill)
    });
    log.complete("no_prompt_matches", { matchedCount: 0 }, log.active ? timing : null);
    return "{}";
  }
  if (report.selectedSkills.length === 0) {
    log.debug("prompt-analysis-issue", {
      issue: "all_deduped",
      matchedSkills: allMatched,
      seenSkills: report.dedupState.seenSkills,
      dedupStrategy: report.dedupState.strategy
    });
    log.complete("all_deduped", {
      matchedCount: allMatched.length,
      dedupedCount: allMatched.length
    }, log.active ? timing : null);
    return "{}";
  }
  const tInject = log.active ? log.now() : 0;
  const injectedSkills = hasEnvDedup ? parseSeenSkills(seenState) : /* @__PURE__ */ new Set();
  const injectResult = injectSkills(report.selectedSkills, {
    pluginRoot: PLUGIN_ROOT,
    hasEnvDedup,
    sessionId,
    injectedSkills,
    budgetBytes: budget,
    maxSkills: MAX_SKILLS,
    skillMap: skills.skillMap,
    logger: log
  });
  if (log.active) timing.inject = Math.round(log.now() - tInject);
  const { parts, loaded, summaryOnly } = injectResult;
  if (hasFileDedup) {
    syncPromptSeenSkillClaims(sessionId, loaded);
  }
  const droppedByCap = [...injectResult.droppedByCap, ...report.droppedByCap];
  const droppedByBudget = [...injectResult.droppedByBudget, ...report.droppedByBudget];
  const matchedSkills = allMatched;
  if (parts.length === 0) {
    log.complete("all_deduped", {
      matchedCount: matchedSkills.length,
      dedupedCount: matchedSkills.length
    }, log.active ? timing : null);
    return "{}";
  }
  if (log.active) timing.total = log.elapsed();
  log.complete("injected", {
    matchedCount: matchedSkills.length,
    injectedCount: loaded.length,
    dedupedCount: matchedSkills.length - loaded.length - droppedByCap.length - droppedByBudget.length,
    cappedCount: droppedByCap.length + droppedByBudget.length
  }, log.active ? timing : null);
  if (loaded.length > 0) {
    appendAuditLog({
      event: "prompt-skill-injection",
      hookEvent: "UserPromptSubmit",
      matchedSkills,
      injectedSkills: loaded,
      summaryOnly,
      droppedByCap,
      droppedByBudget
    }, cwd);
  }
  if (isTelemetryEnabled() && sessionId && loaded.length > 0) {
    const telemetryEntries = [];
    for (const skill of loaded) {
      const r = report.perSkillResults[skill];
      telemetryEntries.push(
        { key: "prompt:skill", value: skill },
        { key: "prompt:score", value: String(r?.score ?? 0) },
        { key: "prompt:hook", value: "UserPromptSubmit" }
      );
    }
    trackEvents(sessionId, telemetryEntries).catch(() => {
    });
  }
  const promptMatchReasons = {};
  for (const skill of loaded) {
    const r = report.perSkillResults[skill];
    if (r?.reason) {
      promptMatchReasons[skill] = r.reason;
    }
  }
  return formatOutput(parts, matchedSkills, loaded, summaryOnly, droppedByCap, droppedByBudget, promptMatchReasons, skills.skillMap);
}
function isMainModule() {
  try {
    const scriptPath = realpathSync(resolve(process.argv[1] || ""));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}
if (isMainModule()) {
  try {
    const output = run();
    process.stdout.write(output);
  } catch (err) {
    const entry = [
      `[${(/* @__PURE__ */ new Date()).toISOString()}] CRASH in user-prompt-submit-skill-inject.mts`,
      `  error: ${err?.message || String(err)}`,
      `  stack: ${err?.stack || "(no stack)"}`,
      `  PLUGIN_ROOT: ${PLUGIN_ROOT}`,
      `  argv: ${JSON.stringify(process.argv)}`,
      `  cwd: ${process.cwd()}`,
      ""
    ].join("\n");
    process.stderr.write(entry);
    process.stdout.write("{}");
  }
}
export {
  INVESTIGATION_COMPANION_SKILLS,
  deduplicateAndInject,
  formatOutput,
  matchPromptSignals,
  parsePromptInput,
  resolvePromptSeenSkillState,
  run,
  selectInvestigationCompanion,
  syncPromptSeenSkillClaims
};
