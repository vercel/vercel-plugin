#!/usr/bin/env node

// hooks/src/pretooluse-skill-inject.mts
import { readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  detectPlatform
} from "./compat.mjs";
import {
  appendAuditLog,
  listSessionKeys,
  pluginRoot as resolvePluginRoot,
  readSessionFile,
  safeReadJson,
  safeReadFile,
  syncSessionFileFromClaims,
  tryClaimSessionKey
} from "./hook-env.mjs";
import { buildSkillMap, validateSkillMap } from "./skill-map-frontmatter.mjs";
import {
  COMPACTION_REINJECT_MIN_PRIORITY,
  parseSeenSkills,
  mergeSeenSkillStates,
  mergeSeenSkillStatesWithCompactionReset,
  parseLikelySkills,
  compileSkillPatterns,
  matchPathWithReason,
  matchBashWithReason,
  matchImportWithReason,
  rankEntries,
  buildDocsBlock
} from "./patterns.mjs";
import { resolveVercelJsonSkills, isVercelJsonPath, VERCEL_JSON_SKILLS } from "./vercel-config.mjs";
import { createLogger, logDecision } from "./logger.mjs";
import { trackBaseEvents } from "./telemetry.mjs";
import { selectManagedContextChunk } from "./vercel-context.mjs";
var MAX_SKILLS = 3;
var DEFAULT_INJECTION_BUDGET_BYTES = 18e3;
var SETUP_MODE_BOOTSTRAP_SKILL = "bootstrap";
var SETUP_MODE_PRIORITY_BOOST = 50;
var PLUGIN_ROOT = resolvePluginRoot();
var SUPPORTED_TOOLS = ["Read", "Edit", "Write", "Bash"];
var VERCEL_ENV_HELP_ONCE_KEY = "vercel-env-help";
var VERCEL_ENV_COMMAND = /\bvercel\s+env\s+(add|update|pull)\b/;
var VERCEL_ENV_HELP = `<!-- vercel-env-help -->
**Vercel env quick reference**
- Add and paste the value at the prompt: vercel env add NAME production
- Add from stdin/file: vercel env add NAME production < .env-value
- Branch-specific preview var: vercel env add NAME preview feature-branch
- Update an existing variable: vercel env update NAME production
- Pull cloud envs locally after changes: vercel env pull .env.local --yes
- Do NOT pass NAME=value as a positional argument. vercel env add reads the value from stdin or from the interactive prompt.
<!-- /vercel-env-help -->`;
function getInjectionBudget() {
  const envVal = process.env.VERCEL_PLUGIN_INJECTION_BUDGET;
  if (envVal != null && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INJECTION_BUDGET_BYTES;
}
var log = createLogger();
var RUNTIME_ENV_KEYS = [
  "VERCEL_PLUGIN_CONTEXT_COMPACTED",
  "VERCEL_PLUGIN_SEEN_SKILLS"
];
function captureRuntimeEnvSnapshot(env = process.env) {
  return {
    VERCEL_PLUGIN_CONTEXT_COMPACTED: env.VERCEL_PLUGIN_CONTEXT_COMPACTED,
    VERCEL_PLUGIN_SEEN_SKILLS: env.VERCEL_PLUGIN_SEEN_SKILLS
  };
}
function collectRuntimeEnvUpdates(before, env = process.env) {
  const updates = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const next = env[key];
    if (typeof next === "string" && next !== before[key]) {
      updates[key] = next;
    }
  }
  return updates;
}
function finalizeRuntimeEnvUpdates(platform, before, env = process.env) {
  if (platform !== "cursor") return void 0;
  const updates = collectRuntimeEnvUpdates(before, env);
  return Object.keys(updates).length > 0 ? updates : void 0;
}
function checkVercelEnvHelp(toolName, toolInput, injectedSkills, dedupOff, logger) {
  const l = logger || log;
  if (toolName !== "Bash") {
    l.debug("vercel-env-help-not-fired", { reason: "not-bash", tool: toolName });
    return { triggered: false };
  }
  const command = toolInput.command || "";
  const match = command.match(VERCEL_ENV_COMMAND);
  if (!match) {
    l.debug("vercel-env-help-not-fired", { reason: "no-command-match" });
    return { triggered: false };
  }
  if (!dedupOff && injectedSkills.has(VERCEL_ENV_HELP_ONCE_KEY)) {
    l.debug("vercel-env-help-not-fired", { reason: "already-shown", subcommand: match[1] });
    return { triggered: false };
  }
  l.debug("vercel-env-help-triggered", { subcommand: match[1] });
  return { triggered: true, subcommand: match[1] };
}
function parseInput(raw, logger, env = process.env) {
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
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    l.issue("STDIN_NOT_OBJECT", "Parsed stdin JSON was not an object", "Send a JSON object payload with tool_name and tool_input fields", { inputType: typeof input });
    l.complete("stdin_not_object");
    return null;
  }
  const parsed = input;
  const workspaceRoot = Array.isArray(parsed.workspace_roots) && typeof parsed.workspace_roots[0] === "string" ? parsed.workspace_roots[0] : void 0;
  const toolName = parsed.tool_name || "";
  const toolInput = parsed.tool_input || {};
  const platform = detectPlatform(parsed);
  const sessionId = typeof (parsed.session_id ?? parsed.conversation_id) === "string" ? parsed.session_id ?? parsed.conversation_id : "";
  const cwdCandidate = parsed.cwd ?? workspaceRoot ?? env.CURSOR_PROJECT_DIR ?? env.CLAUDE_PROJECT_ROOT ?? process.cwd();
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : process.cwd();
  const toolTarget = toolName === "Bash" ? toolInput.command || "" : toolInput.file_path || "";
  const agentId = typeof parsed.agent_id === "string" && parsed.agent_id.length > 0 ? parsed.agent_id : void 0;
  const scopeId = agentId;
  l.debug("input-parsed", { toolName, sessionId, cwd, platform, scopeId });
  l.debug("tool-target", { toolName, target: redactCommand(toolTarget) });
  return { toolName, toolInput, sessionId, cwd, platform, toolTarget, scopeId };
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
      if (validation.ok) {
        if (validation.warnings && validation.warnings.length > 0) {
          for (const w of validation.warnings) {
            l.debug("skillmap-validation-warning", { warning: w });
          }
        }
        skillMap = validation.normalizedSkillMap.skills;
      } else {
        const validationErrors = "errors" in validation ? validation.errors : [];
        l.issue(
          "SKILLMAP_VALIDATE_FAIL",
          "Skill map validation failed after build",
          "Check SKILL.md frontmatter types: pathPatterns and bashPatterns must be arrays",
          { errors: validationErrors }
        );
        l.complete("skillmap_fail");
        return null;
      }
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
  for (const entry of newEntries) {
    const eff = typeof entry.effectivePriority === "number" ? entry.effectivePriority : entry.priority;
    logDecision(l, {
      hook: "PreToolUse",
      event: "skill_ranked",
      skill: entry.skill,
      score: eff,
      reason: profilerBoosted.includes(entry.skill) ? "profiler_boosted" : "pattern_match"
    });
  }
  l.debug("dedup-filtered", {
    rankedSkills,
    previouslyInjected: [...injectedSkills]
  });
  return { newEntries, rankedSkills, vercelJsonRouting, profilerBoosted, setupModeRouting };
}
function skillInvocationMessage(skill, platform) {
  return platform === "cursor" ? `Load the /${skill} skill.` : `You must run the Skill(${skill}) tool.`;
}
function injectSkills(rankedSkills, options) {
  const { pluginRoot, hasEnvDedup, sessionId, scopeId, injectedSkills, budgetBytes, maxSkills, skillMap, logger, forceSummarySkills, platform: optPlatform } = options || {};
  const platform = optPlatform ?? "claude-code";
  const root = pluginRoot || PLUGIN_ROOT;
  const l = logger || log;
  const budget = budgetBytes ?? getInjectionBudget();
  const ceiling = maxSkills ?? MAX_SKILLS;
  const parts = [];
  const loaded = [];
  const summaryOnly = [];
  const droppedByCap = [];
  const droppedByBudget = [];
  const skippedByConcurrentClaim = [];
  let usedBytes = 0;
  const canInjectSkill = (skill) => {
    if (!hasEnvDedup || !sessionId) {
      return true;
    }
    const claimed = tryClaimSessionKey(sessionId, "seen-skills", skill, scopeId);
    if (!claimed) {
      skippedByConcurrentClaim.push(skill);
      l.debug("skill-skipped-concurrent-claim", { skill, sessionId, scopeId });
      return false;
    }
    syncSessionFileFromClaims(sessionId, "seen-skills", scopeId);
    return true;
  };
  for (const skill of rankedSkills) {
    if (loaded.length >= ceiling) {
      droppedByCap.push(skill);
      logDecision(l, { hook: "PreToolUse", event: "skill_dropped", skill, reason: "cap_exceeded", score: ceiling });
      continue;
    }
    const skillPath = join(root, "skills", skill, "SKILL.md");
    const raw = safeReadFile(skillPath);
    if (raw === null) {
      l.issue("SKILL_FILE_MISSING", `SKILL.md not found for skill "${skill}"`, `Create skills/${skill}/SKILL.md with valid frontmatter`, { skillPath, error: "file not found or unreadable" });
      continue;
    }
    const wrapped = skillInvocationMessage(skill, platform);
    const byteLen = Buffer.byteLength(wrapped, "utf-8");
    if (loaded.length > 0 && usedBytes + byteLen > budget) {
      const summaryWrapped = skillInvocationMessage(skill, platform);
      const summaryByteLen = Buffer.byteLength(summaryWrapped, "utf-8");
      if (usedBytes + summaryByteLen <= budget) {
        if (!canInjectSkill(skill)) {
          continue;
        }
        parts.push(summaryWrapped);
        loaded.push(skill);
        summaryOnly.push(skill);
        usedBytes += summaryByteLen;
        if (injectedSkills) injectedSkills.add(skill);
        l.debug("summary-fallback", { skill, fullBytes: byteLen, summaryBytes: summaryByteLen });
        continue;
      }
      droppedByBudget.push(skill);
      logDecision(l, { hook: "PreToolUse", event: "budget_exhausted", skill, reason: "over_budget", budgetBytes: budget, usedBytes, skillBytes: byteLen });
      continue;
    }
    if (forceSummarySkills?.has(skill)) {
      const summaryWrapped = skillInvocationMessage(skill, platform);
      const summaryByteLen = Buffer.byteLength(summaryWrapped, "utf-8");
      if (usedBytes + summaryByteLen <= budget || loaded.length === 0) {
        if (!canInjectSkill(skill)) {
          continue;
        }
        parts.push(summaryWrapped);
        loaded.push(skill);
        summaryOnly.push(skill);
        usedBytes += summaryByteLen;
        if (injectedSkills) injectedSkills.add(skill);
        l.debug("force-summary-companion", { skill, fullBytes: byteLen, summaryBytes: summaryByteLen });
        continue;
      }
    }
    if (!canInjectSkill(skill)) {
      continue;
    }
    parts.push(wrapped);
    loaded.push(skill);
    usedBytes += byteLen;
    if (injectedSkills) injectedSkills.add(skill);
  }
  if (droppedByCap.length > 0 || droppedByBudget.length > 0 || summaryOnly.length > 0 || skippedByConcurrentClaim.length > 0) {
    l.debug("cap-applied", {
      max: ceiling,
      budgetBytes: budget,
      usedBytes,
      totalCandidates: rankedSkills.length,
      selected: loaded.map((s) => ({ skill: s, mode: summaryOnly.includes(s) ? "summary" : "full" })),
      droppedByCap,
      droppedByBudget,
      summaryOnly,
      skippedByConcurrentClaim
    });
  }
  l.debug("skills-injected", { injected: loaded, summaryOnly, skippedByConcurrentClaim, totalParts: parts.length, usedBytes, budgetBytes: budget });
  return { parts, loaded, summaryOnly, droppedByCap, droppedByBudget, skippedByConcurrentClaim };
}
function formatPlatformOutput(platform, additionalContext, env) {
  if (platform === "cursor") {
    const output2 = {};
    if (additionalContext) {
      output2.additional_context = additionalContext;
    }
    if (env && Object.keys(env).length > 0) {
      output2.env = env;
    }
    return Object.keys(output2).length > 0 ? JSON.stringify(output2) : "{}";
  }
  const output = {};
  if (additionalContext) {
    const hookSpecificOutput = {
      hookEventName: "PreToolUse",
      additionalContext
    };
    output.hookSpecificOutput = hookSpecificOutput;
  }
  if (env && Object.keys(env).length > 0) {
    output.env = env;
  }
  return Object.keys(output).length > 0 ? JSON.stringify(output) : "{}";
}
function buildBanner(injectedSkills, toolName, toolTarget, matchReasons) {
  const lines = ["[vercel-plugin] Best practices auto-suggested based on detected patterns:"];
  for (const skill of injectedSkills) {
    const reason = matchReasons?.[skill];
    if (reason) {
      const target = toolName === "Bash" ? redactCommand(toolTarget) : toolTarget;
      lines.push(`  - "${skill}" matched ${reason.matchType} pattern \`${reason.pattern}\` on ${toolName}${target ? `: ${target}` : ""}`);
    } else {
      lines.push(`  - "${skill}"`);
    }
  }
  return lines.join("\n");
}
function encodeJsonForHtmlComment(value) {
  return JSON.stringify(value).replace(/-->/g, "--\\u003E");
}
function formatOutput({
  parts,
  matched,
  injectedSkills,
  contextChunks,
  summaryOnly,
  droppedByCap,
  droppedByBudget,
  toolName,
  toolTarget,
  matchReasons,
  reasons,
  skillMap,
  platform = "claude-code",
  env
}) {
  if (parts.length === 0) {
    return formatPlatformOutput(platform, void 0, env);
  }
  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    toolName,
    toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
    matchedSkills: [...matched],
    injectedSkills,
    contextChunks: contextChunks || [],
    summaryOnly: summaryOnly || [],
    droppedByBudget: droppedByBudget || []
  };
  if (reasons && Object.keys(reasons).length > 0) {
    skillInjection.reasons = reasons;
  }
  const metaComment = `<!-- skillInjection: ${encodeJsonForHtmlComment(skillInjection)} -->`;
  const banner = buildBanner(injectedSkills, toolName, toolTarget, matchReasons);
  const docsBlock = buildDocsBlock(injectedSkills, skillMap);
  const sections = [banner];
  if (docsBlock) sections.push(docsBlock);
  sections.push(parts.join("\n\n"));
  return formatPlatformOutput(platform, sections.join("\n\n") + "\n" + metaComment, env);
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
  const { toolName, toolInput, sessionId, cwd, platform, toolTarget, scopeId } = parsed;
  const runtimeEnvBefore = captureRuntimeEnvSnapshot();
  if (sessionId) {
    const toolEntries = [
      { key: "tool_call:tool_name", value: toolName },
      { key: "tool_call:target", value: toolTarget }
    ];
    if (toolName === "Bash") {
      toolEntries.push({ key: "tool_call:command", value: toolInput.command || "" });
    } else {
      toolEntries.push({ key: "tool_call:file_path", value: toolInput.file_path || "" });
    }
    trackBaseEvents(sessionId, toolEntries).catch(() => {
    });
  }
  const tSkillmap = log.active ? log.now() : 0;
  const skills = loadSkills(PLUGIN_ROOT, log);
  if (!skills) return "{}";
  if (log.active) timing.skillmap_load = Math.round(log.now() - tSkillmap);
  const { compiledSkills, usedManifest } = skills;
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasFileDedup = !dedupOff && !!sessionId;
  const seenEnv = typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string" ? process.env.VERCEL_PLUGIN_SEEN_SKILLS : "";
  const seenClaims = hasFileDedup ? listSessionKeys(sessionId, "seen-skills", scopeId).join(",") : "";
  const seenFile = hasFileDedup ? readSessionFile(sessionId, "seen-skills", scopeId) : "";
  const seenStateResult = dedupOff ? {
    seenEnv,
    seenState: hasFileDedup ? mergeSeenSkillStates(seenFile, seenClaims) : seenEnv,
    compactionResetApplied: false,
    clearedSkills: []
  } : mergeSeenSkillStatesWithCompactionReset(seenEnv, seenFile, seenClaims, {
    sessionId: hasFileDedup ? sessionId : void 0,
    includeEnv: !hasFileDedup,
    skillMap: skills.skillMap
  });
  const seenState = seenStateResult.seenState;
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const hasSeenSkillDedup = hasFileDedup || hasEnvDedup;
  const dedupStrategy = dedupOff ? "disabled" : hasFileDedup ? "file" : hasEnvDedup ? "env-var" : "memory-only";
  const likelySkillsEnv = process.env.VERCEL_PLUGIN_LIKELY_SKILLS || "";
  const likelySkills = parseLikelySkills(likelySkillsEnv);
  const setupMode = process.env.VERCEL_PLUGIN_SETUP_MODE === "1";
  log.debug("dedup-strategy", { strategy: dedupStrategy, sessionId, seenEnv: seenState });
  if (seenStateResult.compactionResetApplied) {
    log.debug("dedup-compaction-reset", {
      sessionId,
      scopeId,
      threshold: COMPACTION_REINJECT_MIN_PRIORITY,
      clearedSkills: seenStateResult.clearedSkills
    });
  }
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
  const { matchedEntries, matchReasons, matched } = matchResult;
  const vercelEnvHelp = checkVercelEnvHelp(toolName, toolInput, injectedSkills, dedupOff, log);
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
  const { newEntries, rankedSkills, profilerBoosted } = dedupResult;
  let vercelEnvHelpInjected = false;
  if (vercelEnvHelp.triggered) {
    let helpClaimed = true;
    if (sessionId) {
      helpClaimed = tryClaimSessionKey(sessionId, "seen-skills", VERCEL_ENV_HELP_ONCE_KEY, scopeId);
      if (helpClaimed) {
        syncSessionFileFromClaims(sessionId, "seen-skills", scopeId);
      }
    }
    if (helpClaimed) {
      vercelEnvHelpInjected = true;
      injectedSkills.add(VERCEL_ENV_HELP_ONCE_KEY);
      log.debug("vercel-env-help-injected", { subcommand: vercelEnvHelp.subcommand || "" });
    }
  }
  if (rankedSkills.length === 0 && !vercelEnvHelpInjected) {
    const reason = matched.size === 0 ? "no_matches" : "all_deduped";
    if (log.active) {
      timing.skill_read = 0;
      timing.total = log.elapsed();
    }
    log.complete(reason, {
      matchedCount: matched.size,
      dedupedCount: matched.size - rankedSkills.length,
      matchedSkills: [...matched],
      injectedSkills: [],
      boostsApplied: profilerBoosted
    }, log.active ? timing : null);
    const envUpdates2 = finalizeRuntimeEnvUpdates(platform, runtimeEnvBefore);
    return formatPlatformOutput(platform, void 0, envUpdates2);
  }
  const tSkillRead = log.active ? log.now() : 0;
  const { parts, loaded, summaryOnly, droppedByCap, droppedByBudget } = injectSkills(rankedSkills, {
    pluginRoot: PLUGIN_ROOT,
    hasEnvDedup: hasSeenSkillDedup,
    sessionId,
    scopeId,
    injectedSkills,
    skillMap: skills.skillMap,
    logger: log,
    platform
  });
  if (log.active) timing.skill_read = Math.round(log.now() - tSkillRead);
  if (vercelEnvHelpInjected) {
    parts.push(VERCEL_ENV_HELP);
    log.debug("vercel-env-help-appended", { subcommand: vercelEnvHelp.subcommand || "" });
  }
  const injectedContextChunks = [];
  if (!scopeId) {
    const chunk = selectManagedContextChunk(loaded, {
      pluginRoot: PLUGIN_ROOT,
      sessionId
    });
    if (chunk) {
      parts.push(chunk.wrapped);
      injectedContextChunks.push(chunk.chunkId);
      log.debug("managed-context-chunk-injected", {
        chunkId: chunk.chunkId,
        skill: chunk.skill,
        bytes: chunk.bytes
      });
    }
  }
  if (parts.length === 0) {
    if (log.active) timing.total = log.elapsed();
    log.complete("no_matches", {
      matchedCount: matched.size,
      dedupedCount: matchedEntries.length - newEntries.length,
      cappedCount: droppedByCap.length + droppedByBudget.length,
      matchedSkills: [...matched],
      injectedSkills: [],
      droppedByCap,
      droppedByBudget,
      boostsApplied: profilerBoosted
    }, log.active ? timing : null);
    const envUpdates2 = finalizeRuntimeEnvUpdates(platform, runtimeEnvBefore);
    return formatPlatformOutput(platform, void 0, envUpdates2);
  }
  if (log.active) timing.total = log.elapsed();
  const cappedCount = droppedByCap.length + droppedByBudget.length;
  log.complete("injected", {
    matchedCount: matched.size,
    injectedCount: parts.length,
    dedupedCount: matchedEntries.length - newEntries.length,
    cappedCount,
    matchedSkills: [...matched],
    injectedSkills: loaded,
    droppedByCap,
    droppedByBudget,
    boostsApplied: profilerBoosted
  }, log.active ? timing : null);
  const reasons = {};
  for (const skill of loaded) {
    if (!reasons[skill] && matchReasons?.[skill]) {
      reasons[skill] = {
        trigger: matchReasons[skill].matchType,
        reasonCode: "pattern-match"
      };
    }
  }
  const envUpdates = finalizeRuntimeEnvUpdates(platform, runtimeEnvBefore);
  const result = formatOutput({
    parts,
    matched,
    injectedSkills: loaded,
    contextChunks: injectedContextChunks,
    summaryOnly,
    droppedByCap,
    droppedByBudget,
    toolName,
    toolTarget,
    matchReasons,
    reasons,
    skillMap: skills.skillMap,
    platform,
    env: envUpdates
  });
  if (loaded.length > 0) {
    appendAuditLog({
      event: "skill-injection",
      toolName,
      toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
      matchedSkills: [...matched],
      injectedSkills: loaded,
      contextChunks: injectedContextChunks,
      summaryOnly,
      droppedByCap,
      droppedByBudget
    }, cwd);
    if (sessionId) {
      const telemetryEntries = [];
      for (const skill of loaded) {
        const reason = matchReasons?.[skill];
        telemetryEntries.push(
          { key: "skill:injected", value: skill },
          { key: "skill:hook", value: "PreToolUse" },
          { key: "skill:priority", value: "0" },
          { key: "skill:match_type", value: reason?.matchType ?? "unknown" },
          { key: "skill:tool_name", value: toolName }
        );
      }
      trackBaseEvents(sessionId, telemetryEntries).catch(() => {
      });
    }
  }
  return result;
}
var REDACT_MAX = 200;
var REDACT_RULES = [
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
var SKILL_INJECTION_VERSION = 1;
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
  captureRuntimeEnvSnapshot,
  checkVercelEnvHelp,
  collectRuntimeEnvUpdates,
  deduplicateSkills,
  formatOutput,
  injectSkills,
  loadSkills,
  matchSkills,
  parseInput,
  redactCommand,
  run,
  validateSkillMap
};
