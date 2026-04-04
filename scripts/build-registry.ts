#!/usr/bin/env bun
/**
 * Queries the skills.sh API and updates registry/registrySlug fields
 * in engine/*.md frontmatter files.
 *
 * Usage:  bun run scripts/build-registry.ts
 */

import { resolve, join } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const ENGINE_DIR = join(ROOT, "engine");

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface SkillResult {
  id: string;       // "owner/repo/slug"
  source: string;   // "owner/repo"
  name: string;
  installs: number;
}

interface SearchResponse {
  skills: SkillResult[];
}

// ---------------------------------------------------------------------------
// Fetch skills from registry API
// ---------------------------------------------------------------------------

async function fetchSkills(query: string): Promise<SkillResult[]> {
  const url = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status} for query "${query}": ${res.statusText}`);
  const data: SearchResponse = await res.json();
  return data.skills;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (mirrors build-manifest.ts extractFrontmatter)
// ---------------------------------------------------------------------------

function extractFrontmatter(content: string): { yaml: string; body: string } | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  return {
    yaml: content.slice(4, end),
    body: content.slice(end + 4),
  };
}

function getField(yaml: string, field: string): string | undefined {
  const re = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const m = yaml.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

// ---------------------------------------------------------------------------
// Frontmatter updater — surgically updates registry/registrySlug fields
// ---------------------------------------------------------------------------

function updateFrontmatter(
  yaml: string,
  registry: string | null,
  registrySlug: string | null,
): string {
  const lines = yaml.split("\n");
  const result: string[] = [];
  let insertedRegistry = false;

  // Track where name and description are, so we can insert after them
  let lastAnchorIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip existing registry/registrySlug lines — we'll re-add them
    if (trimmed.startsWith("registry:") && !trimmed.startsWith("registrySlug:")) continue;
    if (trimmed.startsWith("registrySlug:")) continue;

    result.push(line);

    // Track last anchor field (name or description)
    if (trimmed.startsWith("name:") || trimmed.startsWith("description:")) {
      lastAnchorIdx = result.length - 1;
    }
  }

  // Insert registry fields after the last anchor (name/description)
  if (registry) {
    const insertIdx = lastAnchorIdx >= 0 ? lastAnchorIdx + 1 : 1;
    const newLines: string[] = [`registry: ${registry}`];
    if (registrySlug) {
      newLines.push(`registrySlug: ${registrySlug}`);
    }
    result.splice(insertIdx, 0, ...newLines);
    insertedRegistry = true;
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Fetching skills from skills.sh API...");

  // 1. Fetch both queries and merge
  const [vercelSkills, labsSkills] = await Promise.all([
    fetchSkills("vercel/"),
    fetchSkills("vercel-labs/"),
  ]);

  const allSkills = [...vercelSkills, ...labsSkills];
  console.log(`  Fetched ${vercelSkills.length} vercel/ + ${labsSkills.length} vercel-labs/ = ${allSkills.length} total`);

  // 2. Filter out our own repo
  const filtered = allSkills.filter(s => s.source !== "vercel-labs/vercel-plugin");

  // 3. Build slug → { source, installs } map (highest installs wins)
  const slugMap = new Map<string, { source: string; installs: number }>();
  for (const skill of filtered) {
    // Extract slug from id: "owner/repo/slug" → "slug"
    const parts = skill.id.split("/");
    const slug = parts[parts.length - 1];
    const existing = slugMap.get(slug);
    if (!existing || skill.installs > existing.installs) {
      slugMap.set(slug, { source: skill.source, installs: skill.installs });
    }
  }
  console.log(`  ${slugMap.size} unique slugs after dedup\n`);

  // 4. Process each engine file
  const files = readdirSync(ENGINE_DIR).filter(f => f.endsWith(".md")).sort();
  let updated = 0;
  let removed = 0;
  let unchanged = 0;

  for (const file of files) {
    const filePath = join(ENGINE_DIR, file);
    const content = readFileSync(filePath, "utf-8");
    const fm = extractFrontmatter(content);
    if (!fm) {
      console.log(`  SKIP  ${file} (no frontmatter)`);
      continue;
    }

    const engineName = getField(fm.yaml, "name") || file.replace(/\.md$/, "");
    const existingRegistry = getField(fm.yaml, "registry");
    const existingRegistrySlug = getField(fm.yaml, "registrySlug");

    // Try matching: engine name first, then existing registrySlug
    let match = slugMap.get(engineName);
    let matchedSlug = engineName;
    if (!match && existingRegistrySlug) {
      match = slugMap.get(existingRegistrySlug);
      matchedSlug = existingRegistrySlug;
    }

    if (match) {
      const needsRegistrySlug = matchedSlug !== engineName ? matchedSlug : null;
      const newYaml = updateFrontmatter(fm.yaml, match.source, needsRegistrySlug);

      // Check if anything actually changed
      if (newYaml === fm.yaml) {
        unchanged++;
        continue;
      }

      const newContent = `---\n${newYaml}\n---${fm.body}`;
      writeFileSync(filePath, newContent);
      const slugInfo = needsRegistrySlug ? ` (slug: ${needsRegistrySlug})` : "";
      console.log(`  SET   ${file}: registry=${match.source}${slugInfo}`);
      updated++;
    } else if (existingRegistry || existingRegistrySlug) {
      // No match — remove stale fields
      const newYaml = updateFrontmatter(fm.yaml, null, null);
      if (newYaml !== fm.yaml) {
        const newContent = `---\n${newYaml}\n---${fm.body}`;
        writeFileSync(filePath, newContent);
        console.log(`  DEL   ${file}: removed stale registry=${existingRegistry}`);
        removed++;
      } else {
        unchanged++;
      }
    } else {
      unchanged++;
    }
  }

  console.log(`\n✓ Done: ${updated} updated, ${removed} removed, ${unchanged} unchanged`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
