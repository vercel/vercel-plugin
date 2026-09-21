#!/usr/bin/env bun
/**
 * Audit retrieval metadata coverage across all skills.
 *
 * Reports which skills are missing retrieval.aliases, intents, examples, or entities
 * and highlights gaps in the top-priority skills.
 *
 * Usage:
 *   bun scripts/audit-retrieval-metadata.ts [--json] [--top N]
 */

import { join, resolve } from "node:path";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");

interface SkillAudit {
  name: string;
  priority: number;
  hasRetrieval: boolean;
  aliases: number;
  intents: number;
  entities: number;
  examples: number;
  gaps: string[];
}

const MIN_ALIASES = 3;
const MIN_INTENTS = 2;
const MIN_ENTITIES = 2;
const MIN_EXAMPLES = 2;

function audit(): SkillAudit[] {
  const { validation, skills, buildDiagnostics } = loadValidatedSkillMap(SKILLS_DIR);
  if (!validation.ok || buildDiagnostics.length > 0) {
    const errors = validation.ok ? buildDiagnostics : [...buildDiagnostics, ...validation.errors];
    console.error(`Cannot audit skill metadata:\n${errors.join("\n")}`);
    process.exit(1);
  }
  const results: SkillAudit[] = [];

  for (const [name, skill] of Object.entries(skills)) {
    const r = skill.retrieval;
    const gaps: string[] = [];

    const aliases = r?.aliases?.length ?? 0;
    const intents = r?.intents?.length ?? 0;
    const entities = r?.entities?.length ?? 0;
    const examples = r?.examples?.length ?? 0;

    if (!r) gaps.push("missing retrieval section entirely");
    if (aliases < MIN_ALIASES)
      gaps.push(`aliases: ${aliases}/${MIN_ALIASES}`);
    if (intents < MIN_INTENTS)
      gaps.push(`intents: ${intents}/${MIN_INTENTS}`);
    if (entities < MIN_ENTITIES)
      gaps.push(`entities: ${entities}/${MIN_ENTITIES}`);
    if (examples < MIN_EXAMPLES)
      gaps.push(`examples: ${examples}/${MIN_EXAMPLES}`);

    results.push({
      name,
      priority: skill.priority,
      hasRetrieval: Boolean(r),
      aliases,
      intents,
      entities,
      examples,
      gaps,
    });
  }

  return results.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

// --- CLI ---
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const topIdx = args.indexOf("--top");
const topN = topIdx >= 0 ? parseInt(args[topIdx + 1], 10) : 15;

const results = audit();
const topSkills = results.slice(0, topN);
const withGaps = results.filter((s) => s.gaps.length > 0);
const topWithGaps = topSkills.filter((s) => s.gaps.length > 0);

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        totalSkills: results.length,
        topN,
        skillsWithGaps: withGaps.length,
        topSkillsWithGaps: topWithGaps.length,
        topSkills: topSkills.map((s) => ({
          name: s.name,
          priority: s.priority,
          aliases: s.aliases,
          intents: s.intents,
          entities: s.entities,
          examples: s.examples,
          gaps: s.gaps,
        })),
        allGaps: withGaps.map((s) => ({
          name: s.name,
          priority: s.priority,
          gaps: s.gaps,
        })),
      },
      null,
      2
    )
  );
} else {
  console.log(`\n=== Retrieval Metadata Audit ===`);
  console.log(`Total skills: ${results.length}`);
  console.log(`Skills with gaps: ${withGaps.length}/${results.length}`);
  console.log(
    `Top ${topN} skills with gaps: ${topWithGaps.length}/${topSkills.length}`
  );
  console.log(
    `\nMinimums: aliases>=${MIN_ALIASES}, intents>=${MIN_INTENTS}, entities>=${MIN_ENTITIES}, examples>=${MIN_EXAMPLES}`
  );

  console.log(`\n--- Top ${topN} Skills ---`);
  for (const s of topSkills) {
    const status = s.gaps.length === 0 ? "✓" : "✗";
    console.log(
      `  ${status} ${s.name} (p${s.priority}) — aliases:${s.aliases} intents:${s.intents} entities:${s.entities} examples:${s.examples}`
    );
    if (s.gaps.length > 0) {
      for (const g of s.gaps) console.log(`      ↳ ${g}`);
    }
  }

  if (withGaps.length > topWithGaps.length) {
    console.log(`\n--- Other Skills with Gaps ---`);
    for (const s of withGaps) {
      if (topSkills.includes(s)) continue;
      console.log(
        `  ✗ ${s.name} (p${s.priority}) — ${s.gaps.join(", ")}`
      );
    }
  }

  console.log();
}
