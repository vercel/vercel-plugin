/**
 * `vercel-plugin explain` — show which skills match a given file or command,
 * with priority scores, match reasons, byte budget simulation, and collision detection.
 *
 * Mirrors the runtime selection pipeline in hooks/pretooluse-skill-inject.mjs:
 *   path/bash/import matching → vercel.json routing → profiler boost → rank → budget+cap
 *
 * Usage:
 *   vercel-plugin explain <file-or-command> [--json] [--project <path>] [--likely-skills s1,s2]
 *   vercel-plugin explain middleware.ts
 *   vercel-plugin explain "vercel deploy --prod"
 *   vercel-plugin explain vercel.json --json
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  compileSkillPatterns,
  matchPathWithReason,
  matchBashWithReason,
  matchImportWithReason,
  rankEntries,
} from "../../hooks/patterns.mjs";
import { loadValidatedSkillMap } from "../shared/skill-map-loader.ts";
import { filterExcludedSkillMap } from "../shared/skill-exclusion-policy.ts";
import {
  resolveVercelJsonSkills,
  isVercelJsonPath,
  VERCEL_JSON_SKILLS,
} from "../../hooks/vercel-config.mjs";
import {
  applyPolicyBoosts,
  type RoutingPolicyFile,
} from "../../hooks/src/routing-policy.mts";
import {
  loadProjectRoutingPolicy,
} from "../../hooks/src/routing-policy-ledger.mts";

const MAX_SKILLS = 3;
const DEFAULT_INJECTION_BUDGET_BYTES = 12_000;

export interface ExplainMatch {
  skill: string;
  priority: number;
  effectivePriority: number;
  matchedPattern: string;
  matchType: "file:full" | "file:basename" | "file:suffix" | "file:import" | "bash:full";
  injected: boolean;
  capped: boolean;
  /** How the skill would be injected: full body, summary-only, or not at all */
  injectionMode: "full" | "summary" | "droppedByCap" | "droppedByBudget";
  /** Byte size of the SKILL.md body (null if file not found) */
  bodyBytes: number | null;
  /** Human-readable explanation of why the skill was dropped or how it was injected */
  capReason: string;
  /** Policy boost applied (0 when no policy data or below threshold) */
  policyBoost?: number;
  /** Human-readable policy stats when policy data is present */
  policyReason?: string | null;
}

export interface ExplainCollision {
  skills: string[];
  reason: string;
}

export interface ExplainResult {
  target: string;
  targetType: "file" | "bash";
  toolName?: string;
  matches: ExplainMatch[];
  collisions: ExplainCollision[];
  injectedCount: number;
  cappedCount: number;
  droppedByBudgetCount: number;
  summaryOnlyCount: number;
  skillCount: number;
  budgetBytes: number;
  usedBytes: number;
  /** Warnings from SKILL.md parsing (malformed frontmatter, missing fields, etc.) */
  buildWarnings: string[];
}

export interface ExplainOptions {
  /** Comma-delimited likely skills from session profiler (simulates +5 boost) */
  likelySkills?: string;
  /** Override injection budget in bytes */
  budgetBytes?: number;
  /** File content for import matching (reads from disk if target exists and not provided) */
  fileContent?: string;
  /** Explicit tool name (Read, Edit, Write, Bash) — overrides auto-detection */
  toolName?: string;
  /** Pre-loaded routing policy (loads from project tmpdir if not provided) */
  policyFile?: RoutingPolicyFile;
}

// ---------------------------------------------------------------------------
// Detect whether target looks like a bash command vs a file path
// ---------------------------------------------------------------------------

function detectTargetType(target: string, toolName?: string): "file" | "bash" {
  // Explicit tool name takes precedence
  if (toolName === "Bash") return "bash";
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write") return "file";
  // If it contains spaces and starts with a known CLI tool, treat as bash
  if (/\s/.test(target) && /^(vercel|npm|npx|bun|pnpm|yarn|node|git)\b/.test(target)) {
    return "bash";
  }
  // If it looks like a flag-bearing command
  if (/\s--?\w/.test(target)) return "bash";
  // Default: file path
  return "file";
}

// ---------------------------------------------------------------------------
// Core explain logic
// ---------------------------------------------------------------------------

export function explain(target: string, projectRoot: string, options?: ExplainOptions): ExplainResult {
  const skillsDir = join(projectRoot, "skills");
  const manifestPath = join(projectRoot, "generated", "skill-manifest.json");
  const opts = options || {};
  const budget = opts.budgetBytes ?? DEFAULT_INJECTION_BUDGET_BYTES;

  // Parse likely skills for profiler boost simulation
  const likelySkills = new Set<string>();
  if (opts.likelySkills) {
    for (const s of opts.likelySkills.split(",")) {
      const trimmed = s.trim();
      if (trimmed) likelySkills.add(trimmed);
    }
  }

  // Load skill map (prefer manifest, fall back to live scan)
  let skillMap: Record<string, {
    priority: number;
    pathPatterns: string[];
    bashPatterns: string[];
    importPatterns?: string[];
    summary?: string;
    bodyPath?: string;
  }>;

  let buildWarnings: string[] = [];

  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    skillMap = manifest.skills;
  } else {
    const { validation, skills, buildDiagnostics } = loadValidatedSkillMap(skillsDir);
    if (!validation.ok) {
      throw new Error(`Skill map validation failed: ${validation.errors.join(", ")}`);
    }
    buildWarnings = buildDiagnostics;
    // Apply the same exclusion policy as the manifest build so excluded
    // test-only skills never surface as live runtime candidates.
    const { included } = filterExcludedSkillMap(skills);
    skillMap = included;
  }

  const targetType = detectTargetType(target, opts.toolName);

  // Compile patterns using the shared engine
  const compiled = compileSkillPatterns(skillMap);

  // Resolve file content for import matching
  let fileContent = opts.fileContent || "";
  if (targetType === "file" && !fileContent) {
    const resolvedPath = target.startsWith("/") ? target : join(projectRoot, target);
    try {
      if (existsSync(resolvedPath) && statSync(resolvedPath).isFile()) {
        fileContent = readFileSync(resolvedPath, "utf-8");
      }
    } catch {
      // Ignore — import matching just won't fire
    }
  }

  // Match
  const matchedEntries: Array<{
    skill: string;
    priority: number;
    effectivePriority: number;
    pattern: string;
    matchType: string;
  }> = [];

  for (const entry of compiled) {
    let reason: { pattern: string; matchType: string } | null = null;

    if (targetType === "file") {
      reason = matchPathWithReason(target, entry.compiledPaths);

      // Fall back to import matching when path matching doesn't hit
      if (!reason && fileContent && entry.compiledImports && entry.compiledImports.length > 0) {
        reason = matchImportWithReason(fileContent, entry.compiledImports);
      }
    } else {
      reason = matchBashWithReason(target, entry.compiledBash);
    }

    if (reason) {
      matchedEntries.push({
        skill: entry.skill,
        priority: entry.priority,
        effectivePriority: entry.priority,
        pattern: reason.pattern,
        matchType: reason.matchType,
      });
    }
  }

  // vercel.json key-aware routing adjustments
  if (targetType === "file" && isVercelJsonPath(target)) {
    const resolvedPath = target.startsWith("/") ? target : join(projectRoot, target);
    const resolved = existsSync(resolvedPath) ? resolveVercelJsonSkills(resolvedPath) : null;

    if (resolved && resolved.relevantSkills.size > 0) {
      for (const entry of matchedEntries) {
        if (!VERCEL_JSON_SKILLS.has(entry.skill)) continue;
        if (resolved.relevantSkills.has(entry.skill)) {
          entry.effectivePriority = entry.priority + 10;
        } else {
          entry.effectivePriority = entry.priority - 10;
        }
      }
    }
  }

  // Profiler boost: likely skills get +5 effective priority (matches runtime)
  if (likelySkills.size > 0) {
    for (const entry of matchedEntries) {
      if (likelySkills.has(entry.skill)) {
        entry.effectivePriority += 5;
      }
    }
  }

  // Policy boost: apply verified routing policy boosts
  const policy = opts.policyFile ?? loadProjectRoutingPolicy(projectRoot);
  const toolForPolicy = opts.toolName ?? (targetType === "bash" ? "Bash" : "Read");
  const policyScenario = {
    hook: "PreToolUse" as const,
    storyKind: null as string | null,
    targetBoundary: null as null,
    toolName: toolForPolicy as "Read" | "Edit" | "Write" | "Bash",
  };
  const boostedEntries = applyPolicyBoosts(matchedEntries, policy, policyScenario);

  // Write back boosted effective priorities and track policy data
  const policyData = new Map<string, { boost: number; reason: string | null }>();
  for (const b of boostedEntries) {
    if (b.policyBoost !== 0 || b.policyReason) {
      policyData.set(b.skill, { boost: b.policyBoost, reason: b.policyReason });
    }
    // Update matched entry with policy-adjusted effective priority
    const orig = matchedEntries.find((e) => e.skill === b.skill);
    if (orig) orig.effectivePriority = b.effectivePriority;
  }

  // Sort by effectivePriority DESC, then skill name ASC
  const rankedEntries = rankEntries(matchedEntries);

  // Simulate byte budget + cap selection (mirrors injectSkills in pretooluse-skill-inject.mjs)
  const injectionPlan = simulateInjection(rankedEntries, skillMap, projectRoot, budget);

  // Build result with injection/cap/budget tracking
  const matches: ExplainMatch[] = rankedEntries.map((entry, idx) => {
    const plan = injectionPlan.get(entry.skill)!;
    const pd = policyData.get(entry.skill);
    const match: ExplainMatch = {
      skill: entry.skill,
      priority: entry.priority,
      effectivePriority: entry.effectivePriority,
      matchedPattern: entry.pattern,
      matchType: (targetType === "file" ? `file:${entry.matchType}` : `bash:${entry.matchType}`) as ExplainMatch["matchType"],
      injected: plan.mode === "full" || plan.mode === "summary",
      capped: plan.mode === "droppedByCap" || plan.mode === "droppedByBudget",
      injectionMode: plan.mode,
      bodyBytes: plan.bodyBytes,
      capReason: plan.capReason,
    };
    if (pd) {
      match.policyBoost = pd.boost;
      match.policyReason = pd.reason;
    }
    return match;
  });

  // Detect collisions: skills at same priority competing for injection slots
  const collisions: ExplainCollision[] = [];
  const byPriority = new Map<number, string[]>();
  for (const m of rankedEntries) {
    const p = m.effectivePriority;
    if (!byPriority.has(p)) byPriority.set(p, []);
    byPriority.get(p)!.push(m.skill);
  }
  for (const [priority, skills] of byPriority) {
    if (skills.length > 1) {
      collisions.push({
        skills,
        reason: `${skills.length} skills share effective priority ${priority}; tie-broken alphabetically`,
      });
    }
  }

  return {
    target,
    targetType,
    ...(opts.toolName ? { toolName: opts.toolName } : {}),
    matches,
    collisions,
    injectedCount: matches.filter((m) => m.injected).length,
    cappedCount: matches.filter((m) => m.capped).length,
    droppedByBudgetCount: matches.filter((m) => m.injectionMode === "droppedByBudget").length,
    summaryOnlyCount: matches.filter((m) => m.injectionMode === "summary").length,
    skillCount: Object.keys(skillMap).length,
    budgetBytes: budget,
    usedBytes: injectionPlan.usedBytes,
    buildWarnings,
  };
}

// ---------------------------------------------------------------------------
// Byte budget + cap simulation (mirrors injectSkills from pretooluse-skill-inject.mjs)
// ---------------------------------------------------------------------------

interface InjectionPlan {
  mode: "full" | "summary" | "droppedByCap" | "droppedByBudget";
  bodyBytes: number | null;
  capReason: string;
}

function explainSkillInvocationMessage(skill: string): string {
  return `You must run the Skill(${skill}) tool.`;
}

function simulateInjection(
  rankedEntries: Array<{ skill: string }>,
  skillMap: Record<string, { summary?: string; bodyPath?: string }>,
  projectRoot: string,
  budgetBytes: number,
): Map<string, InjectionPlan> & { usedBytes: number } {
  const result = new Map<string, InjectionPlan>() as Map<string, InjectionPlan> & { usedBytes: number };
  let loadedCount = 0;
  let usedBytes = 0;

  for (const entry of rankedEntries) {
    const skill = entry.skill;
    const skillPath = join(projectRoot, "skills", skill, "SKILL.md");

    // Read the on-disk body for informational reporting, but budget the same
    // invocation string the runtime injector emits.
    let bodyBytes: number | null = null;
    let wrappedBytes = 0;
    try {
      const content = readFileSync(skillPath, "utf-8");
      bodyBytes = Buffer.byteLength(content, "utf-8");
      wrappedBytes = Buffer.byteLength(explainSkillInvocationMessage(skill), "utf-8");
    } catch {
      // SKILL.md not found — would be skipped at runtime too
      result.set(skill, { mode: "droppedByCap", bodyBytes: null, capReason: "SKILL.md not found" });
      continue;
    }

    // Hard ceiling check (same as runtime)
    if (loadedCount >= MAX_SKILLS) {
      result.set(skill, { mode: "droppedByCap", bodyBytes, capReason: `exceeded MAX_SKILLS=${MAX_SKILLS} hard cap (${loadedCount} already injected)` });
      continue;
    }

    // Budget check: always allow the first skill full body, then enforce budget
    if (loadedCount > 0 && usedBytes + wrappedBytes > budgetBytes) {
      // Try summary fallback
      const summary = skillMap[skill]?.summary;
      if (summary) {
        const summaryBytes = Buffer.byteLength(explainSkillInvocationMessage(skill), "utf-8");
        if (usedBytes + summaryBytes <= budgetBytes) {
          result.set(skill, { mode: "summary", bodyBytes, capReason: `full body (${wrappedBytes}B) exceeds budget (${usedBytes}+${wrappedBytes} > ${budgetBytes}B); using summary (${summaryBytes}B)` });
          loadedCount++;
          usedBytes += summaryBytes;
          continue;
        }
      }
      result.set(skill, { mode: "droppedByBudget", bodyBytes, capReason: `would exceed byte budget (${usedBytes}+${wrappedBytes} = ${usedBytes + wrappedBytes}B > ${budgetBytes}B)` });
      continue;
    }

    const position = loadedCount + 1;
    result.set(skill, { mode: "full", bodyBytes, capReason: `injected #${position} (${wrappedBytes}B, total ${usedBytes + wrappedBytes}B / ${budgetBytes}B)` });
    loadedCount++;
    usedBytes += wrappedBytes;
  }

  result.usedBytes = usedBytes;
  return result;
}

// ---------------------------------------------------------------------------
// Pretty-print for human-readable output
// ---------------------------------------------------------------------------

export function formatExplainResult(result: ExplainResult): string {
  const lines: string[] = [];

  const targetLabel = result.toolName
    ? `Target: ${result.toolName} ${result.target} (${result.targetType})`
    : `Target: ${result.target} (${result.targetType})`;
  lines.push(targetLabel);
  lines.push(`Skills in manifest: ${result.skillCount}`);
  lines.push(`Budget: ${result.usedBytes} / ${result.budgetBytes} bytes`);
  lines.push("");

  if (result.matches.length === 0) {
    lines.push("No skills matched.");
    return lines.join("\n");
  }

  lines.push(`Matched: ${result.matches.length} skill(s)`);
  const parts = [`Injected: ${result.injectedCount}`];
  if (result.summaryOnlyCount > 0) parts.push(`Summary-only: ${result.summaryOnlyCount}`);
  if (result.cappedCount > 0) parts.push(`Capped: ${result.cappedCount - result.droppedByBudgetCount}`);
  if (result.droppedByBudgetCount > 0) parts.push(`Budget-dropped: ${result.droppedByBudgetCount}`);
  lines.push(parts.join(" | "));
  lines.push("");

  for (const m of result.matches) {
    let status: string;
    if (m.injectionMode === "full") status = "INJECT";
    else if (m.injectionMode === "summary") status = "SUMMARY";
    else if (m.injectionMode === "droppedByBudget") status = "BUDGET";
    else status = "CAPPED";

    const policyDelta = m.policyBoost ?? 0;
    const nonPolicyBase = m.effectivePriority - policyDelta;
    let priStr: string;
    if (policyDelta !== 0 && nonPolicyBase !== m.priority) {
      // Both profiler/vercel.json and policy boosts active
      priStr = `${m.effectivePriority} (base ${m.priority}, policy ${policyDelta > 0 ? "+" : ""}${policyDelta})`;
    } else if (policyDelta !== 0) {
      priStr = `${m.effectivePriority} (base ${m.priority}, policy ${policyDelta > 0 ? "+" : ""}${policyDelta})`;
    } else if (m.effectivePriority !== m.priority) {
      priStr = `${m.effectivePriority} (base ${m.priority})`;
    } else {
      priStr = `${m.priority}`;
    }
    const bytesStr = m.bodyBytes != null ? ` (${m.bodyBytes} bytes)` : "";
    lines.push(`  [${status}] ${m.skill}${bytesStr}`);
    lines.push(`          priority: ${priStr}`);
    lines.push(`          pattern:  ${m.matchedPattern} (${m.matchType})`);
    lines.push(`          reason:   ${m.capReason}`);
    if (m.policyReason) {
      lines.push(`          policy:   ${m.policyReason}`);
    }
  }

  if (result.collisions.length > 0) {
    lines.push("");
    lines.push("Collisions:");
    for (const c of result.collisions) {
      lines.push(`  - ${c.skills.join(", ")}: ${c.reason}`);
    }
  }

  if (result.buildWarnings.length > 0) {
    lines.push("");
    lines.push("Build warnings:");
    for (const w of result.buildWarnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join("\n");
}
