#!/usr/bin/env bun
/**
 * generate-doc-inventories.ts — Generates canonical inventories from code artifacts.
 *
 * Reads the filesystem and generated/skill-manifest.json to produce a structured
 * inventory object. Used by verify-docs.ts and can be imported by other scripts.
 *
 * Usage:
 *   bun run scripts/generate-doc-inventories.ts          # Print JSON inventory
 *   bun run scripts/generate-doc-inventories.ts --check   # Verify docs match (CI gate)
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ─── Inventory generation ────────────────────────────────────────────────────

export interface SkillEntry {
  slug: string;
  priority: number;
  description: string;
  triggerTypes: string[];
}

export interface HookEntry {
  event: string;
  file: string;
  matcher: string;
  timeout: string;
}

export interface DocInventory {
  generatedAt: string;
  counts: {
    skills: number;
    hooks: number;
    hookEvents: number;
    testFiles: number;
    templates: number;
    libraryModules: number;
    scripts: number;
    envVars: number;
  };
  skills: SkillEntry[];
  hooks: HookEntry[];
  testFiles: string[];
  templates: string[];
  libraryModules: string[];
  scripts: Record<string, string>;
  envVars: string[];
  /** Canonical skill slugs from skills/ directories */
  canonicalSlugs: string[];
}

export function generateInventory(): DocInventory {
  // ── Skills ──────────────────────────────────────────────────────────────
  const skillsDir = join(ROOT, "skills");
  const canonicalSlugs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md"))
    )
    .map((d) => d.name)
    .sort();

  // Load manifest for priority/description/trigger data
  const manifestPath = join(ROOT, "generated/skill-manifest.json");
  let manifest: Record<string, any> = {};
  if (existsSync(manifestPath)) {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest = raw.skills || {};
  }

  const skills: SkillEntry[] = canonicalSlugs.map((slug) => {
    const m = manifest[slug] || {};
    const triggers: string[] = [];
    if ((m.pathPatterns || []).length > 0) triggers.push("path");
    if ((m.bashPatterns || []).length > 0) triggers.push("bash");
    if ((m.importPatterns || []).length > 0) triggers.push("import");
    if (m.promptSignals?.phrases?.length || m.promptSignals?.allOf?.length)
      triggers.push("prompt");

    // Read description from SKILL.md frontmatter if manifest doesn't have it
    let description = m.description || "";
    if (!description) {
      try {
        const skillMd = readFileSync(
          join(skillsDir, slug, "SKILL.md"),
          "utf-8"
        );
        const descMatch = skillMd.match(/^description:\s*["']?(.+?)["']?\s*$/m);
        if (descMatch) description = descMatch[1];
      } catch {
        /* ignore */
      }
    }

    return {
      slug,
      priority: m.priority ?? 5,
      description,
      triggerTypes: triggers,
    };
  });

  // ── Hooks ───────────────────────────────────────────────────────────────
  const hooksJsonPath = join(ROOT, "hooks/hooks.json");
  const hooksConfig = JSON.parse(readFileSync(hooksJsonPath, "utf-8"));
  const hooks: HookEntry[] = [];
  const hookEvents = new Set<string>();

  for (const [event, matchers] of Object.entries<any[]>(hooksConfig.hooks)) {
    hookEvents.add(event);
    for (const matcherGroup of matchers) {
      for (const hook of matcherGroup.hooks) {
        const fileMatch = hook.command.match(/hooks\/([a-z0-9-]+\.mjs)/);
        if (fileMatch) {
          hooks.push({
            event,
            file: fileMatch[1],
            matcher: matcherGroup.matcher || "(all)",
            timeout: hook.timeout ? `${hook.timeout}s` : "—",
          });
        }
      }
    }
  }

  // ── Test files ──────────────────────────────────────────────────────────
  const testsDir = join(ROOT, "tests");
  const testFiles = existsSync(testsDir)
    ? readdirSync(testsDir)
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => f.replace(/\.test\.ts$/, ""))
        .sort()
    : [];

  // ── Templates ───────────────────────────────────────────────────────────
  const templates: string[] = [];
  for (const dir of ["agents", "commands"]) {
    const dirPath = join(ROOT, dir);
    if (existsSync(dirPath)) {
      const tmpls = readdirSync(dirPath).filter((f) => f.endsWith(".md.tmpl"));
      templates.push(...tmpls.map((f) => `${dir}/${f}`));
    }
  }
  templates.sort();

  // ── Library modules (non-hook .mts files in hooks/src/) ─────────────────
  const hookSrcDir = join(ROOT, "hooks/src");
  const allMtsFiles = existsSync(hookSrcDir)
    ? readdirSync(hookSrcDir).filter((f) => f.endsWith(".mts"))
    : [];

  // Entry-point hooks are registered in hooks.json; library modules are the rest
  const entryPointFiles = new Set(
    hooks.map((h) => h.file.replace(/\.mjs$/, ".mts"))
  );
  // Also include standalone hooks without .mts source
  const libraryModules = allMtsFiles
    .filter((f) => !entryPointFiles.has(f))
    .map((f) => f.replace(/\.mts$/, ""))
    .sort();

  // ── Scripts ─────────────────────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const scripts: Record<string, string> = pkg.scripts || {};

  // ── Environment variables ───────────────────────────────────────────────
  // Scan hook source files for VERCEL_PLUGIN_* env var references
  const envVarSet = new Set<string>();
  const envVarRegex = /VERCEL_PLUGIN_[A-Z_]+/g;
  for (const f of allMtsFiles) {
    try {
      const content = readFileSync(join(hookSrcDir, f), "utf-8");
      let ev: RegExpExecArray | null;
      while ((ev = envVarRegex.exec(content)) !== null) {
        envVarSet.add(ev[0]);
      }
    } catch {
      /* ignore */
    }
  }
  const envVars = [...envVarSet].sort();

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      skills: canonicalSlugs.length,
      hooks: hooks.length,
      hookEvents: hookEvents.size,
      testFiles: testFiles.length,
      templates: templates.length,
      libraryModules: libraryModules.length,
      scripts: Object.keys(scripts).length,
      envVars: envVars.length,
    },
    skills,
    hooks,
    testFiles,
    templates,
    libraryModules,
    scripts,
    envVars,
    canonicalSlugs,
  };
}

// ─── Check mode: verify docs match inventories ──────────────────────────────

function checkDocs(inventory: DocInventory): string[] {
  const errors: string[] = [];
  const { counts, canonicalSlugs } = inventory;

  // Helper: find all skill count mentions in a file
  function checkSkillCounts(filePath: string, label: string) {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, "utf-8");
    const regex = /\b(\d+)\s+skills?\b/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      const count = parseInt(m[1], 10);
      if (count < 10) continue; // skip budget limits like "max 5 skills"
      if (count !== counts.skills) {
        const lineNum = content.slice(0, m.index).split("\n").length;
        errors.push(
          `${label}:${lineNum}: skill count says ${count}, actual is ${counts.skills}`
        );
      }
    }
  }

  // Helper: find all test file count mentions in a file
  function checkTestCounts(filePath: string, label: string) {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, "utf-8");
    const regex = /\b(\d+)\s+test\s+files?\b/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      const count = parseInt(m[1], 10);
      if (count !== counts.testFiles) {
        const lineNum = content.slice(0, m.index).split("\n").length;
        errors.push(
          `${label}:${lineNum}: test file count says ${count}, actual is ${counts.testFiles}`
        );
      }
    }
  }

  // Helper: check for non-canonical skill slugs
  function checkSlugDrift(filePath: string, label: string) {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, "utf-8");
    // Known false-positive aliases (used in retrieval metadata examples, not as canonical names)
    const allowList = new Set([
      "vercel-cron", // appears only in retrieval.aliases examples in 05-reference.md
    ]);
    // Check for known drift: vercel-cron should be cron-jobs
    const driftMap: Record<string, string> = {
      "vercel-cron": "cron-jobs",
    };
    for (const [wrong, correct] of Object.entries(driftMap)) {
      // Match skill references: skill:vercel-cron, `vercel-cron`, skills/vercel-cron
      const patterns = [
        new RegExp(`skill:${wrong}\\b`, "g"),
        new RegExp(`skills/${wrong}\\b`, "g"),
        // Match inline code refs like `vercel-cron` but not inside retrieval aliases
        new RegExp(`\`${wrong}\``, "g"),
      ];
      for (const re of patterns) {
        let sm: RegExpExecArray | null;
        while ((sm = re.exec(content)) !== null) {
          const lineNum = content.slice(0, sm.index).split("\n").length;
          // Skip if this line is inside a retrieval.aliases block
          const line = content.split("\n")[lineNum - 1];
          if (
            line.includes("aliases") ||
            line.includes("retrieval") ||
            line.trim().startsWith("- ")
          ) {
            // Check if the surrounding context suggests this is a retrieval alias example
            const contextStart = Math.max(0, sm.index - 200);
            const context = content.slice(contextStart, sm.index);
            if (context.includes("aliases") || context.includes("retrieval")) {
              continue;
            }
          }
          errors.push(
            `${label}:${lineNum}: uses non-canonical slug "${wrong}" — should be "${correct}"`
          );
        }
      }
    }
  }

  const docsToCheck = [
    [join(ROOT, "docs/README.md"), "docs/README.md"],
    [join(ROOT, "docs/01-architecture-overview.md"), "docs/01-architecture-overview.md"],
    [join(ROOT, "docs/02-injection-pipeline.md"), "docs/02-injection-pipeline.md"],
    [join(ROOT, "docs/03-skill-authoring.md"), "docs/03-skill-authoring.md"],
    [join(ROOT, "docs/04-operations-debugging.md"), "docs/04-operations-debugging.md"],
    [join(ROOT, "docs/05-reference.md"), "docs/05-reference.md"],
  ] as const;

  for (const [filePath, label] of docsToCheck) {
    checkSkillCounts(filePath, label);
    checkTestCounts(filePath, label);
    checkSlugDrift(filePath, label);
  }

  // Also check CLAUDE.md and README.md
  checkSkillCounts(join(ROOT, "CLAUDE.md"), "CLAUDE.md");
  checkTestCounts(join(ROOT, "CLAUDE.md"), "CLAUDE.md");
  checkSkillCounts(join(ROOT, "README.md"), "README.md");
  checkTestCounts(join(ROOT, "README.md"), "README.md");

  // Check hook count in CLAUDE.md
  const claudeMd = existsSync(join(ROOT, "CLAUDE.md"))
    ? readFileSync(join(ROOT, "CLAUDE.md"), "utf-8")
    : "";
  const claudeHookFiles = new Set<string>();
  const hookTableRegex = /\|\s*\w+\s*\|\s*`([a-z0-9-]+\.mjs)`/g;
  let hm: RegExpExecArray | null;
  while ((hm = hookTableRegex.exec(claudeMd)) !== null) {
    claudeHookFiles.add(hm[1]);
  }
  const actualHookFiles = new Set(inventory.hooks.map((h) => h.file));
  for (const f of actualHookFiles) {
    if (!claudeHookFiles.has(f)) {
      errors.push(
        `CLAUDE.md: hook ${f} exists in hooks.json but missing from hook table`
      );
    }
  }

  return errors;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const inventory = generateInventory();

  if (args.includes("--check")) {
    const errors = checkDocs(inventory);
    if (errors.length > 0) {
      console.error("\n❌ Documentation drift detected:\n");
      for (const e of errors) {
        console.error(`  • ${e}`);
      }
      console.error(
        `\n${errors.length} error(s) found. Run 'bun run scripts/generate-doc-inventories.ts' to see current values.\n`
      );
      process.exit(1);
    } else {
      console.log("✅ Documentation inventories match code.");
      console.log(`   Skills: ${inventory.counts.skills}`);
      console.log(`   Hooks:  ${inventory.counts.hooks}`);
      console.log(`   Tests:  ${inventory.counts.testFiles}`);
      console.log(`   Templates: ${inventory.counts.templates}`);
    }
  } else {
    // Print full inventory as JSON
    console.log(JSON.stringify(inventory, null, 2));
  }
}
