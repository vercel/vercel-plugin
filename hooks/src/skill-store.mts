/**
 * Skill Store — cache-first skill resolution with layered roots.
 *
 * Resolution order (first match wins per slug):
 *   1. Project cache:  <projectRoot>/.skills/<slug>/SKILL.md
 *   2. Global cache:   ~/.vercel-plugin/skills/<slug>/SKILL.md
 *   3. Bundled fallback: <pluginRoot>/skills/<slug>/SKILL.md
 *
 * Each root may also carry a manifest.json (v2 format with pre-compiled regexes)
 * for fast startup. When present, the manifest is preferred over live scanning.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSkillMap,
  extractFrontmatter,
  validateSkillMap,
  type SkillConfig,
} from "./skill-map-frontmatter.mjs";
import {
  compileSkillPatterns,
  type CompileCallbacks,
  type CompiledPattern,
  type CompiledSkillEntry,
  type ManifestSkill,
} from "./patterns.mjs";
import { safeReadFile, safeReadJson } from "./hook-env.mjs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SkillSource = "project-cache" | "global-cache" | "bundled";

export interface SkillStoreLogger {
  debug?(event: string, data?: Record<string, unknown>): void;
  issue?(
    code: string,
    message: string,
    hint?: string,
    data?: Record<string, unknown>,
  ): void;
}

export interface SkillStoreRoot {
  source: SkillSource;
  rootDir: string;
  skillsDir: string;
  manifestPath: string;
}

export interface SkillStoreOptions {
  projectRoot: string;
  pluginRoot: string;
  globalCacheDir?: string;
  /** Set to false to disable the bundled fallback root (default: true). */
  bundledFallback?: boolean;
}

export interface LoadedSkillSet {
  roots: SkillStoreRoot[];
  skillMap: Record<string, SkillConfig>;
  compiledSkills: CompiledSkillEntry[];
  origins: Record<string, SkillStoreRoot>;
  usedManifest: boolean;
}

export interface ResolvedSkillBody {
  skill: string;
  source: SkillSource;
  root: SkillStoreRoot;
  path: string;
  raw: string;
  body: string;
}

export interface SkillStore {
  roots: SkillStoreRoot[];
  loadSkillSet(logger?: SkillStoreLogger): LoadedSkillSet | null;
  resolveSkill(name: string, logger?: SkillStoreLogger): SkillConfig | null;
  resolveSkillBody(
    name: string,
    logger?: SkillStoreLogger,
  ): ResolvedSkillBody | null;
  listInstalledSkills(logger?: SkillStoreLogger): string[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RawManifestSkill extends Partial<ManifestSkill> {
  sitemap?: string;
  promptSignals?: SkillConfig["promptSignals"];
  pathRegexSources?: string[];
  bashRegexSources?: string[];
  importRegexSources?: Array<{ source: string; flags: string }>;
  [key: string]: unknown;
}

interface ManifestDocument {
  version?: number;
  generatedAt?: string;
  skills?: Record<string, RawManifestSkill>;
}

interface LoadedRootSkillSet {
  root: SkillStoreRoot;
  skillMap: Record<string, SkillConfig>;
  compiledSkills: CompiledSkillEntry[];
  usedManifest: boolean;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
}

// ---------------------------------------------------------------------------
// Root construction
// ---------------------------------------------------------------------------

export function defaultSkillStoreRoots(
  options: SkillStoreOptions,
): SkillStoreRoot[] {
  const projectCacheDir = resolve(options.projectRoot, ".skills");
  const globalCacheDir = resolve(
    options.globalCacheDir ??
      join(homedir(), ".vercel-plugin", "skills"),
  );
  const pluginRoot = resolve(options.pluginRoot);

  const roots: SkillStoreRoot[] = [
    {
      source: "project-cache",
      rootDir: projectCacheDir,
      skillsDir: projectCacheDir,
      manifestPath: join(projectCacheDir, "manifest.json"),
    },
    {
      source: "global-cache",
      rootDir: globalCacheDir,
      skillsDir: globalCacheDir,
      manifestPath: join(globalCacheDir, "manifest.json"),
    },
  ];

  if (options.bundledFallback !== false) {
    roots.push({
      source: "bundled",
      rootDir: pluginRoot,
      skillsDir: join(pluginRoot, "skills"),
      manifestPath: join(pluginRoot, "generated", "skill-manifest.json"),
    });
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Manifest normalisation helpers
// ---------------------------------------------------------------------------

function normalizeManifestSkill(raw: RawManifestSkill): SkillConfig {
  const skill: SkillConfig = {
    priority: typeof raw.priority === "number" ? raw.priority : 5,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    docs: toStringArray(raw.docs),
    pathPatterns: toStringArray(raw.pathPatterns),
    bashPatterns: toStringArray(raw.bashPatterns),
    importPatterns: toStringArray(raw.importPatterns),
    validate: Array.isArray(raw.validate)
      ? (raw.validate as SkillConfig["validate"])
      : [],
  };

  if (typeof raw.sitemap === "string" && raw.sitemap.length > 0) {
    skill.sitemap = raw.sitemap;
  }
  if (Array.isArray(raw.chainTo) && raw.chainTo.length > 0) {
    skill.chainTo = raw.chainTo as SkillConfig["chainTo"];
  }
  if (
    raw.promptSignals &&
    typeof raw.promptSignals === "object" &&
    !Array.isArray(raw.promptSignals)
  ) {
    skill.promptSignals = raw.promptSignals as SkillConfig["promptSignals"];
  }
  if (
    raw.retrieval &&
    typeof raw.retrieval === "object" &&
    !Array.isArray(raw.retrieval)
  ) {
    skill.retrieval = raw.retrieval as SkillConfig["retrieval"];
  }

  return skill;
}

function restoreCompiledSkillsFromManifest(
  manifestSkills: Record<string, RawManifestSkill>,
  logger?: SkillStoreLogger,
): CompiledSkillEntry[] {
  const compiled: CompiledSkillEntry[] = [];

  for (const [skill, config] of Object.entries(manifestSkills)) {
    const compiledPaths: CompiledPattern[] = [];
    const compiledBash: CompiledPattern[] = [];
    const compiledImports: CompiledPattern[] = [];

    const pathPatterns = toStringArray(config.pathPatterns);
    const pathRegexSources = toStringArray(config.pathRegexSources);
    for (
      let i = 0;
      i < Math.min(pathPatterns.length, pathRegexSources.length);
      i++
    ) {
      try {
        compiledPaths.push({
          pattern: pathPatterns[i],
          regex: new RegExp(pathRegexSources[i]),
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
            error: String(error),
          },
        );
      }
    }

    const bashPatterns = toStringArray(config.bashPatterns);
    const bashRegexSources = toStringArray(config.bashRegexSources);
    for (
      let i = 0;
      i < Math.min(bashPatterns.length, bashRegexSources.length);
      i++
    ) {
      try {
        compiledBash.push({
          pattern: bashPatterns[i],
          regex: new RegExp(bashRegexSources[i]),
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
            error: String(error),
          },
        );
      }
    }

    const importPatterns = toStringArray(config.importPatterns);
    const importRegexSources = Array.isArray(config.importRegexSources)
      ? config.importRegexSources
      : [];
    for (
      let i = 0;
      i < Math.min(importPatterns.length, importRegexSources.length);
      i++
    ) {
      const regexSource = importRegexSources[i];
      if (!regexSource || typeof regexSource.source !== "string") continue;
      try {
        compiledImports.push({
          pattern: importPatterns[i],
          regex: new RegExp(
            regexSource.source,
            typeof regexSource.flags === "string" ? regexSource.flags : "",
          ),
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
            error: String(error),
          },
        );
      }
    }

    compiled.push({
      skill,
      priority: typeof config.priority === "number" ? config.priority : 0,
      compiledPaths,
      compiledBash,
      compiledImports,
    });
  }

  return compiled;
}

// ---------------------------------------------------------------------------
// Per-root loader
// ---------------------------------------------------------------------------

function loadRootSkillSet(
  root: SkillStoreRoot,
  logger?: SkillStoreLogger,
): LoadedRootSkillSet | null {
  // Try manifest first
  const manifest = safeReadJson<ManifestDocument>(root.manifestPath);
  if (manifest?.skills && Object.keys(manifest.skills).length > 0) {
    const skillMap = Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, config]) => [
        skill,
        normalizeManifestSkill(config),
      ]),
    );

    logger?.debug?.("skill-store-manifest-loaded", {
      source: root.source,
      manifestPath: root.manifestPath,
      skillCount: Object.keys(skillMap).length,
      version: manifest.version ?? 1,
    });

    return {
      root,
      skillMap,
      compiledSkills:
        manifest.version && manifest.version >= 2
          ? restoreCompiledSkillsFromManifest(manifest.skills, logger)
          : compileSkillPatterns(skillMap),
      usedManifest: true,
    };
  }

  // Fall back to live SKILL.md scan
  const built = buildSkillMap(root.skillsDir);
  if (built.diagnostics?.length) {
    for (const diagnostic of built.diagnostics) {
      logger?.issue?.(
        "SKILLMD_PARSE_FAIL",
        `Failed to parse SKILL.md in ${root.source}`,
        `Fix YAML frontmatter in ${diagnostic.file}`,
        diagnostic as unknown as Record<string, unknown>,
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
        errors: "errors" in validation ? validation.errors : [],
      },
    );
    return null;
  }

  const skillMap = validation.normalizedSkillMap.skills;
  if (Object.keys(skillMap).length === 0) {
    return null;
  }

  const callbacks: CompileCallbacks = {
    onPathGlobError(skill, pattern, error) {
      logger?.issue?.(
        "PATH_GLOB_INVALID",
        `Invalid path pattern in "${skill}" from ${root.source}`,
        "Fix the pathPatterns entry",
        { skill, pattern, error: String(error) },
      );
    },
    onBashRegexError(skill, pattern, error) {
      logger?.issue?.(
        "BASH_REGEX_INVALID",
        `Invalid bash pattern in "${skill}" from ${root.source}`,
        "Fix the bashPatterns entry",
        { skill, pattern, error: String(error) },
      );
    },
    onImportPatternError(skill, pattern, error) {
      logger?.issue?.(
        "IMPORT_PATTERN_INVALID",
        `Invalid import pattern in "${skill}" from ${root.source}`,
        "Fix the importPatterns entry",
        { skill, pattern, error: String(error) },
      );
    },
  };

  logger?.debug?.("skill-store-scan-loaded", {
    source: root.source,
    skillsDir: root.skillsDir,
    skillCount: Object.keys(skillMap).length,
  });

  return {
    root,
    skillMap,
    compiledSkills: compileSkillPatterns(skillMap, callbacks),
    usedManifest: false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSkillStore(options: SkillStoreOptions): SkillStore {
  const roots = defaultSkillStoreRoots(options);

  return {
    roots,

    loadSkillSet(logger?: SkillStoreLogger): LoadedSkillSet | null {
      const rootResults = roots
        .map((root) => loadRootSkillSet(root, logger))
        .filter(
          (entry): entry is LoadedRootSkillSet => entry !== null,
        );

      if (rootResults.length === 0) {
        return null;
      }

      // Merge with per-slug precedence: project > global > bundled
      const skillMap: Record<string, SkillConfig> = {};
      const compiledBySkill = new Map<string, CompiledSkillEntry>();
      const origins: Record<string, SkillStoreRoot> = {};
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
          if (!compiledBySkill.has(entry.skill)) {
            compiledBySkill.set(entry.skill, entry);
          }
        }
      }

      return {
        roots: rootResults.map((entry) => entry.root),
        skillMap,
        compiledSkills: [...compiledBySkill.values()],
        origins,
        usedManifest,
      };
    },

    resolveSkill(
      name: string,
      logger?: SkillStoreLogger,
    ): SkillConfig | null {
      const loaded = this.loadSkillSet(logger);
      return loaded?.skillMap[name] ?? null;
    },

    resolveSkillBody(
      name: string,
      _logger?: SkillStoreLogger,
    ): ResolvedSkillBody | null {
      for (const root of roots) {
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
          body: body.trimStart(),
        };
      }
      return null;
    },

    listInstalledSkills(logger?: SkillStoreLogger): string[] {
      const installed = new Set<string>();
      for (const root of roots) {
        if (root.source === "bundled") continue;
        const loaded = loadRootSkillSet(root, logger);
        if (!loaded) continue;
        for (const skill of Object.keys(loaded.skillMap)) {
          installed.add(skill);
        }
      }
      return [...installed].sort();
    },
  };
}
