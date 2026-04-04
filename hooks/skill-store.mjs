// hooks/src/skill-store.mts
import { join, resolve } from "path";
import {
  resolveProjectStatePaths,
  resolveVercelPluginHome
} from "./project-state-paths.mjs";
import {
  buildSkillMap,
  extractFrontmatter,
  validateSkillMap
} from "./skill-map-frontmatter.mjs";
import {
  compileSkillPatterns
} from "./patterns.mjs";
import { safeReadFile, safeReadJson } from "./hook-env.mjs";
function hasCompiledMatchers(entry) {
  if (!entry) return false;
  return entry.compiledPaths.length > 0 || entry.compiledBash.length > 0 || entry.compiledImports.length > 0;
}
function toStringArray(value) {
  return Array.isArray(value) ? value.filter(
    (entry) => typeof entry === "string" && entry.length > 0
  ) : [];
}
function shouldIncludeRulesManifest(options) {
  if (typeof options.includeRulesManifest === "boolean") {
    return options.includeRulesManifest;
  }
  if (typeof options.bundledFallback === "boolean") {
    return options.bundledFallback;
  }
  return process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1";
}
function defaultSkillStoreRoots(options) {
  const statePaths = resolveProjectStatePaths(options.projectRoot);
  const globalCacheDir = resolve(
    options.globalCacheDir ?? join(resolveVercelPluginHome(), "skills")
  );
  const pluginRoot = resolve(options.pluginRoot);
  const projectClaudeSkillsDir = join(
    resolve(options.projectRoot),
    ".claude",
    "skills"
  );
  const roots = [
    {
      source: "project-cache",
      rootDir: resolve(options.projectRoot),
      skillsDir: projectClaudeSkillsDir,
      manifestPath: join(projectClaudeSkillsDir, "manifest.json")
    },
    {
      source: "project-cache",
      rootDir: statePaths.stateRoot,
      skillsDir: statePaths.skillsDir,
      manifestPath: statePaths.manifestPath
    },
    {
      source: "global-cache",
      rootDir: globalCacheDir,
      skillsDir: globalCacheDir,
      manifestPath: join(globalCacheDir, "manifest.json")
    }
  ];
  if (shouldIncludeRulesManifest(options)) {
    roots.push({
      source: "rules-manifest",
      rootDir: pluginRoot,
      skillsDir: "",
      manifestPath: join(pluginRoot, "generated", "skill-rules.json")
    });
  }
  return roots;
}
function normalizeManifestSkill(raw) {
  const skill = {
    priority: typeof raw.priority === "number" ? raw.priority : 5,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    docs: toStringArray(raw.docs),
    pathPatterns: toStringArray(raw.pathPatterns),
    bashPatterns: toStringArray(raw.bashPatterns),
    importPatterns: toStringArray(raw.importPatterns),
    validate: Array.isArray(raw.validate) ? raw.validate : []
  };
  if (typeof raw.sitemap === "string" && raw.sitemap.length > 0) {
    skill.sitemap = raw.sitemap;
  }
  if (Array.isArray(raw.chainTo) && raw.chainTo.length > 0) {
    skill.chainTo = raw.chainTo;
  }
  if (Array.isArray(raw.coInject) && raw.coInject.length > 0) {
    skill.coInject = raw.coInject;
  }
  if (raw.greenfield === true || raw.greenfield === "true") {
    skill.greenfield = true;
  }
  if (raw.promptSignals && typeof raw.promptSignals === "object" && !Array.isArray(raw.promptSignals)) {
    skill.promptSignals = raw.promptSignals;
  }
  if (raw.retrieval && typeof raw.retrieval === "object" && !Array.isArray(raw.retrieval)) {
    skill.retrieval = raw.retrieval;
  }
  if (raw.hasRealBody === true) {
    skill.hasRealBody = true;
  }
  if (typeof raw.sessionStartEligible === "string") {
    skill.sessionStartEligible = raw.sessionStartEligible;
  }
  return skill;
}
function restoreCompiledSkillsFromManifest(manifestSkills, logger) {
  const compiled = [];
  for (const [skill, config] of Object.entries(manifestSkills)) {
    const compiledPaths = [];
    const compiledBash = [];
    const compiledImports = [];
    const pathPatterns = toStringArray(config.pathPatterns);
    const pathRegexSources = toStringArray(config.pathRegexSources);
    for (let i = 0; i < Math.min(pathPatterns.length, pathRegexSources.length); i++) {
      try {
        compiledPaths.push({
          pattern: pathPatterns[i],
          regex: new RegExp(pathRegexSources[i])
        });
      } catch (error) {
        logger?.issue?.(
          "PATH_REGEX_COMPILE_FAIL",
          `Failed to compile cached path regex for "${skill}"`,
          "Regenerate the cache manifest for this skill",
          {
            skill,
            pattern: pathPatterns[i],
            regexSource: pathRegexSources[i],
            error: String(error)
          }
        );
      }
    }
    const bashPatterns = toStringArray(config.bashPatterns);
    const bashRegexSources = toStringArray(config.bashRegexSources);
    for (let i = 0; i < Math.min(bashPatterns.length, bashRegexSources.length); i++) {
      try {
        compiledBash.push({
          pattern: bashPatterns[i],
          regex: new RegExp(bashRegexSources[i])
        });
      } catch (error) {
        logger?.issue?.(
          "BASH_REGEX_COMPILE_FAIL",
          `Failed to compile cached bash regex for "${skill}"`,
          "Regenerate the cache manifest for this skill",
          {
            skill,
            pattern: bashPatterns[i],
            regexSource: bashRegexSources[i],
            error: String(error)
          }
        );
      }
    }
    const importPatterns = toStringArray(config.importPatterns);
    const importRegexSources = Array.isArray(config.importRegexSources) ? config.importRegexSources : [];
    for (let i = 0; i < Math.min(importPatterns.length, importRegexSources.length); i++) {
      const regexSource = importRegexSources[i];
      if (!regexSource || typeof regexSource.source !== "string") continue;
      try {
        compiledImports.push({
          pattern: importPatterns[i],
          regex: new RegExp(
            regexSource.source,
            typeof regexSource.flags === "string" ? regexSource.flags : ""
          )
        });
      } catch (error) {
        logger?.issue?.(
          "IMPORT_REGEX_COMPILE_FAIL",
          `Failed to compile cached import regex for "${skill}"`,
          "Regenerate the cache manifest for this skill",
          {
            skill,
            pattern: importPatterns[i],
            regexSource,
            error: String(error)
          }
        );
      }
    }
    compiled.push({
      skill,
      priority: typeof config.priority === "number" ? config.priority : 0,
      compiledPaths,
      compiledBash,
      compiledImports
    });
  }
  return compiled;
}
function loadRootSkillSet(root, logger) {
  const manifest = safeReadJson(root.manifestPath);
  if (manifest?.skills && Object.keys(manifest.skills).length > 0) {
    const skillMap2 = Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, config]) => [
        skill,
        normalizeManifestSkill(config)
      ])
    );
    logger?.debug?.("skill-store-manifest-loaded", {
      source: root.source,
      manifestPath: root.manifestPath,
      skillCount: Object.keys(skillMap2).length,
      version: manifest.version ?? 1
    });
    return {
      root,
      skillMap: skillMap2,
      compiledSkills: manifest.version && manifest.version >= 2 ? restoreCompiledSkillsFromManifest(manifest.skills, logger) : compileSkillPatterns(skillMap2),
      usedManifest: true
    };
  }
  if (!root.skillsDir) return null;
  const built = buildSkillMap(root.skillsDir);
  if (built.diagnostics?.length) {
    for (const diagnostic of built.diagnostics) {
      logger?.issue?.(
        "SKILLMD_PARSE_FAIL",
        `Failed to parse SKILL.md in ${root.source}`,
        `Fix YAML frontmatter in ${diagnostic.file}`,
        diagnostic
      );
    }
  }
  const validation = validateSkillMap(built);
  if (!validation.ok) {
    logger?.issue?.(
      "SKILLMAP_VALIDATE_FAIL",
      `Skill map validation failed in ${root.source}`,
      "Fix the invalid SKILL.md frontmatter before retrying",
      {
        source: root.source,
        errors: "errors" in validation ? validation.errors : []
      }
    );
    return null;
  }
  const skillMap = validation.normalizedSkillMap.skills;
  if (Object.keys(skillMap).length === 0) {
    return null;
  }
  const callbacks = {
    onPathGlobError(skill, pattern, error) {
      logger?.issue?.(
        "PATH_GLOB_INVALID",
        `Invalid path pattern in "${skill}" from ${root.source}`,
        "Fix the pathPatterns entry",
        { skill, pattern, error: String(error) }
      );
    },
    onBashRegexError(skill, pattern, error) {
      logger?.issue?.(
        "BASH_REGEX_INVALID",
        `Invalid bash pattern in "${skill}" from ${root.source}`,
        "Fix the bashPatterns entry",
        { skill, pattern, error: String(error) }
      );
    },
    onImportPatternError(skill, pattern, error) {
      logger?.issue?.(
        "IMPORT_PATTERN_INVALID",
        `Invalid import pattern in "${skill}" from ${root.source}`,
        "Fix the importPatterns entry",
        { skill, pattern, error: String(error) }
      );
    }
  };
  logger?.debug?.("skill-store-scan-loaded", {
    source: root.source,
    skillsDir: root.skillsDir,
    skillCount: Object.keys(skillMap).length
  });
  return {
    root,
    skillMap,
    compiledSkills: compileSkillPatterns(skillMap, callbacks),
    usedManifest: false
  };
}
function createSkillStore(options, logger) {
  const includeRulesManifest = shouldIncludeRulesManifest(options);
  const roots = defaultSkillStoreRoots({ ...options, includeRulesManifest });
  logger?.debug?.("skill-store-roots-resolved", {
    includeRulesManifest,
    roots: roots.map((r) => ({
      source: r.source,
      rootDir: r.rootDir,
      skillsDir: r.skillsDir,
      manifestPath: r.manifestPath
    }))
  });
  let cachedSkillSet;
  let cachedInstalled;
  function loadCachedSkillSet(logger2) {
    if (cachedSkillSet !== void 0) return cachedSkillSet;
    const rootResults = roots.map((root) => loadRootSkillSet(root, logger2)).filter(
      (entry) => entry !== null
    );
    if (rootResults.length === 0) {
      cachedSkillSet = null;
      return null;
    }
    const skillMap = {};
    const compiledBySkill = /* @__PURE__ */ new Map();
    const origins = {};
    let usedManifest = false;
    for (const result of rootResults) {
      usedManifest = usedManifest || result.usedManifest;
      for (const [skill, config] of Object.entries(result.skillMap)) {
        if (!(skill in skillMap)) {
          skillMap[skill] = config;
          origins[skill] = result.root;
        }
      }
      for (const entry of result.compiledSkills) {
        const existing = compiledBySkill.get(entry.skill);
        if (!existing || !hasCompiledMatchers(existing) && hasCompiledMatchers(entry)) {
          compiledBySkill.set(entry.skill, entry);
        }
      }
    }
    cachedSkillSet = {
      roots: rootResults.map((entry) => entry.root),
      skillMap,
      compiledSkills: [...compiledBySkill.values()],
      origins,
      usedManifest
    };
    return cachedSkillSet;
  }
  return {
    roots,
    loadSkillSet(logger2) {
      return loadCachedSkillSet(logger2);
    },
    resolveSkill(name, logger2) {
      return loadCachedSkillSet(logger2)?.skillMap[name] ?? null;
    },
    resolveSkillBody(name, _logger) {
      for (const root of roots) {
        if (!root.skillsDir) continue;
        const path = join(root.skillsDir, name, "SKILL.md");
        const raw = safeReadFile(path);
        if (raw === null) continue;
        const { body } = extractFrontmatter(raw);
        return {
          skill: name,
          source: root.source,
          root,
          path,
          raw,
          body: body.trimStart()
        };
      }
      return null;
    },
    resolveSkillPayload(name, payloadLogger) {
      const loaded = loadCachedSkillSet(payloadLogger);
      const config = loaded?.skillMap[name];
      const root = loaded?.origins[name];
      if (!config || !root) return null;
      if (root.skillsDir) {
        const path = join(root.skillsDir, name, "SKILL.md");
        const raw = safeReadFile(path);
        if (raw !== null) {
          const { body } = extractFrontmatter(raw);
          const trimmedBody = body.trimStart();
          const mode = trimmedBody === "" ? "summary" : "body";
          payloadLogger?.debug?.("skill-store-payload-resolved", {
            skill: name,
            source: root.source,
            mode,
            path
          });
          return {
            skill: name,
            source: root.source,
            root,
            mode,
            path,
            raw,
            body: trimmedBody === "" ? null : trimmedBody,
            summary: config.summary ?? "",
            docs: config.docs ?? []
          };
        }
      }
      payloadLogger?.debug?.("skill-store-payload-resolved", {
        skill: name,
        source: root.source,
        mode: "summary",
        path: null
      });
      return {
        skill: name,
        source: root.source,
        root,
        mode: "summary",
        path: null,
        raw: null,
        body: null,
        summary: config.summary ?? "",
        docs: config.docs ?? []
      };
    },
    listInstalledSkills(logger2) {
      if (cachedInstalled !== void 0) return [...cachedInstalled];
      const loaded = loadCachedSkillSet(logger2);
      if (!loaded) {
        cachedInstalled = [];
        return [];
      }
      cachedInstalled = Object.entries(loaded.origins).filter(([, root]) => root.source !== "rules-manifest").map(([skill]) => skill).sort();
      return [...cachedInstalled];
    }
  };
}
export {
  createSkillStore,
  defaultSkillStoreRoots
};
