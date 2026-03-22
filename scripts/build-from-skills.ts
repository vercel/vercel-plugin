#!/usr/bin/env bun
/**
 * Template include engine that resolves skill content into templates.
 *
 * Supports three marker formats:
 *   {{include:skill:<name>:<heading>}}           — extracts a markdown section by heading
 *   {{include:skill:<name>:frontmatter:<field>}} — extracts a frontmatter field value
 *   {{include:skill:<name>:file:<path>}}         — includes an entire file relative to the skill directory
 *   {{include:skill:<name>:file:<path>:<heading>}} — extracts a heading from a file relative to the skill directory
 *
 * Heading paths use the heading text (case-insensitive, ignoring leading #s).
 * The extracted section includes all content from the heading until the next
 * heading of equal or higher level (fewer or equal #s).
 *
 * Importable by other build scripts:
 *   import { extractSkillSection, resolveIncludes } from "./build-from-skills.ts";
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  extractFrontmatter,
  parseSkillFrontmatter,
} from "../hooks/skill-map-frontmatter.mjs";

export {
  extractSkillSection,
  resolveIncludes,
  loadSkillContent,
  compileTemplate,
  DiagnosticCode,
};
export type { CompileResult, CompileDiagnostic, ResolvedInclude, ResolveOptions, ManifestEntry, BuildManifest };

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_SKILLS_DIR = join(ROOT, "skills");

// ---------------------------------------------------------------------------
// Diagnostic codes and structured types
// ---------------------------------------------------------------------------

/** Stable error codes for machine-readable diagnostics. */
const DiagnosticCode = {
  SKILL_NOT_FOUND: "SKILL_NOT_FOUND",
  HEADING_NOT_FOUND: "HEADING_NOT_FOUND",
  FRONTMATTER_NOT_FOUND: "FRONTMATTER_NOT_FOUND",
  STALE_OUTPUT: "STALE_OUTPUT",
} as const;

type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

/** A single diagnostic emitted during compilation. */
interface CompileDiagnostic {
  code: DiagnosticCode;
  message: string;
  marker: string;
  /** Suggested fix or next step. */
  suggestion?: string;
}

/** A successfully resolved include with provenance. */
interface ResolvedInclude {
  marker: string;
  skillName: string;
  target: string;
  /** "section" or "frontmatter" */
  type: "section" | "frontmatter";
  /** Number of characters resolved. */
  contentLength: number;
  /** 1-based line number in the template where the marker appears. */
  lineNumber?: number;
}

/** Manifest entry for a single template file. */
interface ManifestEntry {
  template: string;
  output: string;
  dependencies: string[];
  includes: Array<{
    marker: string;
    skillName: string;
    target: string;
    type: "section" | "frontmatter";
    lineNumber: number;
  }>;
}

/** Top-level manifest structure. */
interface BuildManifest {
  version: 1;
  generatedAt: string;
  templates: ManifestEntry[];
}

/** Structured result from compileTemplate / resolveIncludes with structured: true. */
interface CompileResult {
  /** The fully resolved output string. */
  output: string;
  /** All successfully resolved includes. */
  resolved: ResolvedInclude[];
  /** Includes that could not be resolved (non-strict mode). */
  diagnostics: CompileDiagnostic[];
  /** Skill names referenced (resolved or not). */
  dependencies: string[];
}

// ---------------------------------------------------------------------------
// Internal: load + cache skill files
// ---------------------------------------------------------------------------

const skillCache = new Map<string, { body: string; yaml: string }>();

function loadSkillContent(
  skillName: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): { body: string; yaml: string } {
  const cacheKey = `${skillsDir}:${skillName}`;
  const cached = skillCache.get(cacheKey);
  if (cached) return cached;

  const skillFile = join(skillsDir, skillName, "SKILL.md");
  let raw: string;
  try {
    raw = readFileSync(skillFile, "utf-8");
  } catch {
    throw new Error(
      `Skill "${skillName}" not found: ${skillFile} does not exist`,
    );
  }

  const { yaml, body } = extractFrontmatter(raw);
  const result = { body, yaml };
  skillCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// extractSkillSection
// ---------------------------------------------------------------------------

/**
 * Extract the markdown content under a specific heading from a skill's SKILL.md.
 *
 * @param skillName  - Directory name of the skill (e.g. "ai-sdk")
 * @param heading    - Heading text to match (e.g. "Installation", "## Installation",
 *                     "Core Functions > Text Generation"). Case-insensitive.
 *                     Use ">" to specify a path through nested headings.
 * @param skillsDir  - Override skills root directory (default: <repo>/skills)
 * @returns The content under the heading (excluding the heading line itself),
 *          trimmed of leading/trailing whitespace.
 */
function extractSkillSection(
  skillName: string,
  heading: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): string {
  const { body } = loadSkillContent(skillName, skillsDir);
  return extractSectionFromMarkdown(body, heading);
}

/**
 * Parse heading text, stripping optional leading #s and whitespace.
 * Returns { level: number | null, text: string } where level is null if no #s were provided.
 */
function parseHeadingSpec(spec: string): { level: number | null; text: string } {
  const match = spec.match(/^(#{1,6})\s+(.+)$/);
  if (match) {
    return { level: match[1].length, text: match[2].trim().toLowerCase() };
  }
  return { level: null, text: spec.trim().toLowerCase() };
}

/**
 * Extract a section from markdown by heading. Supports ">" path separator for nested headings.
 */
function extractSectionFromMarkdown(markdown: string, headingPath: string): string {
  const parts = headingPath.split(">").map((p) => p.trim());

  // For single heading, extract directly
  if (parts.length === 1) {
    return extractDirectSection(markdown, parts[0]);
  }

  // For paths like "Core Functions > Text Generation", narrow scope at each level
  let scope = markdown;
  for (const part of parts) {
    scope = extractDirectSection(scope, part);
    if (!scope) return "";
  }
  return scope;
}

/**
 * Extract content from a heading to the next heading of equal or higher level.
 * Skips heading detection inside fenced code blocks (``` markers).
 */
function extractDirectSection(markdown: string, headingSpec: string): string {
  const { level: specLevel, text: specText } = parseHeadingSpec(headingSpec);
  const lines = markdown.split("\n");

  let startLine = -1;
  let headingLevel = 0;
  let inCodeBlock = false;

  // Find the matching heading (skip lines inside fenced code blocks)
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const hMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!hMatch) continue;

    const lineLevel = hMatch[1].length;
    const lineText = hMatch[2].trim().toLowerCase();

    if (lineText === specText && (specLevel === null || lineLevel === specLevel)) {
      startLine = i;
      headingLevel = lineLevel;
      break;
    }
  }

  if (startLine === -1) return "";

  // Collect lines until next heading of equal or higher level (skip code blocks)
  inCodeBlock = false;
  const contentLines: string[] = [];
  for (let i = startLine + 1; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inCodeBlock = !inCodeBlock;
      contentLines.push(lines[i]);
      continue;
    }
    if (inCodeBlock) {
      contentLines.push(lines[i]);
      continue;
    }
    const hMatch = lines[i].match(/^(#{1,6})\s+/);
    if (hMatch && hMatch[1].length <= headingLevel) break;
    contentLines.push(lines[i]);
  }

  return contentLines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// resolveIncludes
// ---------------------------------------------------------------------------

/** Regex for include markers: {{include:skill:<name>:<heading-or-frontmatter>}} */
const INCLUDE_RE = /\{\{include:skill:([^:}]+):([^}]+)\}\}/g;

/** Regex to detect frontmatter field references: frontmatter:<field> */
const FRONTMATTER_PREFIX = "frontmatter:";

/** Prefix to detect file references: file:<path> or file:<path>:<heading> */
const FILE_PREFIX = "file:";

interface ResolveOptions {
  skillsDir?: string;
  /** If true, throw on unresolved includes. Default: true. */
  strict?: boolean;
  /** If true, return CompileResult instead of bare string. Default: false. */
  structured?: boolean;
}

/**
 * Resolve all `{{include:skill:<name>:<target>}}` markers in a template string.
 *
 * When `options.structured` is true, returns a CompileResult with diagnostics.
 * Otherwise returns a bare string (original behavior).
 *
 * @param template - Template string with include markers
 * @param options  - Override skills directory, strictness, and structured mode
 * @returns The template with all markers replaced, or a CompileResult
 * @throws On unresolved includes (missing skill, missing heading/field) when strict=true and structured=false
 */
function resolveIncludes(template: string, options: ResolveOptions & { structured: true }): CompileResult;
function resolveIncludes(template: string, options?: ResolveOptions & { structured?: false }): string;
function resolveIncludes(template: string, options?: ResolveOptions): string | CompileResult;
function resolveIncludes(template: string, options: ResolveOptions = {}): string | CompileResult {
  const { skillsDir = DEFAULT_SKILLS_DIR, strict = true, structured = false } = options;
  const errors: string[] = [];
  const resolved: ResolvedInclude[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  const depSet = new Set<string>();

  const output = template.replace(INCLUDE_RE, (fullMatch, skillName: string, target: string, offset: number) => {
    depSet.add(skillName);
    const marker = fullMatch;
    // Compute 1-based line number from character offset
    const lineNumber = template.slice(0, offset).split("\n").length;

    try {
      if (target.startsWith(FRONTMATTER_PREFIX)) {
        const field = target.slice(FRONTMATTER_PREFIX.length);
        const content = resolveFrontmatterField(skillName, field, skillsDir);
        resolved.push({
          marker,
          skillName,
          target,
          type: "frontmatter",
          contentLength: content.length,
          lineNumber,
        });
        return content;
      }
      // File reference: file:<path> or file:<path>:<heading>
      if (target.startsWith(FILE_PREFIX)) {
        const fileTarget = target.slice(FILE_PREFIX.length);
        const content = resolveFileReference(skillName, fileTarget, skillsDir);
        resolved.push({
          marker,
          skillName,
          target,
          type: "section",
          contentLength: content.length,
          lineNumber,
        });
        return content;
      }
      // Section reference
      const section = extractSkillSection(skillName, target, skillsDir);
      if (!section) {
        throw new Error(
          `Heading "${target}" not found in skill "${skillName}"`,
        );
      }
      resolved.push({
        marker,
        skillName,
        target,
        type: "section",
        contentLength: section.length,
        lineNumber,
      });
      return section;
    } catch (err) {
      const errMsg = (err as Error).message;
      const msg = `Unresolved include {{include:skill:${skillName}:${target}}}: ${errMsg}`;

      // Classify the error
      const code = classifyError(errMsg);
      diagnostics.push({
        code,
        message: errMsg,
        marker,
        suggestion: suggestFix(code, skillName, target),
      });

      if (strict && !structured) {
        errors.push(msg);
      }
      return `<!-- ${msg} -->`;
    }
  });

  if (!structured && errors.length > 0) {
    throw new Error(
      `Failed to resolve ${errors.length} include(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  if (structured) {
    return { output, resolved, diagnostics, dependencies: [...depSet] };
  }

  return output;
}

/** Classify an error message into a stable diagnostic code. */
function classifyError(message: string): DiagnosticCode {
  if (/not found.*does not exist/i.test(message)) return DiagnosticCode.SKILL_NOT_FOUND;
  if (/heading.*not found/i.test(message)) return DiagnosticCode.HEADING_NOT_FOUND;
  if (/frontmatter.*not found/i.test(message)) return DiagnosticCode.FRONTMATTER_NOT_FOUND;
  // Default to SKILL_NOT_FOUND for other load errors
  if (/not found/i.test(message)) return DiagnosticCode.SKILL_NOT_FOUND;
  return DiagnosticCode.SKILL_NOT_FOUND;
}

/** Suggest a fix based on the diagnostic code. */
function suggestFix(code: DiagnosticCode, skillName: string, target: string): string {
  switch (code) {
    case DiagnosticCode.SKILL_NOT_FOUND:
      return `Check that skills/${skillName}/SKILL.md exists`;
    case DiagnosticCode.HEADING_NOT_FOUND:
      return `Check heading names in skills/${skillName}/SKILL.md — looking for "${target}"`;
    case DiagnosticCode.FRONTMATTER_NOT_FOUND:
      return `Check frontmatter fields in skills/${skillName}/SKILL.md — looking for "${target.replace("frontmatter:", "")}"`;
    case DiagnosticCode.STALE_OUTPUT:
      return `Run \`bun run build:from-skills\` to regenerate`;
    default:
      return "";
  }
}

/**
 * High-level compile API. Reads a template file, resolves includes, returns structured result.
 */
function compileTemplate(
  templatePath: string,
  opts: { skillsDir?: string } = {},
): CompileResult {
  const { skillsDir = DEFAULT_SKILLS_DIR } = opts;
  const template = readFileSync(templatePath, "utf-8");
  return resolveIncludes(template, { skillsDir, strict: false, structured: true });
}

/**
 * Resolve a file reference from a skill directory.
 * Supports two forms:
 *   file:<path>           — returns the entire file content
 *   file:<path>:<heading> — extracts a heading section from the file
 *
 * Path is relative to the skill directory (e.g. "references/type-safe-agents.md").
 */
function resolveFileReference(
  skillName: string,
  fileTarget: string,
  skillsDir: string,
): string {
  const colonIdx = fileTarget.indexOf(":");
  const filePath = colonIdx === -1 ? fileTarget : fileTarget.slice(0, colonIdx);
  const heading = colonIdx === -1 ? null : fileTarget.slice(colonIdx + 1);

  const fullPath = join(skillsDir, skillName, filePath);
  let content: string;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    throw new Error(
      `File "${filePath}" not found in skill "${skillName}": ${fullPath} does not exist`,
    );
  }

  if (!heading) {
    return content.trim();
  }

  const section = extractSectionFromMarkdown(content, heading);
  if (!section) {
    throw new Error(
      `Heading "${heading}" not found in file "${filePath}" of skill "${skillName}"`,
    );
  }
  return section;
}

/**
 * Resolve a frontmatter field from a skill's SKILL.md.
 */
function resolveFrontmatterField(
  skillName: string,
  field: string,
  skillsDir: string,
): string {
  const { yaml } = loadSkillContent(skillName, skillsDir);
  const frontmatter = parseSkillFrontmatter(yaml);

  // Support dotted paths like "metadata.priority"
  const parts = field.split(".");
  let value: unknown = frontmatter;
  for (const part of parts) {
    if (value == null || typeof value !== "object") {
      throw new Error(
        `Frontmatter field "${field}" not found in skill "${skillName}" (failed at "${part}")`,
      );
    }
    value = (value as Record<string, unknown>)[part];
  }

  if (value === undefined) {
    throw new Error(
      `Frontmatter field "${field}" not found in skill "${skillName}"`,
    );
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  // For arrays/objects, return JSON
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Clear cache (useful for tests)
// ---------------------------------------------------------------------------

export function clearSkillCache(): void {
  skillCache.clear();
}

// ---------------------------------------------------------------------------
// CLI runner: bun run build:from-skills [--dry-run] [filter...]
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { readdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { basename, dirname } = await import("node:path");

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const check = args.includes("--check");
  const jsonMode = args.includes("--json");
  const audit = args.includes("--audit");
  const skillIdx = args.indexOf("--skill");
  const skillQuery = skillIdx !== -1 ? args[skillIdx + 1] : null;
  const filters = args.filter((a) => !a.startsWith("--") && (skillIdx === -1 || args.indexOf(a) !== skillIdx + 1));

  const tmplDirs = [join(ROOT, "agents"), join(ROOT, "commands")];
  const templates: string[] = [];

  for (const dir of tmplDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md.tmpl")) continue;
      const fullPath = join(dir, f);
      if (filters.length === 0 || filters.some((flt) => fullPath.includes(flt))) {
        templates.push(fullPath);
      }
    }
  }

  if (templates.length === 0) {
    console.log("No .md.tmpl files found.");
    process.exit(0);
  }

  let changed = 0;
  let unchanged = 0;
  let stale = 0;
  const errors: string[] = [];
  const staleFiles: string[] = [];
  const jsonResults: Array<{
    template: string;
    output: string;
    status: "updated" | "unchanged" | "stale" | "error";
    result?: CompileResult;
    error?: string;
  }> = [];

  for (const tmpl of templates) {
    const outFile = tmpl.replace(/\.md\.tmpl$/, ".md");
    const templateContent = readFileSync(tmpl, "utf-8");
    const label = `${basename(dirname(tmpl))}/${basename(outFile)}`;

    if (jsonMode) {
      // Structured mode: always use compileTemplate-style resolution
      const result = resolveIncludes(templateContent, { strict: false, structured: true });
      const existing = existsSync(outFile) ? readFileSync(outFile, "utf-8") : "";
      const isStale = existing !== result.output;

      if (result.diagnostics.length > 0) {
        errors.push(`${tmpl}: ${result.diagnostics.length} unresolved include(s)`);
        jsonResults.push({ template: label, output: outFile, status: "error", result, error: result.diagnostics.map((d) => d.message).join("; ") });
      } else if (check && isStale) {
        stale++;
        staleFiles.push(label);
        // Add STALE_OUTPUT diagnostic
        result.diagnostics.push({
          code: DiagnosticCode.STALE_OUTPUT,
          message: `Output file is out of date`,
          marker: outFile,
          suggestion: "Run `bun run build:from-skills` to regenerate",
        });
        jsonResults.push({ template: label, output: outFile, status: "stale", result });
      } else if (isStale) {
        if (!dryRun) writeFileSync(outFile, result.output);
        changed++;
        jsonResults.push({ template: label, output: outFile, status: "updated", result });
      } else {
        unchanged++;
        jsonResults.push({ template: label, output: outFile, status: "unchanged", result });
      }
      continue;
    }

    try {
      const resolved = resolveIncludes(templateContent);

      if (dryRun) {
        console.log(resolved);
        continue;
      }

      const existing = existsSync(outFile) ? readFileSync(outFile, "utf-8") : "";

      if (existing === resolved) {
        unchanged++;
        if (!skillQuery) console.log(`  unchanged  ${label}`);
      } else if (check) {
        stale++;
        staleFiles.push(label);
        if (!skillQuery) console.log(`  STALE      ${label}`);
      } else {
        if (!skillQuery) writeFileSync(outFile, resolved);
        changed++;
        if (!skillQuery) console.log(`  updated    ${label}`);
      }
    } catch (err) {
      errors.push(`${tmpl}: ${(err as Error).message}`);
      console.error(`  ERROR      ${basename(dirname(tmpl))}/${basename(tmpl)}`);
      console.error(`             ${(err as Error).message}`);
    }
  }

  // --- Build manifest from all templates (always, regardless of mode) ---
  const manifestEntries: ManifestEntry[] = [];
  for (const tmpl of templates) {
    const outFile = tmpl.replace(/\.md\.tmpl$/, ".md");
    const templateContent = readFileSync(tmpl, "utf-8");
    const tmplLabel = `${basename(dirname(tmpl))}/${basename(tmpl)}`;
    const outLabel = `${basename(dirname(outFile))}/${basename(outFile)}`;
    const result = resolveIncludes(templateContent, { strict: false, structured: true });

    manifestEntries.push({
      template: tmplLabel,
      output: outLabel,
      dependencies: result.dependencies,
      includes: result.resolved.map((r) => ({
        marker: r.marker,
        skillName: r.skillName,
        target: r.target,
        type: r.type,
        lineNumber: r.lineNumber ?? 0,
      })),
    });
  }

  // --- Handle --skill <name> reverse-dependency query ---
  if (skillQuery) {
    const dependents = manifestEntries.filter((e) =>
      e.dependencies.includes(skillQuery),
    );
    if (dependents.length === 0) {
      console.log(`No templates depend on skill "${skillQuery}".`);
    } else {
      console.log(`Templates depending on skill "${skillQuery}":\n`);
      for (const entry of dependents) {
        console.log(`  ${entry.template}`);
        for (const inc of entry.includes.filter((i) => i.skillName === skillQuery)) {
          console.log(`    L${inc.lineNumber}: ${inc.marker}`);
        }
      }
    }
    process.exit(0);
  }

  // --- Handle --audit: per-template include coverage report ---
  if (audit) {
    const MIGRATION_THRESHOLD = 30;
    interface AuditEntry {
      template: string;
      totalBytes: number;
      includedBytes: number;
      coveragePercent: number;
      migrationCandidate: boolean;
    }
    const auditResults: AuditEntry[] = [];

    for (const tmpl of templates) {
      const templateContent = readFileSync(tmpl, "utf-8");
      const tmplLabel = `${basename(dirname(tmpl))}/${basename(tmpl)}`;
      const result = resolveIncludes(templateContent, { strict: false, structured: true });
      const totalBytes = Buffer.byteLength(result.output, "utf-8");
      const includedBytes = result.resolved.reduce((sum, r) => sum + r.contentLength, 0);
      const coveragePercent = totalBytes > 0 ? Math.round((includedBytes / totalBytes) * 100) : 0;

      auditResults.push({
        template: tmplLabel,
        totalBytes,
        includedBytes,
        coveragePercent,
        migrationCandidate: coveragePercent < MIGRATION_THRESHOLD,
      });
    }

    if (jsonMode) {
      console.log(JSON.stringify({ threshold: MIGRATION_THRESHOLD, templates: auditResults }, null, 2));
    } else {
      console.log("\nbuild:from-skills --audit\n");
      console.log("  Template                                       Coverage   Status");
      console.log("  ─────────────────────────────────────────────  ─────────  ──────────────────");
      for (const entry of auditResults) {
        const pct = `${entry.coveragePercent}%`.padStart(4);
        const bar = `(${entry.includedBytes}/${entry.totalBytes} bytes)`;
        const status = entry.migrationCandidate ? "⚠ MIGRATION CANDIDATE" : "✓ ok";
        console.log(`  ${entry.template.padEnd(47)} ${pct} ${bar.padEnd(22)} ${status}`);
      }

      const candidates = auditResults.filter((e) => e.migrationCandidate);
      console.log(`\n  ${candidates.length} of ${auditResults.length} templates below ${MIGRATION_THRESHOLD}% threshold`);
      if (candidates.length > 0) {
        console.log(`  Migration candidates: ${candidates.map((c) => c.template).join(", ")}`);
      }
    }
    process.exit(0);
  }

  // --- Emit manifest file ---
  if (!dryRun && !check) {
    const { mkdirSync } = await import("node:fs");
    const generatedDir = join(ROOT, "generated");
    mkdirSync(generatedDir, { recursive: true });

    const manifestPath = join(generatedDir, "build-from-skills.manifest.json");

    // If running a filtered build, merge new entries into the existing manifest
    // rather than overwriting it with a partial one.
    if (filters.length > 0 && existsSync(manifestPath)) {
      try {
        const existing: BuildManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const updatedTemplateNames = new Set(manifestEntries.map((e) => e.template));
        // Keep existing entries that weren't part of this filtered run
        const merged = existing.templates.filter((e) => !updatedTemplateNames.has(e.template));
        merged.push(...manifestEntries);
        // Sort by template name for stable ordering across filtered/full builds
        merged.sort((a, b) => a.template.localeCompare(b.template));
        const manifest: BuildManifest = {
          version: 1,
          generatedAt: new Date().toISOString(),
          templates: merged,
        };
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      } catch {
        // If existing manifest is corrupt, overwrite
        const manifest: BuildManifest = {
          version: 1,
          generatedAt: new Date().toISOString(),
          templates: manifestEntries,
        };
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      }
    } else {
      const manifest: BuildManifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        templates: manifestEntries,
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
  }

  if (jsonMode) {
    const summary = { changed, unchanged, stale, errors: errors.length, templates: jsonResults };
    console.log(JSON.stringify(summary, null, 2));
    if (errors.length > 0 || stale > 0) process.exit(1);
  } else if (!dryRun) {
    if (check) {
      console.log(`\nbuild:from-skills --check — ${stale} stale, ${unchanged} up-to-date, ${errors.length} errors`);
      if (stale > 0) {
        console.error(`\nStale files detected. Run \`bun run build:from-skills\` to update:\n${staleFiles.map((f) => `  - ${f}`).join("\n")}`);
      }
    } else {
      console.log(`\nbuild:from-skills — ${changed} updated, ${unchanged} unchanged, ${errors.length} errors`);
    }
    if (errors.length > 0 || stale > 0) process.exit(1);
  }
}
