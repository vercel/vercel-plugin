#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginRoot as resolvePluginRoot, readSessionFile, safeReadFile, writeSessionFile } from "./hook-env.mjs";
import { buildSkillMap } from "./skill-map-frontmatter.mjs";
import {
  compileSkillPatterns,
  matchPathWithReason,
  matchImportWithReason
} from "./patterns.mjs";
import { createLogger } from "./logger.mjs";
const PLUGIN_ROOT = resolvePluginRoot();
const SUPPORTED_TOOLS = ["Write", "Edit"];
const log = createLogger();
function parseInput(raw, logger) {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    l.debug("posttooluse-validate-skip", { reason: "stdin_empty" });
    return null;
  }
  let input;
  try {
    input = JSON.parse(trimmed);
  } catch {
    l.debug("posttooluse-validate-skip", { reason: "stdin_parse_fail" });
    return null;
  }
  const toolName = input.tool_name || "";
  if (!SUPPORTED_TOOLS.includes(toolName)) {
    l.debug("posttooluse-validate-skip", { reason: "unsupported_tool", toolName });
    return null;
  }
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || "";
  if (!filePath) {
    l.debug("posttooluse-validate-skip", { reason: "no_file_path", toolName });
    return null;
  }
  const sessionId = input.session_id || null;
  const cwdCandidate = input.cwd ?? input.working_directory;
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : null;
  l.debug("posttooluse-validate-input", { toolName, filePath, sessionId });
  return { toolName, filePath, sessionId, cwd };
}
function loadValidateRules(pluginRoot, logger) {
  const l = logger || log;
  const skillsDir = join(pluginRoot, "skills");
  const { skills: skillMap } = buildSkillMap(skillsDir);
  const rulesMap = /* @__PURE__ */ new Map();
  for (const [slug, config] of Object.entries(skillMap)) {
    if (config.validate && config.validate.length > 0) {
      rulesMap.set(slug, config.validate);
    }
  }
  if (rulesMap.size === 0) {
    l.debug("posttooluse-validate-skip", { reason: "no_validate_rules" });
    return null;
  }
  const compiledSkills = compileSkillPatterns(skillMap);
  l.debug("posttooluse-validate-loaded", {
    totalSkills: Object.keys(skillMap).length,
    skillsWithRules: rulesMap.size
  });
  return { skillMap, compiledSkills, rulesMap };
}
function matchFileToSkills(filePath, fileContent, compiledSkills, rulesMap, logger) {
  const l = logger || log;
  const matched = [];
  for (const entry of compiledSkills) {
    if (!rulesMap.has(entry.skill)) continue;
    const pathMatch = matchPathWithReason(filePath, entry.compiledPaths);
    if (pathMatch) {
      matched.push(entry.skill);
      l.trace("posttooluse-validate-match", {
        skill: entry.skill,
        matchType: "path",
        pattern: pathMatch.pattern
      });
      continue;
    }
    const importMatch = matchImportWithReason(fileContent, entry.compiledImports);
    if (importMatch) {
      matched.push(entry.skill);
      l.trace("posttooluse-validate-match", {
        skill: entry.skill,
        matchType: "import",
        pattern: importMatch.pattern
      });
    }
  }
  l.debug("posttooluse-validate-matched", { matchedSkills: matched });
  return matched;
}
function runValidation(fileContent, matchedSkills, rulesMap, logger) {
  const l = logger || log;
  const violations = [];
  const lines = fileContent.split("\n");
  for (const skill of matchedSkills) {
    const rules = rulesMap.get(skill);
    if (!rules) continue;
    for (const rule of rules) {
      let regex;
      try {
        regex = new RegExp(rule.pattern, "g");
      } catch {
        l.debug("posttooluse-validate-regex-fail", {
          skill,
          pattern: rule.pattern
        });
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        const match = regex.exec(lines[i]);
        if (match) {
          violations.push({
            skill,
            line: i + 1,
            message: rule.message,
            severity: rule.severity,
            matchedText: match[0].slice(0, 80)
          });
        }
      }
    }
  }
  l.debug("posttooluse-validate-violations", {
    total: violations.length,
    errors: violations.filter((v) => v.severity === "error").length,
    warns: violations.filter((v) => v.severity === "warn").length
  });
  return violations;
}
function contentHash(content) {
  return createHash("md5").update(content).digest("hex").slice(0, 12);
}
function parseValidatedFiles(envValue) {
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return /* @__PURE__ */ new Set();
  }
  const set = /* @__PURE__ */ new Set();
  for (const part of envValue.split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") set.add(trimmed);
  }
  return set;
}
function appendValidatedFile(envValue, entry) {
  const current = typeof envValue === "string" ? envValue.trim() : "";
  return current === "" ? entry : `${current},${entry}`;
}
function isAlreadyValidated(filePath, hash, sessionId) {
  const entry = `${filePath}:${hash}`;
  const validated = parseValidatedFiles(process.env.VERCEL_PLUGIN_VALIDATED_FILES);
  if (validated.has(entry)) {
    return true;
  }
  if (!sessionId) {
    return false;
  }
  const persisted = parseValidatedFiles(readSessionFile(sessionId, "validated-files"));
  return persisted.has(entry);
}
function markValidated(filePath, hash, sessionId) {
  const entry = `${filePath}:${hash}`;
  const persistedState = sessionId ? readSessionFile(sessionId, "validated-files") : "";
  const current = process.env.VERCEL_PLUGIN_VALIDATED_FILES || persistedState;
  const next = appendValidatedFile(current, entry);
  process.env.VERCEL_PLUGIN_VALIDATED_FILES = next;
  if (sessionId) {
    writeSessionFile(sessionId, "validated-files", next);
  }
}
function formatOutput(violations, matchedSkills, filePath, logger) {
  const l = logger || log;
  if (violations.length === 0) {
    l.debug("posttooluse-validate-no-output", { reason: "no_actionable_violations" });
    return "{}";
  }
  const errors = violations.filter((v) => v.severity === "error");
  const warns = violations.filter((v) => v.severity === "warn");
  const hasErrors = errors.length > 0;
  const hasWarns = warns.length > 0;
  const bySkill = /* @__PURE__ */ new Map();
  for (const v of violations) {
    if (!bySkill.has(v.skill)) bySkill.set(v.skill, []);
    bySkill.get(v.skill).push(v);
  }
  const parts = [];
  for (const [skill, skillViolations] of bySkill) {
    const errorLines = skillViolations.filter((v) => v.severity === "error").map((v) => `- Line ${v.line} [ERROR]: ${v.message}`);
    const warnLines = skillViolations.filter((v) => v.severity === "warn").map((v) => `- Line ${v.line} [SUGGESTION]: ${v.message}`);
    parts.push([...errorLines, ...warnLines].join("\n"));
  }
  const skillList = [...bySkill.keys()].join(", ");
  const counts = [
    hasErrors ? `${errors.length} error${errors.length > 1 ? "s" : ""}` : "",
    hasWarns ? `${warns.length} suggestion${warns.length > 1 ? "s" : ""}` : ""
  ].filter(Boolean).join(", ");
  const callToAction = hasErrors ? `Please fix these issues before proceeding.` : `Consider applying these suggestions to follow best practices.`;
  const context = [
    `<!-- posttooluse-validate: ${skillList} -->`,
    `VALIDATION (${counts}) for \`${filePath}\`:`,
    ...parts,
    callToAction,
    `<!-- /posttooluse-validate -->`
  ].join("\n");
  const metadata = {
    version: 1,
    hook: "posttooluse-validate",
    filePath,
    matchedSkills,
    errorCount: errors.length,
    warnCount: warns.length
  };
  const metaComment = `<!-- postValidation: ${JSON.stringify(metadata)} -->`;
  const output = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context + "\n" + metaComment
    }
  };
  l.summary("posttooluse-validate-output", {
    filePath,
    matchedSkills,
    errorCount: errors.length,
    warnCount: warns.length
  });
  return JSON.stringify(output);
}
function run() {
  const timing = {};
  const tStart = log.active ? log.now() : 0;
  let raw;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
  const parsed = parseInput(raw, log);
  if (!parsed) return "{}";
  if (log.active) timing.parse = Math.round(log.now() - tStart);
  const { toolName, filePath, sessionId, cwd } = parsed;
  const resolvedPath = cwd ? resolve(cwd, filePath) : filePath;
  const fileContent = safeReadFile(resolvedPath);
  if (!fileContent) {
    log.debug("posttooluse-validate-skip", { reason: "file_unreadable", filePath: resolvedPath });
    return "{}";
  }
  const hash = contentHash(fileContent);
  if (isAlreadyValidated(filePath, hash, sessionId)) {
    log.debug("posttooluse-validate-skip", { reason: "already_validated", filePath, hash });
    return "{}";
  }
  const tLoad = log.active ? log.now() : 0;
  const data = loadValidateRules(PLUGIN_ROOT, log);
  if (!data) return "{}";
  if (log.active) timing.load = Math.round(log.now() - tLoad);
  const { compiledSkills, rulesMap } = data;
  const tMatch = log.active ? log.now() : 0;
  const matchedSkills = matchFileToSkills(filePath, fileContent, compiledSkills, rulesMap, log);
  if (log.active) timing.match = Math.round(log.now() - tMatch);
  if (matchedSkills.length === 0) {
    log.debug("posttooluse-validate-skip", { reason: "no_skill_match", filePath });
    markValidated(filePath, hash, sessionId);
    return "{}";
  }
  const tValidate = log.active ? log.now() : 0;
  const violations = runValidation(fileContent, matchedSkills, rulesMap, log);
  if (log.active) timing.validate = Math.round(log.now() - tValidate);
  markValidated(filePath, hash, sessionId);
  const result = formatOutput(violations, matchedSkills, filePath, log);
  log.complete("posttooluse-validate-done", {
    matchedCount: matchedSkills.length,
    injectedCount: violations.filter((v) => v.severity === "error").length
  }, timing);
  return result;
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
      `[${(/* @__PURE__ */ new Date()).toISOString()}] CRASH in posttooluse-validate.mts`,
      `  error: ${err?.message || String(err)}`,
      `  stack: ${err?.stack || "(no stack)"}`,
      `  PLUGIN_ROOT: ${PLUGIN_ROOT}`,
      ""
    ].join("\n");
    process.stderr.write(entry);
    process.stdout.write("{}");
  }
}
export {
  appendValidatedFile,
  contentHash,
  formatOutput,
  isAlreadyValidated,
  loadValidateRules,
  markValidated,
  matchFileToSkills,
  parseInput,
  parseValidatedFiles,
  run,
  runValidation
};
