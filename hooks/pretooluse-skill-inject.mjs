#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditLog, pluginRoot as resolvePluginRoot, readSessionFile, safeReadJson, safeReadFile, writeSessionFile } from "./hook-env.mjs";
import { buildSkillMap, validateSkillMap } from "./skill-map-frontmatter.mjs";
import {
  parseSeenSkills,
  appendSeenSkill,
  parseLikelySkills,
  compileSkillPatterns,
  matchPathWithReason,
  matchBashWithReason,
  matchImportWithReason,
  rankEntries
} from "./patterns.mjs";
import { resolveVercelJsonSkills, isVercelJsonPath, VERCEL_JSON_SKILLS } from "./vercel-config.mjs";
import { createLogger } from "./logger.mjs";
const MAX_SKILLS = 3;
const DEFAULT_INJECTION_BUDGET_BYTES = 12e3;
const SETUP_MODE_BOOTSTRAP_SKILL = "bootstrap";
const SETUP_MODE_PRIORITY_BOOST = 50;
const PLUGIN_ROOT = resolvePluginRoot();
const SUPPORTED_TOOLS = ["Read", "Edit", "Write", "Bash"];
const TSX_REVIEW_SKILL = "react-best-practices";
const DEFAULT_REVIEW_THRESHOLD = 3;
const TSX_REVIEW_PRIORITY_BOOST = 40;
const REVIEW_MARKER = "<!-- marker:review-injected -->";
const DEV_SERVER_VERIFY_SKILL = "agent-browser-verify";
const DEV_SERVER_VERIFY_PRIORITY_BOOST = 45;
const DEV_SERVER_VERIFY_MAX_ITERATIONS = 2;
const DEV_SERVER_VERIFY_MARKER = "<!-- marker:dev-server-verify -->";
const DEV_SERVER_UNAVAILABLE_WARNING = `<!-- agent-browser-unavailable -->
**Note**: \`agent-browser\` CLI is not installed. Browser-based dev server verification is unavailable.
Install it with \`npm install -g agent-browser && agent-browser install\` to enable automatic visual verification.
<!-- /agent-browser-unavailable -->`;
const VERCEL_ENV_HELP_ONCE_KEY = "vercel-env-help";
const VERCEL_ENV_COMMAND = /\bvercel\s+env\s+(add|update|pull)\b/;
const VERCEL_ENV_HELP = `<!-- vercel-env-help -->
**Vercel env quick reference**
- Add and paste the value at the prompt: vercel env add NAME production
- Add from stdin/file: vercel env add NAME production < .env-value
- Branch-specific preview var: vercel env add NAME preview feature-branch
- Update an existing variable: vercel env update NAME production
- Pull cloud envs locally after changes: vercel env pull .env.local --yes
- Do NOT pass NAME=value as a positional argument. vercel env add reads the value from stdin or from the interactive prompt.
<!-- /vercel-env-help -->`;
const DEV_SERVER_PATTERNS = [
  /\bnext\s+dev\b/,
  /\bnpm\s+run\s+dev\b/,
  /\bpnpm\s+dev\b/,
  /\bbun\s+(run\s+)?dev\b/,
  /\byarn\s+dev\b/,
  /\bvite\s+dev\b/,
  /\bvite\b(?!.*build)/,
  /\bnuxt\s+dev\b/,
  /\bvercel\s+dev\b/,
  /\bastro\s+dev\b/
];
function getInjectionBudget() {
  const envVal = process.env.VERCEL_PLUGIN_INJECTION_BUDGET;
  if (envVal != null && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INJECTION_BUDGET_BYTES;
}
const log = createLogger();
function getSeenSkillsEnv() {
  return typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string" ? process.env.VERCEL_PLUGIN_SEEN_SKILLS : "";
}
function getReviewThreshold() {
  const envVal = process.env.VERCEL_PLUGIN_REVIEW_THRESHOLD;
  if (envVal != null && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_REVIEW_THRESHOLD;
}
function getTsxEditCount() {
  const raw = process.env.VERCEL_PLUGIN_TSX_EDIT_COUNT;
  if (raw == null || raw === "") return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}
function incrementTsxEditCount() {
  const current = getTsxEditCount();
  const next = current + 1;
  process.env.VERCEL_PLUGIN_TSX_EDIT_COUNT = String(next);
  return next;
}
function resetTsxEditCount() {
  process.env.VERCEL_PLUGIN_TSX_EDIT_COUNT = "0";
}
function isTsxEditTool(toolName, toolInput) {
  if (toolName !== "Edit" && toolName !== "Write") return false;
  const filePath = toolInput.file_path || "";
  return /\.tsx$/.test(filePath);
}
function checkTsxReviewTrigger(toolName, toolInput, _injectedSkills, dedupOff, logger) {
  const l = logger || log;
  const threshold = getReviewThreshold();
  if (dedupOff) {
    l.summary("tsx-review-not-fired", { reason: "dedup-off" });
    return { triggered: false, count: 0, threshold, debounced: false };
  }
  if (!isTsxEditTool(toolName, toolInput)) {
    l.summary("tsx-review-not-fired", { reason: "not-tsx-edit", tool: toolName });
    return { triggered: false, count: getTsxEditCount(), threshold, debounced: false };
  }
  const prevCount = getTsxEditCount();
  const count = incrementTsxEditCount();
  const delta = count - prevCount;
  l.debug("tsx-edit-count", { count, threshold, file: toolInput.file_path || "" });
  l.trace("tsx-edit-counter-state", { previous: prevCount, current: count, delta, threshold, remaining: Math.max(0, threshold - count), file: toolInput.file_path || "" });
  if (count >= threshold) {
    l.summary("tsx-review-triggered", { count, threshold });
    l.debug("tsx-review-triggered", { count, threshold });
    return { triggered: true, count, threshold, debounced: false };
  }
  l.summary("tsx-review-not-fired", { reason: "below-threshold", count, threshold });
  return { triggered: false, count, threshold, debounced: false };
}
function getDevServerVerifyCount() {
  const raw = process.env.VERCEL_PLUGIN_DEV_VERIFY_COUNT;
  if (raw == null || raw === "") return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}
function incrementDevServerVerifyCount() {
  const current = getDevServerVerifyCount();
  const next = current + 1;
  process.env.VERCEL_PLUGIN_DEV_VERIFY_COUNT = String(next);
  return next;
}
function resetDevServerVerifyCount() {
  process.env.VERCEL_PLUGIN_DEV_VERIFY_COUNT = "0";
}
function isDevServerCommand(command) {
  if (!command) return false;
  const devCommand = process.env.VERCEL_PLUGIN_DEV_COMMAND;
  if (devCommand && command.includes(devCommand)) return true;
  return DEV_SERVER_PATTERNS.some((re) => re.test(command));
}
function checkDevServerVerify(toolName, toolInput, _injectedSkills, _dedupOff, logger) {
  const l = logger || log;
  const noResult = { triggered: false, unavailable: false, loopGuardHit: false, iterationCount: 0 };
  if (toolName !== "Bash") {
    l.summary("dev-server-verify-not-fired", { reason: "not-bash", tool: toolName });
    return noResult;
  }
  const command = toolInput.command || "";
  if (!isDevServerCommand(command)) {
    l.summary("dev-server-verify-not-fired", { reason: "not-dev-server-command" });
    return noResult;
  }
  l.debug("dev-server-detected", { command: command.slice(0, 100) });
  const available = process.env.VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE;
  if (available === "0") {
    l.summary("dev-server-verify-not-fired", { reason: "agent-browser-unavailable" });
    l.debug("dev-server-verify-unavailable", { reason: "agent-browser not installed" });
    return { triggered: false, unavailable: true, loopGuardHit: false, iterationCount: 0 };
  }
  const count = getDevServerVerifyCount();
  l.trace("dev-server-verify-counter-state", { current: count, max: DEV_SERVER_VERIFY_MAX_ITERATIONS, remaining: Math.max(0, DEV_SERVER_VERIFY_MAX_ITERATIONS - count), command: command.slice(0, 100) });
  if (count >= DEV_SERVER_VERIFY_MAX_ITERATIONS) {
    l.summary("dev-server-verify-not-fired", { reason: "loop-guard", count, max: DEV_SERVER_VERIFY_MAX_ITERATIONS });
    l.debug("dev-server-verify-loop-guard", { count, max: DEV_SERVER_VERIFY_MAX_ITERATIONS });
    return { triggered: false, unavailable: false, loopGuardHit: true, iterationCount: count };
  }
  l.summary("dev-server-verify-triggered", { iterationCount: count });
  return { triggered: true, unavailable: false, loopGuardHit: false, iterationCount: count };
}
function checkVercelEnvHelp(toolName, toolInput, injectedSkills, dedupOff, logger) {
  const l = logger || log;
  if (toolName !== "Bash") {
    l.summary("vercel-env-help-not-fired", { reason: "not-bash", tool: toolName });
    return { triggered: false };
  }
  const command = toolInput.command || "";
  const match = command.match(VERCEL_ENV_COMMAND);
  if (!match) {
    l.summary("vercel-env-help-not-fired", { reason: "no-command-match" });
    return { triggered: false };
  }
  if (!dedupOff && injectedSkills.has(VERCEL_ENV_HELP_ONCE_KEY)) {
    l.summary("vercel-env-help-not-fired", { reason: "already-shown", subcommand: match[1] });
    return { triggered: false };
  }
  l.summary("vercel-env-help-triggered", { subcommand: match[1] });
  return { triggered: true, subcommand: match[1] };
}
function parseInput(raw, logger) {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    l.issue("STDIN_EMPTY", "No data received on stdin", "Ensure the hook receives JSON on stdin with tool_name, tool_input, session_id", {});
    l.complete("stdin_empty");
    return null;
  }
  let input;
  try {
    input = JSON.parse(trimmed);
  } catch (err) {
    l.issue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON with tool_name, tool_input, session_id fields", { error: String(err) });
    l.complete("stdin_parse_fail");
    return null;
  }
  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || process.env.SESSION_ID || null;
  const cwdCandidate = input.cwd ?? input.working_directory;
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : null;
  const toolTarget = toolName === "Bash" ? toolInput.command || "" : toolInput.file_path || "";
  l.debug("input-parsed", { toolName, sessionId, cwd });
  l.debug("tool-target", { toolName, target: redactCommand(toolTarget) });
  return { toolName, toolInput, sessionId, cwd, toolTarget };
}
function loadSkills(pluginRoot, logger) {
  const root = pluginRoot || PLUGIN_ROOT;
  const l = logger || log;
  let skillMap;
  const manifestPath = join(root, "generated", "skill-manifest.json");
  let usedManifest = false;
  let manifestVersion = 0;
  let manifestSkillsFull = null;
  const manifest = safeReadJson(manifestPath);
  if (manifest && manifest.skills && typeof manifest.skills === "object") {
    skillMap = manifest.skills;
    manifestVersion = manifest.version || 1;
    if (manifestVersion >= 2) manifestSkillsFull = manifest.skills;
    usedManifest = true;
    l.debug("manifest-loaded", { path: manifestPath, generatedAt: manifest.generatedAt, version: manifestVersion });
  }
  if (!usedManifest) {
    try {
      const skillsDir = join(root, "skills");
      const built = buildSkillMap(skillsDir);
      if (built.diagnostics && built.diagnostics.length > 0) {
        for (const d of built.diagnostics) {
          l.issue("SKILLMD_PARSE_FAIL", `Failed to parse SKILL.md: ${d.message}`, `Fix YAML frontmatter in ${d.file}`, { file: d.file, error: d.error });
        }
      }
      if (built.warnings && built.warnings.length > 0) {
        for (const w of built.warnings) {
          l.debug("skillmap-coercion-warning", { warning: w });
        }
      }
      const validation = validateSkillMap(built);
      if (!validation.ok) {
        l.issue("SKILLMAP_VALIDATE_FAIL", "Skill map validation failed after build", "Check SKILL.md frontmatter types: pathPatterns and bashPatterns must be arrays", { errors: validation.errors });
        l.complete("skillmap_fail");
        return null;
      }
      if (validation.warnings && validation.warnings.length > 0) {
        for (const w of validation.warnings) {
          l.debug("skillmap-validation-warning", { warning: w });
        }
      }
      skillMap = validation.normalizedSkillMap.skills;
    } catch (err) {
      l.issue("SKILLMAP_LOAD_FAIL", "Failed to build skill map from SKILL.md frontmatter", "Check that skills/*/SKILL.md files exist and contain valid YAML frontmatter with metadata.pathPatterns", { error: String(err) });
      l.complete("skillmap_fail");
      return null;
    }
  }
  if (typeof skillMap !== "object" || Object.keys(skillMap).length === 0) {
    l.issue("SKILLMAP_EMPTY", "Skill map is empty or has no skills", "Ensure skills/*/SKILL.md files have YAML frontmatter with metadata.pathPatterns or metadata.bashPatterns", { type: typeof skillMap });
    l.complete("skillmap_fail");
    return null;
  }
  const skillCount = Object.keys(skillMap).length;
  l.debug("skillmap-loaded", { skillCount });
  let compiledSkills;
  if (manifestSkillsFull) {
    compiledSkills = Object.entries(manifestSkillsFull).map(([skill, config]) => {
      const pathPats = config.pathPatterns || [];
      const pathSrcs = config.pathRegexSources || [];
      const compiledPaths = [];
      for (let i = 0; i < pathPats.length && i < pathSrcs.length; i++) {
        try {
          compiledPaths.push({ pattern: pathPats[i], regex: new RegExp(pathSrcs[i]) });
        } catch (err) {
          l.issue("PATH_REGEX_COMPILE_FAIL", `Failed to compile path regex for skill "${skill}": ${pathSrcs[i]}`, `Fix pathRegexSources in the manifest for skill "${skill}"`, { skill, pattern: pathPats[i], regexSource: pathSrcs[i], error: String(err) });
        }
      }
      const bashPats = config.bashPatterns || [];
      const bashSrcs = config.bashRegexSources || [];
      const compiledBash = [];
      for (let i = 0; i < bashPats.length && i < bashSrcs.length; i++) {
        try {
          compiledBash.push({ pattern: bashPats[i], regex: new RegExp(bashSrcs[i]) });
        } catch (err) {
          l.issue("BASH_REGEX_COMPILE_FAIL", `Failed to compile bash regex for skill "${skill}": ${bashSrcs[i]}`, `Fix bashRegexSources in the manifest for skill "${skill}"`, { skill, pattern: bashPats[i], regexSource: bashSrcs[i], error: String(err) });
        }
      }
      const importPats = config.importPatterns || [];
      const importSrcs = config.importRegexSources || [];
      const compiledImports = [];
      for (let i = 0; i < importPats.length && i < importSrcs.length; i++) {
        try {
          compiledImports.push({ pattern: importPats[i], regex: new RegExp(importSrcs[i].source, importSrcs[i].flags) });
        } catch (err) {
          l.issue("IMPORT_REGEX_COMPILE_FAIL", `Failed to compile import regex for skill "${skill}": ${JSON.stringify(importSrcs[i])}`, `Fix importRegexSources in the manifest for skill "${skill}"`, { skill, pattern: importPats[i], regexSource: importSrcs[i], error: String(err) });
        }
      }
      return {
        skill,
        priority: typeof config.priority === "number" ? config.priority : 0,
        compiledPaths,
        compiledBash,
        compiledImports
      };
    });
    l.debug("manifest-regexes-restored", { skillCount, version: manifestVersion });
  } else {
    const callbacks = {
      onPathGlobError(skill, p, err) {
        l.issue("PATH_GLOB_INVALID", `Invalid glob pattern in skill "${skill}": ${p}`, `Fix or remove the invalid pathPatterns entry in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
      },
      onBashRegexError(skill, p, err) {
        l.issue("BASH_REGEX_INVALID", `Invalid bash regex pattern in skill "${skill}": ${p}`, `Fix or remove the invalid bashPatterns entry in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
      },
      onImportPatternError(skill, p, err) {
        l.issue("IMPORT_PATTERN_INVALID", `Invalid import pattern in skill "${skill}": ${p}`, `Fix or remove the invalid importPatterns entry in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
      }
    };
    compiledSkills = compileSkillPatterns(skillMap, callbacks);
  }
  return { skillMap, compiledSkills, usedManifest };
}
function matchSkills(toolName, toolInput, compiledSkills, logger) {
  const l = logger || log;
  if (!SUPPORTED_TOOLS.includes(toolName)) {
    l.complete("tool_unsupported");
    return null;
  }
  const matchedEntries = [];
  const matchReasons = {};
  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    const contentParts = [];
    if (toolInput.content) contentParts.push(toolInput.content);
    if (toolInput.old_string) contentParts.push(toolInput.old_string);
    if (toolInput.new_string) contentParts.push(toolInput.new_string);
    const fileContent = contentParts.join("\n");
    for (const entry of compiledSkills) {
      l.trace("pattern-eval-start", { skill: entry.skill, target: filePath, patternCount: entry.compiledPaths.length });
      const reason = matchPathWithReason(filePath, entry.compiledPaths);
      l.trace("pattern-eval-result", { skill: entry.skill, matched: !!reason, reason: reason || null });
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      } else if (fileContent && entry.compiledImports && entry.compiledImports.length > 0) {
        const importReason = matchImportWithReason(fileContent, entry.compiledImports);
        l.trace("import-eval-result", { skill: entry.skill, matched: !!importReason, reason: importReason || null });
        if (importReason) {
          matchedEntries.push(entry);
          matchReasons[entry.skill] = importReason;
        }
      }
    }
  } else if (toolName === "Bash") {
    const command = toolInput.command || "";
    for (const entry of compiledSkills) {
      l.trace("pattern-eval-start", { skill: entry.skill, target: redactCommand(command), patternCount: entry.compiledBash.length });
      const reason = matchBashWithReason(command, entry.compiledBash);
      l.trace("pattern-eval-result", { skill: entry.skill, matched: !!reason, reason: reason || null });
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  }
  const matched = new Set(matchedEntries.map((e) => e.skill));
  l.debug("matches-found", { matched: [...matched], reasons: matchReasons });
  return { matchedEntries, matchReasons, matched };
}
function deduplicateSkills({ matchedEntries, matched, toolName, toolInput, injectedSkills, dedupOff, maxSkills, likelySkills, compiledSkills, setupMode }, logger) {
  const l = logger || log;
  const cap = maxSkills ?? MAX_SKILLS;
  const likely = likelySkills || /* @__PURE__ */ new Set();
  const setupModeActive = setupMode === true;
  let newEntries = dedupOff ? matchedEntries : matchedEntries.filter((e) => !injectedSkills.has(e.skill));
  let vercelJsonRouting = null;
  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    if (isVercelJsonPath(filePath)) {
      const resolved = resolveVercelJsonSkills(filePath);
      if (resolved) {
        vercelJsonRouting = resolved;
        l.debug("vercel-json-routing", {
          keys: resolved.keys,
          relevantSkills: [...resolved.relevantSkills]
        });
        for (const entry of newEntries) {
          if (!VERCEL_JSON_SKILLS.has(entry.skill)) continue;
          if (resolved.relevantSkills.size === 0) continue;
          if (resolved.relevantSkills.has(entry.skill)) {
            entry.effectivePriority = entry.priority + 10;
          } else {
            entry.effectivePriority = entry.priority - 10;
          }
        }
      }
    }
  }
  const profilerBoosted = [];
  if (likely.size > 0) {
    for (const entry of newEntries) {
      if (likely.has(entry.skill)) {
        const base = typeof entry.effectivePriority === "number" ? entry.effectivePriority : entry.priority;
        entry.effectivePriority = base + 5;
        profilerBoosted.push(entry.skill);
      }
    }
    if (profilerBoosted.length > 0) {
      l.debug("profiler-boosted", {
        likelySkills: [...likely],
        boostedSkills: profilerBoosted
      });
    }
  }
  let setupModeRouting = null;
  if (setupModeActive) {
    setupModeRouting = { active: true, synthetic: false, skippedAsSeen: false };
    if (!dedupOff && injectedSkills.has(SETUP_MODE_BOOTSTRAP_SKILL)) {
      setupModeRouting.skippedAsSeen = true;
      l.debug("setup-mode-bootstrap-skip", { reason: "already_injected" });
    } else {
      let bootstrapEntry = newEntries.find((e) => e.skill === SETUP_MODE_BOOTSTRAP_SKILL);
      if (!bootstrapEntry) {
        const bootstrapTemplate = Array.isArray(compiledSkills) ? compiledSkills.find((entry) => entry.skill === SETUP_MODE_BOOTSTRAP_SKILL) : null;
        bootstrapEntry = bootstrapTemplate ? { ...bootstrapTemplate } : {
          skill: SETUP_MODE_BOOTSTRAP_SKILL,
          priority: 0,
          compiledPaths: [],
          compiledBash: [],
          compiledImports: []
        };
        newEntries.push(bootstrapEntry);
        matched.add(SETUP_MODE_BOOTSTRAP_SKILL);
        setupModeRouting.synthetic = true;
      }
      const maxPriority = newEntries.reduce((max, entry) => {
        const value = typeof entry.effectivePriority === "number" ? entry.effectivePriority : entry.priority;
        return Math.max(max, typeof value === "number" ? value : 0);
      }, 0);
      const basePriority = typeof bootstrapEntry.effectivePriority === "number" ? bootstrapEntry.effectivePriority : bootstrapEntry.priority;
      bootstrapEntry.effectivePriority = Math.max(
        (typeof basePriority === "number" ? basePriority : 0) + SETUP_MODE_PRIORITY_BOOST,
        maxPriority + 1
      );
      l.debug("setup-mode-bootstrap-routing", {
        synthetic: setupModeRouting.synthetic,
        effectivePriority: bootstrapEntry.effectivePriority
      });
    }
  }
  newEntries = rankEntries(newEntries);
  const rankedSkills = newEntries.map((e) => e.skill);
  l.debug("dedup-filtered", {
    rankedSkills,
    previouslyInjected: [...injectedSkills]
  });
  return { newEntries, rankedSkills, vercelJsonRouting, profilerBoosted, setupModeRouting };
}
function injectSkills(rankedSkills, options) {
  const { pluginRoot, hasEnvDedup, sessionId, injectedSkills, budgetBytes, maxSkills, skillMap, logger } = options || {};
  const root = pluginRoot || PLUGIN_ROOT;
  const l = logger || log;
  const budget = budgetBytes ?? getInjectionBudget();
  const ceiling = maxSkills ?? MAX_SKILLS;
  const parts = [];
  const loaded = [];
  const summaryOnly = [];
  const droppedByCap = [];
  const droppedByBudget = [];
  let usedBytes = 0;
  for (const skill of rankedSkills) {
    if (loaded.length >= ceiling) {
      droppedByCap.push(skill);
      continue;
    }
    const skillPath = join(root, "skills", skill, "SKILL.md");
    const content = safeReadFile(skillPath);
    if (content === null) {
      l.issue("SKILL_FILE_MISSING", `SKILL.md not found for skill "${skill}"`, `Create skills/${skill}/SKILL.md with valid frontmatter`, { skillPath, error: "file not found or unreadable" });
      continue;
    }
    const wrapped = `<!-- skill:${skill} -->
${content}
<!-- /skill:${skill} -->`;
    const byteLen = Buffer.byteLength(wrapped, "utf-8");
    if (loaded.length > 0 && usedBytes + byteLen > budget) {
      const summary = skillMap?.[skill]?.summary;
      if (summary) {
        const summaryWrapped = `<!-- skill:${skill} mode:summary -->
${summary}
<!-- /skill:${skill} -->`;
        const summaryByteLen = Buffer.byteLength(summaryWrapped, "utf-8");
        if (usedBytes + summaryByteLen <= budget) {
          parts.push(summaryWrapped);
          loaded.push(skill);
          summaryOnly.push(skill);
          usedBytes += summaryByteLen;
          if (injectedSkills) injectedSkills.add(skill);
          if (hasEnvDedup) {
            process.env.VERCEL_PLUGIN_SEEN_SKILLS = appendSeenSkill(
              process.env.VERCEL_PLUGIN_SEEN_SKILLS,
              skill
            );
            if (sessionId) {
              writeSessionFile(sessionId, "seen-skills", process.env.VERCEL_PLUGIN_SEEN_SKILLS || "");
            }
          }
          l.debug("summary-fallback", { skill, fullBytes: byteLen, summaryBytes: summaryByteLen });
          continue;
        }
      }
      droppedByBudget.push(skill);
      continue;
    }
    parts.push(wrapped);
    loaded.push(skill);
    usedBytes += byteLen;
    if (injectedSkills) injectedSkills.add(skill);
    if (hasEnvDedup) {
      process.env.VERCEL_PLUGIN_SEEN_SKILLS = appendSeenSkill(
        process.env.VERCEL_PLUGIN_SEEN_SKILLS,
        skill
      );
      if (sessionId) {
        writeSessionFile(sessionId, "seen-skills", process.env.VERCEL_PLUGIN_SEEN_SKILLS || "");
      }
    }
  }
  if (droppedByCap.length > 0 || droppedByBudget.length > 0 || summaryOnly.length > 0) {
    l.debug("cap-applied", {
      max: ceiling,
      budgetBytes: budget,
      usedBytes,
      totalCandidates: rankedSkills.length,
      selected: loaded.map((s) => ({ skill: s, mode: summaryOnly.includes(s) ? "summary" : "full" })),
      droppedByCap,
      droppedByBudget,
      summaryOnly
    });
  }
  l.debug("skills-injected", { injected: loaded, summaryOnly, totalParts: parts.length, usedBytes, budgetBytes: budget });
  return { parts, loaded, summaryOnly, droppedByCap, droppedByBudget };
}
function formatOutput({ parts, matched, injectedSkills, summaryOnly, droppedByCap, droppedByBudget, toolName, toolTarget }) {
  if (parts.length === 0) {
    return "{}";
  }
  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    toolName,
    toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
    matchedSkills: [...matched],
    injectedSkills,
    summaryOnly: summaryOnly || [],
    droppedByCap,
    droppedByBudget: droppedByBudget || []
  };
  const metaComment = `<!-- skillInjection: ${JSON.stringify(skillInjection)} -->`;
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: parts.join("\n\n") + "\n" + metaComment
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
  const parsed = parseInput(raw, log);
  if (!parsed) return "{}";
  if (log.active) timing.stdin_parse = Math.round(log.now() - tPhase);
  const { toolName, toolInput, sessionId, cwd, toolTarget } = parsed;
  const tSkillmap = log.active ? log.now() : 0;
  const skills = loadSkills(PLUGIN_ROOT, log);
  if (!skills) return "{}";
  if (log.active) timing.skillmap_load = Math.round(log.now() - tSkillmap);
  const { compiledSkills, usedManifest } = skills;
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasFileDedup = !dedupOff && !!sessionId;
  const seenEnv = getSeenSkillsEnv();
  const seenFile = hasFileDedup ? readSessionFile(sessionId, "seen-skills") : "";
  if (hasFileDedup && seenEnv === "") {
    process.env.VERCEL_PLUGIN_SEEN_SKILLS = seenFile;
  }
  const seenState = seenEnv === "" ? seenFile : seenEnv;
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const dedupStrategy = dedupOff ? "disabled" : hasFileDedup ? "file" : hasEnvDedup ? "env-var" : "memory-only";
  const likelySkillsEnv = process.env.VERCEL_PLUGIN_LIKELY_SKILLS || "";
  const likelySkills = parseLikelySkills(likelySkillsEnv);
  const setupMode = process.env.VERCEL_PLUGIN_SETUP_MODE === "1";
  log.debug("dedup-strategy", { strategy: dedupStrategy, sessionId, seenEnv: seenState });
  if (likelySkills.size > 0) {
    log.debug("likely-skills", { skills: [...likelySkills] });
  }
  if (setupMode) {
    log.debug("setup-mode", { active: true, bootstrapSkill: SETUP_MODE_BOOTSTRAP_SKILL });
  }
  const injectedSkills = dedupOff ? /* @__PURE__ */ new Set() : parseSeenSkills(seenState);
  const tMatch = log.active ? log.now() : 0;
  const matchResult = matchSkills(toolName, toolInput, compiledSkills, log);
  if (!matchResult) return "{}";
  if (log.active) timing.match = Math.round(log.now() - tMatch);
  const { matchedEntries, matched } = matchResult;
  const tsxReview = checkTsxReviewTrigger(toolName, toolInput, injectedSkills, dedupOff, log);
  const devServerVerify = checkDevServerVerify(toolName, toolInput, injectedSkills, dedupOff, log);
  const vercelEnvHelp = checkVercelEnvHelp(toolName, toolInput, injectedSkills, dedupOff, log);
  if (devServerVerify.triggered) {
    for (const entry of matchedEntries) {
      if (entry.skill === DEV_SERVER_VERIFY_SKILL) {
        entry.effectivePriority = DEV_SERVER_VERIFY_PRIORITY_BOOST;
        log.debug("dev-server-verify-priority-boost", { skill: entry.skill, effectivePriority: entry.effectivePriority });
        break;
      }
    }
  }
  const dedupResult = deduplicateSkills({
    matchedEntries,
    matched,
    toolName,
    toolInput,
    injectedSkills,
    dedupOff,
    likelySkills,
    compiledSkills,
    setupMode
  }, log);
  const { newEntries, rankedSkills } = dedupResult;
  let tsxReviewInjected = false;
  if (tsxReview.triggered && !rankedSkills.includes(TSX_REVIEW_SKILL)) {
    const reviewTemplate = compiledSkills.find((e) => e.skill === TSX_REVIEW_SKILL);
    const reviewEntry = reviewTemplate ? { ...reviewTemplate, effectivePriority: TSX_REVIEW_PRIORITY_BOOST } : {
      skill: TSX_REVIEW_SKILL,
      priority: 0,
      compiledPaths: [],
      compiledBash: [],
      compiledImports: [],
      effectivePriority: TSX_REVIEW_PRIORITY_BOOST
    };
    rankedSkills.unshift(TSX_REVIEW_SKILL);
    matched.add(TSX_REVIEW_SKILL);
    tsxReviewInjected = true;
    log.debug("tsx-review-synthetic-inject", { skill: TSX_REVIEW_SKILL, count: tsxReview.count });
  } else if (tsxReview.triggered && rankedSkills.includes(TSX_REVIEW_SKILL)) {
    tsxReviewInjected = true;
  }
  let devServerVerifyInjected = false;
  let devServerUnavailableWarning = false;
  if (devServerVerify.unavailable) {
    if (!injectedSkills.has("agent-browser-unavailable-warning")) {
      devServerUnavailableWarning = true;
      injectedSkills.add("agent-browser-unavailable-warning");
      if (hasEnvDedup) {
        process.env.VERCEL_PLUGIN_SEEN_SKILLS = appendSeenSkill(
          process.env.VERCEL_PLUGIN_SEEN_SKILLS,
          "agent-browser-unavailable-warning"
        );
        if (sessionId) {
          writeSessionFile(sessionId, "seen-skills", process.env.VERCEL_PLUGIN_SEEN_SKILLS || "");
        }
      }
      log.debug("dev-server-verify-unavailable-warning", { reason: "agent-browser not installed" });
    }
    const verifyIdx = rankedSkills.indexOf(DEV_SERVER_VERIFY_SKILL);
    if (verifyIdx !== -1) {
      rankedSkills.splice(verifyIdx, 1);
      log.debug("dev-server-verify-suppressed", { reason: "agent-browser unavailable" });
    }
  } else if (devServerVerify.triggered && !rankedSkills.includes(DEV_SERVER_VERIFY_SKILL)) {
    const verifyTemplate = compiledSkills.find((e) => e.skill === DEV_SERVER_VERIFY_SKILL);
    const _verifyEntry = verifyTemplate ? { ...verifyTemplate, effectivePriority: DEV_SERVER_VERIFY_PRIORITY_BOOST } : {
      skill: DEV_SERVER_VERIFY_SKILL,
      priority: 0,
      compiledPaths: [],
      compiledBash: [],
      compiledImports: [],
      effectivePriority: DEV_SERVER_VERIFY_PRIORITY_BOOST
    };
    rankedSkills.unshift(DEV_SERVER_VERIFY_SKILL);
    matched.add(DEV_SERVER_VERIFY_SKILL);
    devServerVerifyInjected = true;
    log.debug("dev-server-verify-synthetic-inject", { skill: DEV_SERVER_VERIFY_SKILL, iteration: devServerVerify.iterationCount });
  } else if (devServerVerify.triggered && rankedSkills.includes(DEV_SERVER_VERIFY_SKILL)) {
    devServerVerifyInjected = true;
  }
  let vercelEnvHelpInjected = false;
  if (vercelEnvHelp.triggered) {
    vercelEnvHelpInjected = true;
    injectedSkills.add(VERCEL_ENV_HELP_ONCE_KEY);
    if (hasEnvDedup) {
      process.env.VERCEL_PLUGIN_SEEN_SKILLS = appendSeenSkill(
        process.env.VERCEL_PLUGIN_SEEN_SKILLS,
        VERCEL_ENV_HELP_ONCE_KEY
      );
      if (sessionId) {
        writeSessionFile(sessionId, "seen-skills", process.env.VERCEL_PLUGIN_SEEN_SKILLS || "");
      }
    }
    log.debug("vercel-env-help-injected", { subcommand: vercelEnvHelp.subcommand || "" });
  }
  if (rankedSkills.length === 0 && !devServerUnavailableWarning && !vercelEnvHelpInjected) {
    const reason = matched.size === 0 ? "no_matches" : "all_deduped";
    if (log.active) {
      timing.skill_read = 0;
      timing.total = log.elapsed();
    }
    log.complete(reason, {
      matchedCount: matched.size,
      dedupedCount: matched.size - rankedSkills.length,
      tsxReviewTriggered: tsxReview.triggered,
      devServerVerifyTriggered: devServerVerify.triggered
    }, log.active ? timing : null);
    return "{}";
  }
  const tSkillRead = log.active ? log.now() : 0;
  const { parts, loaded, summaryOnly, droppedByCap, droppedByBudget } = injectSkills(rankedSkills, {
    pluginRoot: PLUGIN_ROOT,
    hasEnvDedup,
    sessionId,
    injectedSkills,
    skillMap: skills.skillMap,
    logger: log
  });
  if (log.active) timing.skill_read = Math.round(log.now() - tSkillRead);
  if (tsxReviewInjected && loaded.includes(TSX_REVIEW_SKILL)) {
    parts.push(REVIEW_MARKER);
    const prevCount = getTsxEditCount();
    resetTsxEditCount();
    log.debug("tsx-review-marker-added", { marker: REVIEW_MARKER });
    log.trace("tsx-edit-counter-reset", { previousCount: prevCount, resetTo: 0, threshold: getReviewThreshold() });
  }
  if (devServerVerifyInjected && loaded.includes(DEV_SERVER_VERIFY_SKILL)) {
    const prevIteration = getDevServerVerifyCount();
    const iteration = incrementDevServerVerifyCount();
    parts.push(`${DEV_SERVER_VERIFY_MARKER.replace("-->", `iteration="${iteration}" max="${DEV_SERVER_VERIFY_MAX_ITERATIONS}" -->`)}`);
    log.debug("dev-server-verify-marker-added", { iteration, max: DEV_SERVER_VERIFY_MAX_ITERATIONS });
    log.trace("dev-server-verify-counter-increment", { previous: prevIteration, current: iteration, max: DEV_SERVER_VERIFY_MAX_ITERATIONS, remaining: DEV_SERVER_VERIFY_MAX_ITERATIONS - iteration });
  }
  if (devServerUnavailableWarning) {
    parts.push(DEV_SERVER_UNAVAILABLE_WARNING);
    log.debug("dev-server-unavailable-warning-injected", {});
  }
  if (vercelEnvHelpInjected) {
    parts.push(VERCEL_ENV_HELP);
    log.debug("vercel-env-help-appended", { subcommand: vercelEnvHelp.subcommand || "" });
  }
  if (parts.length === 0) {
    if (log.active) timing.total = log.elapsed();
    log.complete("no_matches", {
      matchedCount: matched.size,
      dedupedCount: matchedEntries.length - newEntries.length,
      cappedCount: droppedByCap.length + droppedByBudget.length,
      tsxReviewTriggered: tsxReview.triggered,
      devServerVerifyTriggered: devServerVerify.triggered
    }, log.active ? timing : null);
    return "{}";
  }
  if (log.active) timing.total = log.elapsed();
  const cappedCount = droppedByCap.length + droppedByBudget.length;
  log.complete("injected", {
    matchedCount: matched.size,
    injectedCount: parts.length,
    dedupedCount: matchedEntries.length - newEntries.length,
    cappedCount,
    tsxReviewTriggered: tsxReview.triggered,
    devServerVerifyTriggered: devServerVerify.triggered
  }, log.active ? timing : null);
  const result = formatOutput({ parts, matched, injectedSkills: loaded, summaryOnly, droppedByCap, droppedByBudget, toolName, toolTarget });
  if (loaded.length > 0) {
    appendAuditLog({
      event: "skill-injection",
      toolName,
      toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
      matchedSkills: [...matched],
      injectedSkills: loaded,
      summaryOnly,
      droppedByCap,
      droppedByBudget
    }, cwd);
  }
  return result;
}
const REDACT_MAX = 200;
const REDACT_RULES = [
  {
    // Connection strings: scheme://user:password@host
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^:/?#\s]+:[^@\s]+@[^\s]+/gi,
    fn: (match) => match.replace(/:\/\/[^:/?#\s]+:[^@\s]+@/, "://[REDACTED]@")
  },
  {
    // URL query params with sensitive keys: ?token=xxx, &key=xxx, &secret=xxx, &password=xxx
    re: /([?&])(token|key|secret|password|credential|auth|api_key|apiKey)=[^&\s]*/gi,
    fn: (match) => {
      const eqIdx = match.indexOf("=");
      return `${match.slice(0, eqIdx)}=[REDACTED]`;
    }
  },
  {
    // JSON-style secret values: "secret": "val", "password": "val", "token": "val", etc.
    re: /"(token|key|secret|password|credential|api_key|apiKey|auth)":\s*"[^"]*"/gi,
    fn: (match) => {
      const colonIdx = match.indexOf(":");
      return `${match.slice(0, colonIdx)}: "[REDACTED]"`;
    }
  },
  {
    // Cookie headers: Cookie: key=value; key2=value2
    re: /\b(Cookie|Set-Cookie):\s*\S[^\r\n]*/gi,
    fn: (match) => `${match.split(":")[0]}: [REDACTED]`
  },
  {
    // Bearer / token authorization headers: "Bearer xxx", "token xxx" (case-insensitive)
    re: /\b(Bearer|token)\s+[A-Za-z0-9_\-.+/=]{8,}\b/gi,
    fn: (match) => `${match.split(/\s+/)[0]} [REDACTED]`
  },
  {
    // --token value, --password value, --api-key value, --secret value, --auth value
    re: /--(token|password|api-key|secret|auth|credential)\s+\S+/gi,
    fn: (match) => `${match.split(/\s+/)[0]} [REDACTED]`
  },
  {
    // ENV_VAR_TOKEN=value, MY_KEY=value, SECRET=value, PASSWORD=value (env-style, may be prefixed)
    // Matches keys that contain a sensitive word anywhere (e.g. MY_SECRET_VALUE=...)
    // [^\s&] prevents consuming URL query-param delimiters
    re: /\b\w*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)\w*=[^\s&]+/gi,
    fn: (match) => {
      const eqIdx = match.indexOf("=");
      return `${match.slice(0, eqIdx)}=[REDACTED]`;
    }
  }
];
function redactCommand(command) {
  if (typeof command !== "string") return "";
  let redacted = command;
  for (const { re, fn } of REDACT_RULES) {
    re.lastIndex = 0;
    redacted = redacted.replace(re, fn);
  }
  if (redacted.length > REDACT_MAX) {
    redacted = redacted.slice(0, REDACT_MAX) + "\u2026[truncated]";
  }
  return redacted;
}
const SKILL_INJECTION_VERSION = 1;
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
      `[${(/* @__PURE__ */ new Date()).toISOString()}] CRASH in pretooluse-skill-inject.mts`,
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
  DEFAULT_REVIEW_THRESHOLD,
  DEV_SERVER_UNAVAILABLE_WARNING,
  DEV_SERVER_VERIFY_MARKER,
  DEV_SERVER_VERIFY_MAX_ITERATIONS,
  DEV_SERVER_VERIFY_SKILL,
  REVIEW_MARKER,
  TSX_REVIEW_SKILL,
  checkDevServerVerify,
  checkTsxReviewTrigger,
  checkVercelEnvHelp,
  deduplicateSkills,
  formatOutput,
  getDevServerVerifyCount,
  getReviewThreshold,
  getTsxEditCount,
  incrementDevServerVerifyCount,
  injectSkills,
  isDevServerCommand,
  isTsxEditTool,
  loadSkills,
  matchSkills,
  parseInput,
  redactCommand,
  resetDevServerVerifyCount,
  resetTsxEditCount,
  run,
  validateSkillMap
};
