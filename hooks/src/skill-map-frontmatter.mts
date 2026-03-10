/**
 * Standalone module that parses SKILL.md frontmatter to produce
 * the skill map shape used by the hook. This is the canonical source of truth.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeReadFile } from "./hook-env.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrontmatterResult {
  yaml: string;
  body: string;
}

export interface ValidationRule {
  pattern: string;
  message: string;
  severity: "error" | "recommended" | "warn";
  /** If set, skip this rule when the file content matches this regex. */
  skipIfFileContains?: string;
}

export interface RetrievalMetadata {
  aliases?: string[];
  intents?: string[];
  entities?: string[];
  examples?: string[];
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  summary: string;
  metadata: Record<string, unknown>;
  validate: ValidationRule[];
  retrieval?: RetrievalMetadata;
}

export interface ScannedSkill {
  dir: string;
  name: string;
  description: string;
  summary: string;
  metadata: Record<string, unknown>;
  validate: ValidationRule[];
  retrieval?: RetrievalMetadata;
}

export interface Diagnostic {
  file: string;
  error: string;
  message: string;
}

export interface ScanResult {
  skills: ScannedSkill[];
  diagnostics: Diagnostic[];
}

export interface PromptSignals {
  phrases: string[];
  allOf: string[][];
  anyOf: string[];
  noneOf: string[];
  minScore: number;
}

export interface SkillConfig {
  priority: number;
  summary: string;
  docs: string[];
  pathPatterns: string[];
  bashPatterns: string[];
  importPatterns: string[];
  validate: ValidationRule[];
  promptSignals?: PromptSignals;
  retrieval?: RetrievalMetadata;
}

export interface WarningDetail {
  code: string;
  skill: string;
  field: string;
  valueType: string;
  hint: string;
  message: string;
}

export interface ErrorDetail {
  code: string;
  skill: string;
  field: string;
  valueType: string;
  hint: string;
  message: string;
}

export interface SkillMapResult {
  skills: Record<string, SkillConfig>;
  diagnostics: Diagnostic[];
  warnings: string[];
  warningDetails: WarningDetail[];
}

export type ValidationResult =
  | {
      ok: true;
      normalizedSkillMap: { skills: Record<string, SkillConfig> };
      warnings: string[];
      warningDetails: WarningDetail[];
    }
  | {
      ok: false;
      errors: string[];
      errorDetails: ErrorDetail[];
    };

// ---------------------------------------------------------------------------
// Internal YAML parser types
// ---------------------------------------------------------------------------

type YamlScalar = string | number;
type YamlValue = YamlScalar | YamlValue[] | YamlObject;
interface YamlObject {
  [key: string]: YamlValue;
}

interface BlockResult {
  value: YamlValue;
  nextIndex: number;
}

// ---------------------------------------------------------------------------
// Exported: extractFrontmatter
// ---------------------------------------------------------------------------

/**
 * Extract YAML frontmatter and body from a markdown string.
 * Frontmatter must be delimited by --- on its own line at the very start.
 */
export function extractFrontmatter(markdown: string): FrontmatterResult {
  // Strip BOM (U+FEFF) if present
  let src = markdown;
  if (src.charCodeAt(0) === 0xfeff) {
    src = src.slice(1);
  }
  const match = src.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match) {
    return { yaml: "", body: src };
  }
  return { yaml: match[1], body: match[2] };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function invalidYaml(message: string, lineNumber?: number): Error {
  const location =
    typeof lineNumber === "number" ? ` (line ${lineNumber})` : "";
  return new Error(`Invalid YAML frontmatter: ${message}${location}`);
}

function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || line.trimStart().startsWith("#");
}

function nextSignificantLine(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i += 1) {
    if (!isIgnorableLine(lines[i])) return i;
  }
  return -1;
}

function countIndent(line: string): number {
  let indent = 0;
  while (indent < line.length) {
    const char = line[indent];
    if (char === " ") {
      indent += 1;
      continue;
    }
    if (char === "\t") {
      throw invalidYaml("tab indentation is not allowed");
    }
    break;
  }
  return indent;
}

function parseYamlScalar(raw: string): YamlScalar {
  const value = raw.trim();
  if (value === "") return "";

  const first = value[0];
  const last = value[value.length - 1];
  if (
    (first === "'" || first === '"') &&
    last === first &&
    value.length >= 2
  ) {
    return value.slice(1, -1);
  }
  if (first === "'" || first === '"') {
    throw invalidYaml("unterminated quoted scalar");
  }

  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
}

function parseInlineArray(raw: string): YamlValue[] {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw invalidYaml("inline array must start with '[' and end with ']'");
  }

  const inner = value.slice(1, -1);
  if (inner.trim() === "") return [];

  const items: string[] = [];
  let token = "";
  let quote: string | null = null;

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      token += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      token += char;
      continue;
    }

    if (char === ",") {
      const part = token.trim();
      if (part === "") {
        throw invalidYaml("inline array contains an empty entry");
      }
      items.push(part);
      token = "";
      continue;
    }

    token += char;
  }

  if (quote) {
    throw invalidYaml("unterminated quoted scalar in inline array");
  }

  const lastToken = token.trim();
  if (lastToken === "") {
    throw invalidYaml("inline array contains an empty entry");
  }
  items.push(lastToken);

  return items.map((item) => {
    if (item.trim().startsWith("[") && item.trim().endsWith("]")) {
      return parseInlineArray(item);
    }
    return parseYamlScalar(item);
  });
}

function parseInlineValue(raw: string): YamlValue {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseInlineArray(value);
  }
  return parseYamlScalar(value);
}

function parseYamlBlock(
  lines: string[],
  startIndex: number,
  indent: number,
): BlockResult {
  let index = nextSignificantLine(lines, startIndex);
  if (index === -1) {
    return { value: "", nextIndex: lines.length };
  }

  const firstIndent = countIndent(lines[index]);
  if (firstIndent < indent) {
    return { value: "", nextIndex: index };
  }
  if (firstIndent !== indent) {
    throw invalidYaml(
      `unexpected indentation, expected ${indent} spaces but found ${firstIndent}`,
      index + 1,
    );
  }

  const firstContent = lines[index].slice(indent);
  if (firstContent.startsWith("-")) {
    const arr: YamlValue[] = [];

    while (index < lines.length) {
      if (isIgnorableLine(lines[index])) {
        index += 1;
        continue;
      }

      const lineIndent = countIndent(lines[index]);
      if (lineIndent < indent) break;
      if (lineIndent !== indent) {
        throw invalidYaml(
          `unexpected indentation inside array, expected ${indent} spaces but found ${lineIndent}`,
          index + 1,
        );
      }

      const content = lines[index].slice(indent);
      if (!content.startsWith("-")) {
        throw invalidYaml("array items must start with '-'", index + 1);
      }

      const remainder = content.slice(1).trim();
      if (remainder !== "") {
        arr.push(parseInlineValue(remainder));
        index += 1;
        continue;
      }

      const childStart = nextSignificantLine(lines, index + 1);
      if (childStart === -1) {
        arr.push("");
        index += 1;
        continue;
      }

      const childIndent = countIndent(lines[childStart]);
      if (childIndent <= indent) {
        arr.push("");
        index += 1;
        continue;
      }

      const child = parseYamlBlock(lines, childStart, childIndent);
      arr.push(child.value);
      index = child.nextIndex;
    }

    return { value: arr, nextIndex: index };
  }

  const obj: YamlObject = {};
  while (index < lines.length) {
    if (isIgnorableLine(lines[index])) {
      index += 1;
      continue;
    }

    const lineIndent = countIndent(lines[index]);
    if (lineIndent < indent) break;
    if (lineIndent !== indent) {
      throw invalidYaml(
        `unexpected indentation inside object, expected ${indent} spaces but found ${lineIndent}`,
        index + 1,
      );
    }

    const content = lines[index].slice(indent);
    if (content.startsWith("-")) {
      throw invalidYaml(
        "found list item where key-value pair was expected",
        index + 1,
      );
    }

    const colonIndex = content.indexOf(":");
    if (colonIndex === -1) {
      throw invalidYaml("missing ':' in key-value pair", index + 1);
    }

    const key = content.slice(0, colonIndex).trim();
    if (key === "") {
      throw invalidYaml("empty key is not allowed", index + 1);
    }

    const remainder = content.slice(colonIndex + 1);
    if (remainder.trim() !== "") {
      obj[key] = parseInlineValue(remainder);
      index += 1;
      continue;
    }

    const childStart = nextSignificantLine(lines, index + 1);
    if (childStart === -1) {
      obj[key] = "";
      index += 1;
      continue;
    }

    const childIndent = countIndent(lines[childStart]);
    if (childIndent <= indent) {
      obj[key] = "";
      index += 1;
      continue;
    }

    const child = parseYamlBlock(lines, childStart, childIndent);
    obj[key] = child.value;
    index = child.nextIndex;
  }

  return { value: obj, nextIndex: index };
}

function parseSimpleYaml(yamlStr: string): YamlObject {
  const normalized = yamlStr.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const start = nextSignificantLine(lines, 0);
  if (start === -1) return {};

  const firstIndent = countIndent(lines[start]);
  if (firstIndent !== 0) {
    throw invalidYaml(
      `top-level entries must start at column 1 (found ${firstIndent} leading spaces)`,
      start + 1,
    );
  }

  const parsed = parseYamlBlock(lines, start, 0);
  const trailing = nextSignificantLine(lines, parsed.nextIndex);
  if (trailing !== -1) {
    throw invalidYaml("unexpected trailing content", trailing + 1);
  }

  if (
    parsed.value == null ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  ) {
    throw invalidYaml("root document must be a key-value object");
  }

  return parsed.value as YamlObject;
}

// ---------------------------------------------------------------------------
// Exported: parseSkillFrontmatter
// ---------------------------------------------------------------------------

/**
 * Parse a YAML frontmatter string into a structured skill object.
 */
/**
 * Parse a raw validate: YAML value into an array of ValidationRule objects.
 * Malformed entries are silently skipped.
 */
function parseValidateRules(raw: unknown): ValidationRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: ValidationRule[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.pattern !== "string" || obj.pattern === "") continue;
    if (typeof obj.message !== "string" || obj.message === "") continue;
    const severity = obj.severity;
    if (severity !== "error" && severity !== "recommended" && severity !== "warn") continue;
    const rule: ValidationRule = {
      pattern: obj.pattern,
      message: obj.message,
      severity,
    };
    if (typeof obj.skipIfFileContains === "string" && obj.skipIfFileContains !== "") {
      rule.skipIfFileContains = obj.skipIfFileContains;
    }
    rules.push(rule);
  }
  return rules;
}

export function parseSkillFrontmatter(yamlStr: string): SkillFrontmatter {
  if (!yamlStr || !yamlStr.trim()) {
    return { name: "", description: "", summary: "", metadata: {}, validate: [] };
  }
  const doc = parseSimpleYaml(yamlStr);
  return {
    name: typeof doc.name === "string" ? doc.name : "",
    description: typeof doc.description === "string" ? doc.description : "",
    summary: typeof doc.summary === "string" ? doc.summary : "",
    metadata:
      doc.metadata != null &&
      typeof doc.metadata === "object" &&
      !Array.isArray(doc.metadata)
        ? (doc.metadata as Record<string, unknown>)
        : {},
    validate: parseValidateRules(doc.validate),
    ...(doc.retrieval != null &&
      typeof doc.retrieval === "object" &&
      !Array.isArray(doc.retrieval)
      ? { retrieval: parseRetrievalBlock(doc.retrieval as Record<string, unknown>) }
      : {}),
  };
}

function parseRetrievalBlock(raw: Record<string, unknown>): RetrievalMetadata {
  const toStringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is string => typeof s === "string" && s !== "");
  };
  return {
    aliases: toStringArray(raw.aliases),
    intents: toStringArray(raw.intents),
    entities: toStringArray(raw.entities),
    examples: toStringArray(raw.examples),
  };
}

// ---------------------------------------------------------------------------
// Exported: scanSkillsDir
// ---------------------------------------------------------------------------

/**
 * Scan a skills root directory and return parsed skill objects alongside
 * structured diagnostics for any files that failed to parse.
 * Expects structure: rootDir/<skill-name>/SKILL.md
 *
 * @internal Consumed by buildSkillMap and tests only — not part of the public API.
 */
export function scanSkillsDir(rootDir: string): ScanResult {
  const skills: ScannedSkill[] = [];
  const diagnostics: Diagnostic[] = [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir) as string[];
  } catch {
    return { skills, diagnostics };
  }

  for (const entry of entries) {
    const skillDir = join(rootDir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = join(skillDir, "SKILL.md");
    const content = safeReadFile(skillFile);
    if (content === null) continue; // no SKILL.md in this directory

    let parsed: SkillFrontmatter;
    try {
      const { yaml: yamlStr } = extractFrontmatter(content);
      parsed = parseSkillFrontmatter(yamlStr);
    } catch (err: unknown) {
      const error = err as Error;
      diagnostics.push({
        file: skillFile,
        error: error.constructor?.name ?? "Error",
        message: error.message,
      });
      continue;
    }

    skills.push({
      dir: entry,
      name: parsed.name || entry,
      description: parsed.description,
      summary: parsed.summary,
      metadata: parsed.metadata,
      validate: parsed.validate,
      ...(parsed.retrieval ? { retrieval: parsed.retrieval } : {}),
    });
  }

  return { skills, diagnostics };
}

// ---------------------------------------------------------------------------
// Shared: normalizePatternField
// ---------------------------------------------------------------------------

interface NormalizePatternFieldOpts {
  raw: unknown;
  skill: string;
  field: string;
  fieldTypeHint: string; // e.g. "glob strings", "regex strings"
  coerceStrings: boolean;
  addWarning: (msg: string, detail: Omit<WarningDetail, "message">) => void;
}

/**
 * Normalize a pattern field (pathPatterns, bashPatterns, importPatterns) from
 * an unknown value into a validated string[].
 *
 * Handles: string→array coercion (opt-in), non-array fallback, and filtering
 * of non-string / empty entries — all with structured warnings.
 */
/**
 * Parse a raw promptSignals value from frontmatter metadata into a typed
 * PromptSignals object. Returns undefined if the value is missing/invalid.
 */
interface ParsePromptSignalsOpts {
  skill: string;
  addWarning?: (msg: string, detail: Omit<WarningDetail, "message">) => void;
}

function parsePromptSignals(
  raw: unknown,
  opts?: ParsePromptSignalsOpts,
): PromptSignals | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const skill = opts?.skill ?? "";
  const warn = opts?.addWarning;

  const toStringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x !== "");
  };

  // Count empty strings before filtering (for warning)
  const countEmptyStrings = (v: unknown): number => {
    if (!Array.isArray(v)) return 0;
    return v.filter((x) => typeof x === "string" && x === "").length;
  };

  const toStringArrayArray = (v: unknown): string[][] => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((g): g is unknown[] => Array.isArray(g))
      .map((g) => g.filter((x): x is string => typeof x === "string" && x !== ""))
      .filter((g) => g.length > 0);
  };

  // Count non-array elements in allOf (for warning)
  const countNonArrayAllOf = (v: unknown): number => {
    if (!Array.isArray(v)) return 0;
    return v.filter((g) => !Array.isArray(g)).length;
  };

  const phrases = toStringArray(obj.phrases);
  const allOf = toStringArrayArray(obj.allOf);
  const anyOf = toStringArray(obj.anyOf);
  const noneOf = toStringArray(obj.noneOf);
  const minScore =
    typeof obj.minScore === "number" && !Number.isNaN(obj.minScore)
      ? obj.minScore
      : 6;

  // Emit warnings for malformed promptSignals
  if (warn) {
    // PROMPT_SIGNALS_EMPTY_PHRASES: phrases is an array but all entries are empty or filtered out
    if (Array.isArray(obj.phrases) && phrases.length === 0) {
      warn(
        `skill "${skill}": promptSignals.phrases is empty after filtering`,
        {
          code: "PROMPT_SIGNALS_EMPTY_PHRASES",
          skill,
          field: "promptSignals.phrases",
          valueType: "array",
          hint: "Add at least one non-empty phrase string",
        },
      );
    }

    // Warn about empty strings in phrases
    const emptyCount = countEmptyStrings(obj.phrases);
    if (emptyCount > 0) {
      warn(
        `skill "${skill}": promptSignals.phrases contains ${emptyCount} empty string(s)`,
        {
          code: "PROMPT_SIGNALS_EMPTY_PHRASES",
          skill,
          field: "promptSignals.phrases",
          valueType: "array",
          hint: "Remove empty strings from phrases",
        },
      );
    }

    // PROMPT_SIGNALS_INVALID_ALLOF_GROUP: allOf contains non-array elements
    const nonArrayCount = countNonArrayAllOf(obj.allOf);
    if (nonArrayCount > 0) {
      warn(
        `skill "${skill}": promptSignals.allOf contains ${nonArrayCount} non-array element(s)`,
        {
          code: "PROMPT_SIGNALS_INVALID_ALLOF_GROUP",
          skill,
          field: "promptSignals.allOf",
          valueType: "array",
          hint: "Each allOf entry must be an array of strings (e.g. [term1, term2])",
        },
      );
    }

    // PROMPT_SIGNALS_LOW_MINSCORE: minScore below 1
    if (
      typeof obj.minScore === "number" &&
      !Number.isNaN(obj.minScore) &&
      obj.minScore < 1
    ) {
      warn(
        `skill "${skill}": promptSignals.minScore is ${obj.minScore}, below minimum of 1`,
        {
          code: "PROMPT_SIGNALS_LOW_MINSCORE",
          skill,
          field: "promptSignals.minScore",
          valueType: "number",
          hint: "Set minScore to at least 1",
        },
      );
    }
  }

  // Only return if there's at least one signal defined
  if (phrases.length === 0 && allOf.length === 0 && anyOf.length === 0 && noneOf.length === 0) {
    return undefined;
  }

  return { phrases, allOf, anyOf, noneOf, minScore };
}

function normalizePatternField(opts: NormalizePatternFieldOpts): string[] {
  const { raw, skill, field, fieldTypeHint, coerceStrings, addWarning } = opts;

  let arr: unknown[];
  if (coerceStrings && typeof raw === "string") {
    addWarning(
      `skill "${skill}": ${field} is a string, coercing to array`,
      {
        code: "COERCE_STRING_TO_ARRAY",
        skill,
        field,
        valueType: "string",
        hint: `Change ${field} to a YAML list`,
      },
    );
    arr = [raw];
  } else if (!Array.isArray(raw)) {
    addWarning(
      `skill "${skill}": ${field} is not an array (${typeof raw}), defaulting to []`,
      {
        code: "INVALID_TYPE",
        skill,
        field,
        valueType: typeof raw,
        hint: `${field} must be an array of ${fieldTypeHint}`,
      },
    );
    arr = [];
  } else {
    arr = raw as unknown[];
  }

  return arr.filter((p: unknown, i: number): p is string => {
    if (typeof p !== "string") {
      addWarning(
        `skill "${skill}": ${field}[${i}] is not a string (${typeof p}), removing`,
        {
          code: "ENTRY_NOT_STRING",
          skill,
          field: `${field}[${i}]`,
          valueType: typeof p,
          hint: `Each ${field} entry must be a string`,
        },
      );
      return false;
    }
    if (p === "") {
      addWarning(
        `skill "${skill}": ${field}[${i}] is empty, removing`,
        {
          code: "ENTRY_EMPTY",
          skill,
          field: `${field}[${i}]`,
          valueType: "string",
          hint: `Remove empty entries from ${field}`,
        },
      );
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Exported: buildSkillMap
// ---------------------------------------------------------------------------

/**
 * Build a skill map from SKILL.md frontmatter in the given skills directory.
 *
 * Output shape:
 * {
 *   "skills": {
 *     "<dir-name>": {
 *       "priority": <number>,    // defaults to 5
 *       "pathPatterns": [...],
 *       "bashPatterns": [...]
 *     }
 *   },
 *   "diagnostics": [...],
 *   "warnings": [...]
 * }
 */
export function buildSkillMap(rootDir: string): SkillMapResult {
  const skills: Record<string, SkillConfig> = {};
  const warnings: string[] = [];
  const warningDetails: WarningDetail[] = [];
  const { skills: parsed, diagnostics } = scanSkillsDir(rootDir);

  /**
   * Push a warning string (backwards compat) and a structured detail object.
   */
  function addWarning(
    msg: string,
    detail: Omit<WarningDetail, "message">,
  ): void {
    warnings.push(msg);
    warningDetails.push({ ...detail, message: msg });
  }

  for (const skill of parsed) {
    const meta = skill.metadata || {};

    // Read pathPatterns (canonical) with fallback to deprecated filePattern
    let rawPathPatterns: unknown;
    if (meta.pathPatterns !== undefined) {
      rawPathPatterns = meta.pathPatterns;
    } else if (meta.filePattern !== undefined) {
      rawPathPatterns = meta.filePattern;
      addWarning(
        `skill "${skill.dir}": metadata.filePattern is deprecated, rename to pathPatterns`,
        {
          code: "DEPRECATED_FIELD",
          skill: skill.dir,
          field: "filePattern",
          valueType: typeof meta.filePattern,
          hint: "Rename metadata.filePattern to metadata.pathPatterns",
        },
      );
    } else {
      rawPathPatterns = [];
    }

    const filteredPathPatterns = normalizePatternField({
      raw: rawPathPatterns,
      skill: skill.dir,
      field: "pathPatterns",
      fieldTypeHint: "glob strings",
      coerceStrings: true,
      addWarning,
    });

    // Read bashPatterns (canonical) with fallback to deprecated bashPattern
    let rawBashPatterns: unknown;
    if (meta.bashPatterns !== undefined) {
      rawBashPatterns = meta.bashPatterns;
    } else if (meta.bashPattern !== undefined) {
      rawBashPatterns = meta.bashPattern;
      addWarning(
        `skill "${skill.dir}": metadata.bashPattern is deprecated, rename to bashPatterns`,
        {
          code: "DEPRECATED_FIELD",
          skill: skill.dir,
          field: "bashPattern",
          valueType: typeof meta.bashPattern,
          hint: "Rename metadata.bashPattern to metadata.bashPatterns",
        },
      );
    } else {
      rawBashPatterns = [];
    }

    const filteredBashPatterns = normalizePatternField({
      raw: rawBashPatterns,
      skill: skill.dir,
      field: "bashPatterns",
      fieldTypeHint: "regex strings",
      coerceStrings: true,
      addWarning,
    });

    // Read importPatterns (optional -- regex patterns matched against file content imports)
    const rawImportPatterns: unknown =
      meta.importPatterns !== undefined ? meta.importPatterns : [];
    const filteredImportPatterns = normalizePatternField({
      raw: rawImportPatterns,
      skill: skill.dir,
      field: "importPatterns",
      fieldTypeHint: "package name strings",
      coerceStrings: true,
      addWarning,
    });

    // Parse optional promptSignals from metadata (with warnings)
    const promptSignals = parsePromptSignals(meta.promptSignals, {
      skill: skill.dir,
      addWarning,
    });

    // Parse docs (optional array of URL strings)
    const rawDocs: unknown = meta.docs !== undefined ? meta.docs : [];
    const filteredDocs = normalizePatternField({
      raw: rawDocs,
      skill: skill.dir,
      field: "docs",
      fieldTypeHint: "URL strings",
      coerceStrings: true,
      addWarning,
    });

    // Key by directory name -- the canonical identity of a skill.
    // Frontmatter `name` may differ; directory name is authoritative.
    const entry: SkillConfig = {
      priority: (meta.priority as number) ?? 5,
      summary: skill.summary || "",
      docs: filteredDocs,
      pathPatterns: filteredPathPatterns,
      bashPatterns: filteredBashPatterns,
      importPatterns: filteredImportPatterns,
      validate: skill.validate,
    };
    if (promptSignals) {
      entry.promptSignals = promptSignals;
    }
    if (skill.retrieval) {
      entry.retrieval = skill.retrieval;
    }
    skills[skill.dir] = entry;
  }

  return {
    skills,
    diagnostics,
    warnings,
    warningDetails,
  };
}

// ---------------------------------------------------------------------------
// Shared skill-map validator / normalizer
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set([
  "priority",
  "summary",
  "docs",
  "pathPatterns",
  "bashPatterns",
  "importPatterns",
  "validate",
  "promptSignals",
  "retrieval",
]);

/**
 * Validate and normalize a skill-map object (as produced by buildSkillMap).
 * Returns { ok: true, normalizedSkillMap, warnings } or { ok: false, errors }.
 *
 * This is the single source of truth for skill-map validation -- both the
 * PreToolUse hook and the validate script should consume this function.
 */
export function validateSkillMap(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const errorDetails: ErrorDetail[] = [];
  const warnings: string[] = [];
  const warningDetails: WarningDetail[] = [];

  function addError(msg: string, detail: Omit<ErrorDetail, "message">): void {
    errors.push(msg);
    errorDetails.push({ ...detail, message: msg });
  }

  function addWarning(
    msg: string,
    detail: Omit<WarningDetail, "message">,
  ): void {
    warnings.push(msg);
    warningDetails.push({ ...detail, message: msg });
  }

  if (raw == null || typeof raw !== "object") {
    return {
      ok: false,
      errors: ["skill-map must be a non-null object"],
      errorDetails: [
        {
          code: "INVALID_ROOT",
          skill: "",
          field: "",
          valueType: typeof raw,
          message: "skill-map must be a non-null object",
          hint: "Pass a valid skill-map object",
        },
      ],
    };
  }

  if (!("skills" in raw)) {
    return {
      ok: false,
      errors: ["skill-map is missing required 'skills' key"],
      errorDetails: [
        {
          code: "MISSING_SKILLS_KEY",
          skill: "",
          field: "skills",
          valueType: "undefined",
          message: "skill-map is missing required 'skills' key",
          hint: "Add a 'skills' key to the skill-map object",
        },
      ],
    };
  }

  const rawObj = raw as Record<string, unknown>;
  const skills = rawObj.skills;
  if (skills == null || typeof skills !== "object" || Array.isArray(skills)) {
    return {
      ok: false,
      errors: ["'skills' must be a non-null object (not an array)"],
      errorDetails: [
        {
          code: "SKILLS_NOT_OBJECT",
          skill: "",
          field: "skills",
          valueType: Array.isArray(skills) ? "array" : typeof skills,
          message: "'skills' must be a non-null object (not an array)",
          hint: "'skills' should be a plain object keyed by skill directory name",
        },
      ],
    };
  }

  const normalizedSkills: Record<string, SkillConfig> = {};

  for (const [skill, config] of Object.entries(
    skills as Record<string, unknown>,
  )) {
    if (config == null || typeof config !== "object" || Array.isArray(config)) {
      addError(`skill "${skill}": config must be a non-null object`, {
        code: "CONFIG_NOT_OBJECT",
        skill,
        field: "",
        valueType: Array.isArray(config) ? "array" : typeof config,
        hint: "Each skill config must be a plain object",
      });
      continue;
    }

    const cfg = config as Record<string, unknown>;

    // Warn on unknown keys
    for (const key of Object.keys(cfg)) {
      if (!KNOWN_KEYS.has(key)) {
        addWarning(`skill "${skill}": unknown key "${key}"`, {
          code: "UNKNOWN_KEY",
          skill,
          field: key,
          valueType: typeof cfg[key],
          hint: `Remove or rename unknown key "${key}"`,
        });
      }
    }

    // Normalize priority (default 5, matching buildSkillMap)
    let priority = 5;
    if ("priority" in cfg) {
      const p = cfg.priority;
      if (typeof p !== "number" || Number.isNaN(p)) {
        addWarning(
          `skill "${skill}": priority is not a valid number, defaulting to 5`,
          {
            code: "INVALID_PRIORITY",
            skill,
            field: "priority",
            valueType: typeof p,
            hint: "Set priority to a numeric value (e.g., 5)",
          },
        );
      } else {
        priority = p;
      }
    }

    // Normalize pattern fields — use the raw value if present, otherwise
    // default to [] so the helper correctly produces an empty array.
    const pathPatterns = normalizePatternField({
      raw: "pathPatterns" in cfg ? cfg.pathPatterns : [],
      skill,
      field: "pathPatterns",
      fieldTypeHint: "glob strings",
      coerceStrings: false,
      addWarning,
    });

    const bashPatterns = normalizePatternField({
      raw: "bashPatterns" in cfg ? cfg.bashPatterns : [],
      skill,
      field: "bashPatterns",
      fieldTypeHint: "regex strings",
      coerceStrings: false,
      addWarning,
    });

    const importPatterns = normalizePatternField({
      raw: "importPatterns" in cfg ? cfg.importPatterns : [],
      skill,
      field: "importPatterns",
      fieldTypeHint: "package name strings",
      coerceStrings: false,
      addWarning,
    });

    // Normalize summary (optional string, default "")
    const summary = typeof cfg.summary === "string" ? cfg.summary : "";

    // Normalize docs (optional array of URL strings, default [])
    const docs = normalizePatternField({
      raw: "docs" in cfg ? cfg.docs : [],
      skill,
      field: "docs",
      fieldTypeHint: "URL strings",
      coerceStrings: false,
      addWarning,
    });

    // Normalize validate (optional array of ValidationRule, default [])
    const validate = parseValidateRules(cfg.validate);

    // Normalize promptSignals (optional, preserved if valid, with warnings)
    const promptSignals = parsePromptSignals(cfg.promptSignals, {
      skill,
      addWarning,
    });

    const normalizedEntry: SkillConfig = {
      priority,
      summary,
      docs,
      pathPatterns,
      bashPatterns,
      importPatterns,
      validate,
    };
    if (promptSignals) {
      normalizedEntry.promptSignals = promptSignals;
    }
    if (cfg.retrieval != null && typeof cfg.retrieval === "object" && !Array.isArray(cfg.retrieval)) {
      normalizedEntry.retrieval = cfg.retrieval as RetrievalMetadata;
    }
    normalizedSkills[skill] = normalizedEntry;
  }

  if (errors.length > 0) {
    return { ok: false, errors, errorDetails };
  }

  return {
    ok: true,
    normalizedSkillMap: { skills: normalizedSkills },
    warnings,
    warningDetails,
  };
}
