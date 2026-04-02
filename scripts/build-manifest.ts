#!/usr/bin/env bun
/**
 * Compiles engine/*.md rule files into generated/skill-rules.json.
 *
 * Each engine file has YAML frontmatter with matching rules (pathPatterns,
 * bashPatterns, importPatterns, promptSignals, validate, chainTo, etc.)
 * and a markdown body used as the summary fallback when the registry
 * skill isn't cached locally.
 *
 * The compiled output pre-computes glob→regex conversions for runtime speed.
 *
 * Usage:  bun run scripts/build-manifest.ts
 */

import { resolve, join } from "node:path";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { globToRegex, importPatternToRegex } from "../hooks/patterns.mjs";

const ROOT = resolve(import.meta.dir, "..");
const ENGINE_DIR = join(ROOT, "engine");
const OUT_DIR = join(ROOT, "generated");
const OUT_FILE = join(OUT_DIR, "skill-rules.json");

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal, handles the engine file format)
// ---------------------------------------------------------------------------

function extractFrontmatter(content: string): { yaml: string; body: string } | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  return {
    yaml: content.slice(4, end),
    body: content.slice(end + 4).trim(),
  };
}

/**
 * Minimal YAML parser for the engine frontmatter format.
 * Handles: scalars, arrays (- items and [inline]), nested objects (2-space indent).
 * Does NOT handle full YAML spec — just enough for our frontmatter.
 */
function parseYaml(yaml: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    // Top-level key
    const keyMatch = line.match(/^([a-zA-Z_][\w]*)\s*:\s*(.*)/);
    if (!keyMatch) { i++; continue; }

    const key = keyMatch[1];
    const valueStr = keyMatch[2].trim();

    if (valueStr === "") {
      // Check if next lines are array items or nested object
      const nested = collectBlock(lines, i + 1, 2);
      if (nested.lines.length > 0 && nested.lines[0].trimStart().startsWith("-")) {
        result[key] = parseArray(nested.lines, 2);
      } else {
        result[key] = parseNestedObject(nested.lines, 2);
      }
      i = nested.nextIndex;
    } else if (valueStr.startsWith("[")) {
      result[key] = parseInlineArray(valueStr);
      i++;
    } else {
      result[key] = unquote(valueStr);
      i++;
    }
  }

  return result;
}

function collectBlock(lines: string[], start: number, indent: number): { lines: string[]; nextIndex: number } {
  const collected: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) break;
    collected.push(line);
    i++;
  }
  return { lines: collected, nextIndex: i };
}

function parseArray(lines: string[], baseIndent: number): any[] {
  const result: any[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("-")) { i++; continue; }

    const afterDash = trimmed.slice(1).trim();

    // Check if this is an array of objects (- key: value)
    if (afterDash.match(/^[a-zA-Z_][\w]*\s*:/)) {
      const obj: Record<string, any> = {};
      // First key on the dash line
      const firstMatch = afterDash.match(/^([a-zA-Z_][\w]*)\s*:\s*(.*)/);
      if (firstMatch) {
        obj[firstMatch[1]] = unquote(firstMatch[2].trim());
      }
      // Subsequent indented keys
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trimStart();
        const nextIndent = nextLine.length - nextTrimmed.length;
        if (nextIndent <= baseIndent || nextTrimmed.startsWith("-")) break;
        const kvMatch = nextTrimmed.match(/^([a-zA-Z_][\w]*)\s*:\s*(.*)/);
        if (kvMatch) {
          obj[kvMatch[1]] = unquote(kvMatch[2].trim());
        }
        i++;
      }
      result.push(obj);
    } else if (afterDash.startsWith("[")) {
      result.push(parseInlineArray(afterDash));
      i++;
    } else {
      result.push(unquote(afterDash));
      i++;
    }
  }

  return result;
}

function parseNestedObject(lines: string[], baseIndent: number): Record<string, any> {
  const result: Record<string, any> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const kvMatch = trimmed.match(/^([a-zA-Z_][\w]*)\s*:\s*(.*)/);
    if (!kvMatch) { i++; continue; }

    const key = kvMatch[1];
    const valueStr = kvMatch[2].trim();

    if (valueStr === "") {
      const nested = collectNestedBlock(lines, i + 1, baseIndent + 2);
      if (nested.lines.length > 0 && nested.lines[0].trimStart().startsWith("-")) {
        result[key] = parseArray(nested.lines, baseIndent + 2);
      } else {
        result[key] = parseNestedObject(nested.lines, baseIndent + 2);
      }
      i = nested.nextIndex;
    } else if (valueStr.startsWith("[")) {
      result[key] = parseInlineArray(valueStr);
      i++;
    } else {
      result[key] = unquote(valueStr);
      i++;
    }
  }

  return result;
}

function collectNestedBlock(lines: string[], start: number, indent: number): { lines: string[]; nextIndex: number } {
  const collected: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) break;
    collected.push(line);
    i++;
  }
  return { lines: collected, nextIndex: i };
}

function parseInlineArray(s: string): any[] {
  // [item1, item2, "item 3"]
  const inner = s.slice(1, s.lastIndexOf("]")).trim();
  if (!inner) return [];
  // Split on commas not inside brackets/quotes
  const items: string[] = [];
  let depth = 0;
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of inner) {
    if (inQuote) {
      current += ch;
      if (ch === quoteChar) inQuote = false;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
    } else if (ch === "[") {
      depth++;
      current += ch;
    } else if (ch === "]") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items.map(unquote);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  // Parse numbers
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s) as any;
  return s;
}

// ---------------------------------------------------------------------------
// Regex compilation (reuses hook patterns module)
// ---------------------------------------------------------------------------

function compileRegexSources(config: Record<string, any>) {
  const pathPatterns: string[] = [];
  const pathRegexSources: string[] = [];
  for (const p of config.pathPatterns || []) {
    try {
      pathRegexSources.push(globToRegex(p).source);
      pathPatterns.push(p);
    } catch { /* skip invalid */ }
  }

  const bashPatterns: string[] = [];
  const bashRegexSources: string[] = [];
  for (const p of config.bashPatterns || []) {
    try {
      new RegExp(p);
      bashRegexSources.push(p);
      bashPatterns.push(p);
    } catch { /* skip invalid */ }
  }

  const importPatterns: string[] = [];
  const importRegexSources: Array<{ source: string; flags: string }> = [];
  for (const p of config.importPatterns || []) {
    try {
      const re = importPatternToRegex(p);
      importRegexSources.push({ source: re.source, flags: re.flags });
      importPatterns.push(p);
    } catch { /* skip invalid */ }
  }

  return { pathPatterns, pathRegexSources, bashPatterns, bashRegexSources, importPatterns, importRegexSources };
}

// ---------------------------------------------------------------------------
// Auto-synthesize chainTo from validate upgradeToSkill rules
// ---------------------------------------------------------------------------

function synthesizeChainTo(skills: Record<string, any>): { count: number; warnings: string[] } {
  let count = 0;
  const warnings: string[] = [];
  const allSlugs = new Set(Object.keys(skills));

  for (const [slug, config] of Object.entries(skills)) {
    if (!config.validate?.length) continue;
    const existingTargets = new Set((config.chainTo ?? []).map((c: any) => c.targetSkill));

    for (const rule of config.validate) {
      if (!rule.upgradeToSkill) continue;
      if (rule.severity !== "error" && rule.severity !== "recommended") continue;
      if (existingTargets.has(rule.upgradeToSkill)) continue;
      if (!allSlugs.has(rule.upgradeToSkill)) {
        warnings.push(`skill "${slug}": upgradeToSkill "${rule.upgradeToSkill}" not found`);
        continue;
      }
      if (!config.chainTo) config.chainTo = [];
      config.chainTo.push({
        pattern: rule.pattern,
        targetSkill: rule.upgradeToSkill,
        message: rule.upgradeWhy || `${rule.message} — loading ${rule.upgradeToSkill} guidance.`,
        synthesized: true,
      });
      existingTargets.add(rule.upgradeToSkill);
      count++;
    }
  }

  return { count, warnings };
}

// ---------------------------------------------------------------------------
// Main: read engine/*.md → compile → write skill-rules.json
// ---------------------------------------------------------------------------

export { buildFromEngine };

function buildFromEngine(engineDir: string): { manifest: any; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!existsSync(engineDir)) {
    errors.push(`Engine directory not found: ${engineDir}`);
    return { manifest: null, warnings, errors };
  }

  const files = readdirSync(engineDir).filter(f => f.endsWith(".md")).sort();
  const parsedSkills: Record<string, any> = {};

  for (const file of files) {
    const content = readFileSync(join(engineDir, file), "utf-8");
    const fm = extractFrontmatter(content);
    if (!fm) {
      warnings.push(`${file}: no frontmatter found, skipping`);
      continue;
    }

    const config = parseYaml(fm.yaml);
    const slug = config.name || file.replace(/\.md$/, "");
    config._body = fm.body;
    parsedSkills[slug] = config;
  }

  // Synthesize chainTo from validate rules
  const { count: synthCount, warnings: synthWarnings } = synthesizeChainTo(parsedSkills);
  warnings.push(...synthWarnings);
  if (synthCount > 0) {
    console.error(`  ⤳ Synthesized ${synthCount} chainTo rule(s) from upgradeToSkill validate rules`);
  }

  // Compile into manifest format
  const skills: Record<string, any> = {};
  for (const [slug, config] of Object.entries(parsedSkills)) {
    const compiled = compileRegexSources(config);
    const entry: Record<string, any> = {
      priority: typeof config.priority === "number" ? config.priority : 5,
      summary: config._body || "",
      ...compiled,
    };

    // Optional fields
    if (config.docs) {
      entry.docs = Array.isArray(config.docs) ? config.docs : [config.docs];
    }
    if (config.sitemap) entry.sitemap = config.sitemap;
    if (config.registry) entry.registry = config.registry;
    if (config.registrySlug) entry.registrySlug = config.registrySlug;
    if (config.validate?.length) entry.validate = config.validate;
    if (config.chainTo?.length) entry.chainTo = config.chainTo;
    if (config.promptSignals) entry.promptSignals = config.promptSignals;
    if (config.retrieval) entry.retrieval = config.retrieval;

    skills[slug] = entry;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    version: 3,
    skills,
  };

  return { manifest, warnings, errors };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function isMain() {
  try {
    return resolve(process.argv[1] || "") === resolve(import.meta.filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const { manifest, warnings, errors } = buildFromEngine(ENGINE_DIR);

  for (const w of warnings) console.warn(`[warn] ${w}`);

  if (errors.length > 0) {
    for (const e of errors) console.error(`[error] ${e}`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + "\n");

  const count = Object.keys(manifest.skills).length;
  console.log(`✓ Wrote ${count} skills to ${OUT_FILE}`);
}
