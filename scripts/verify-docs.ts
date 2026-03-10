#!/usr/bin/env bun
/**
 * verify-docs.ts — CI gate that fails when documentation drifts from code.
 *
 * Checks:
 * 1. Skill counts across docs match skills/ directory
 * 2. Test file counts across docs match tests/*.test.ts
 * 3. Hook entries in hooks/hooks.json match CLAUDE.md hook table rows
 * 4. package.json script names appear in documented command examples
 * 5. Non-canonical skill slugs (naming drift detection)
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const errors: string[] = [];

function fail(msg: string) {
  errors.push(msg);
}

// ─── 1. Skill count ─────────────────────────────────────────────────────────

const skillsDir = join(ROOT, "skills");
const actualSkillCount = readdirSync(skillsDir, { withFileTypes: true }).filter(
  (d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md"))
).length;

const canonicalSlugs = new Set(
  readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md"))
    )
    .map((d) => d.name)
);

/** Strip fenced code blocks from content so we don't match example output */
function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, (match) =>
    // Preserve line count by replacing with same number of newlines
    "\n".repeat((match.match(/\n/g) || []).length)
  );
}

function extractSkillCounts(
  filePath: string,
  label: string
): { count: number; line: string }[] {
  const rawContent = readFileSync(filePath, "utf-8");
  const content = stripCodeBlocks(rawContent);
  const matches: { count: number; line: string }[] = [];

  // Match patterns like "46 skills", "Skills (46 skills)", "ships 46 skills"
  // but NOT budget limits like "max 5 skills", "up to 2 skills"
  const regex = /\b(\d+)\s+skills?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const count = parseInt(m[1], 10);
    // Skip small numbers that are likely budget/config limits, not total counts
    // Skill counts are 20+ in practice; budget limits are typically 2-5
    if (count < 10) continue;

    const lineNum = content.slice(0, m.index).split("\n").length;
    matches.push({ count, line: `${label}:${lineNum}` });
  }
  return matches;
}

// ─── 2. Test file count ──────────────────────────────────────────────────────

const testsDir = join(ROOT, "tests");
const actualTestCount = existsSync(testsDir)
  ? readdirSync(testsDir).filter((f) => f.endsWith(".test.ts")).length
  : 0;

function extractTestCounts(
  filePath: string,
  label: string
): { count: number; line: string }[] {
  const rawContent = readFileSync(filePath, "utf-8");
  const content = stripCodeBlocks(rawContent);
  const matches: { count: number; line: string }[] = [];

  const regex = /\b(\d+)\s+test\s+files?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const count = parseInt(m[1], 10);
    const lineNum = content.slice(0, m.index).split("\n").length;
    matches.push({ count, line: `${label}:${lineNum}` });
  }
  return matches;
}

// ─── Check files ─────────────────────────────────────────────────────────────

const docsToCheck: [string, string][] = [
  [join(ROOT, "README.md"), "README.md"],
  [join(ROOT, "docs/README.md"), "docs/README.md"],
  [join(ROOT, "CLAUDE.md"), "CLAUDE.md"],
  [join(ROOT, "docs/01-architecture-overview.md"), "docs/01-architecture-overview.md"],
  [join(ROOT, "docs/02-injection-pipeline.md"), "docs/02-injection-pipeline.md"],
  [join(ROOT, "docs/03-skill-authoring.md"), "docs/03-skill-authoring.md"],
  [join(ROOT, "docs/04-operations-debugging.md"), "docs/04-operations-debugging.md"],
  [join(ROOT, "docs/05-reference.md"), "docs/05-reference.md"],
];

for (const [filePath, label] of docsToCheck) {
  if (!existsSync(filePath)) continue;

  // Skill counts
  const skillMentions = extractSkillCounts(filePath, label);
  for (const { count, line } of skillMentions) {
    if (count !== actualSkillCount) {
      fail(
        `Skill count mismatch at ${line}: doc says ${count}, actual is ${actualSkillCount}`
      );
    }
  }

  // Test file counts
  const testMentions = extractTestCounts(filePath, label);
  for (const { count, line } of testMentions) {
    if (count !== actualTestCount) {
      fail(
        `Test file count mismatch at ${line}: doc says ${count}, actual is ${actualTestCount}`
      );
    }
  }
}

// ─── 3. Naming drift: non-canonical skill slugs ─────────────────────────────

// Known slug aliases that should have been updated to their canonical form
const driftMap: Record<string, string> = {
  "vercel-cron": "cron-jobs",
};

for (const [filePath, label] of docsToCheck) {
  if (!existsSync(filePath)) continue;
  const content = readFileSync(filePath, "utf-8");

  for (const [wrong, correct] of Object.entries(driftMap)) {
    // Match skill references: skill:vercel-cron, skills/vercel-cron, `vercel-cron`
    // but exclude retrieval.aliases examples (these legitimately use old names)
    const patterns = [
      { re: new RegExp(`skill:${wrong}\\b`, "g"), type: "skill:" },
      { re: new RegExp(`skills/${wrong}\\b`, "g"), type: "skills/" },
    ];

    for (const { re } of patterns) {
      let sm: RegExpExecArray | null;
      while ((sm = re.exec(content)) !== null) {
        // Skip if inside a retrieval aliases block
        const contextStart = Math.max(0, sm.index - 300);
        const context = content.slice(contextStart, sm.index);
        if (context.includes("aliases") || context.includes("retrieval")) {
          continue;
        }
        const lineNum = content.slice(0, sm.index).split("\n").length;
        fail(
          `${label}:${lineNum}: uses non-canonical slug "${wrong}" — should be "${correct}"`
        );
      }
    }
  }
}

// ─── 4. Hook table in CLAUDE.md matches hooks/hooks.json ────────────────────

interface HookEntryJson {
  type: string;
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntryJson[];
}

interface HooksConfig {
  hooks: Record<string, HookMatcher[]>;
}

const hooksJson: HooksConfig = JSON.parse(
  readFileSync(join(ROOT, "hooks/hooks.json"), "utf-8")
);

// Extract all unique hook .mjs filenames from hooks.json
const actualHookFiles = new Set<string>();
for (const matchers of Object.values(hooksJson.hooks)) {
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      const match = hook.command.match(/hooks\/([a-z0-9-]+\.mjs)/);
      if (match) actualHookFiles.add(match[1]);
    }
  }
}

// Extract hook filenames from CLAUDE.md hook table (lines with | ... `.mjs` ... |)
const claudeMd = readFileSync(join(ROOT, "CLAUDE.md"), "utf-8");
const claudeHookFiles = new Set<string>();
const hookTableRegex = /\|\s*\w+\s*\|\s*`([a-z0-9-]+\.mjs)`/g;
let hm: RegExpExecArray | null;
while ((hm = hookTableRegex.exec(claudeMd)) !== null) {
  claudeHookFiles.add(hm[1]);
}

// Diff: hooks in code but not in CLAUDE.md
for (const f of actualHookFiles) {
  if (!claudeHookFiles.has(f)) {
    fail(`Hook ${f} exists in hooks.json but missing from CLAUDE.md hook table`);
  }
}

// Diff: hooks in CLAUDE.md but not in code
for (const f of claudeHookFiles) {
  if (!actualHookFiles.has(f)) {
    fail(
      `Hook ${f} listed in CLAUDE.md hook table but not found in hooks.json`
    );
  }
}

// Check hook count matches
if (actualHookFiles.size !== claudeHookFiles.size) {
  fail(
    `Hook count mismatch: hooks.json has ${actualHookFiles.size} hooks, CLAUDE.md table has ${claudeHookFiles.size}`
  );
}

// ─── 5. package.json scripts appear in documented commands ──────────────────

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const scriptNames = Object.keys(pkg.scripts || {}) as string[];

// Check that docs reference actual script names (not invented ones)
// We scan docs for `bun run <name>` patterns and verify they exist
const docsForScripts: [string, string][] = [
  [join(ROOT, "README.md"), "README.md"],
  [join(ROOT, "docs/README.md"), "docs/README.md"],
  [join(ROOT, "CLAUDE.md"), "CLAUDE.md"],
];

const scriptRefRegex = /bun\s+run\s+([a-z0-9:_./\\-]+)/g;

for (const [filePath, label] of docsForScripts) {
  if (!existsSync(filePath)) continue;
  const content = readFileSync(filePath, "utf-8");
  let sm: RegExpExecArray | null;
  const checked = new Set<string>();
  while ((sm = scriptRefRegex.exec(content)) !== null) {
    const scriptName = sm[1];
    if (checked.has(scriptName)) continue;
    checked.add(scriptName);

    // Skip references to file paths (e.g., "bun run scripts/build-manifest.ts", "bun run src/cli/index.ts")
    if (scriptName.includes("/") || scriptName.includes(".")) {
      continue;
    }

    if (!scriptNames.includes(scriptName)) {
      const lineNum = content.slice(0, sm.index).split("\n").length;
      fail(
        `${label}:${lineNum} references \`bun run ${scriptName}\` but package.json has no "${scriptName}" script`
      );
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error("\n❌ Documentation drift detected:\n");
  for (const e of errors) {
    console.error(`  • ${e}`);
  }
  console.error(
    `\n${errors.length} error(s) found. Fix the docs or the code to match.\n`
  );
  process.exit(1);
} else {
  console.log("✅ Documentation is in sync with code.");
  console.log(`   Skills: ${actualSkillCount}`);
  console.log(`   Tests:  ${actualTestCount}`);
  console.log(`   Hooks:  ${actualHookFiles.size}`);
  console.log(`   Scripts: ${scriptNames.length}`);
}
