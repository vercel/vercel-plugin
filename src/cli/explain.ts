/**
 * `vercel-plugin explain` — show which skills match a given file or command,
 * with priority scores, match reasons, byte budget simulation, and collision detection.
 *
 * Mirrors the runtime selection pipeline in hooks/src/pretooluse-skill-inject.mts:
 *   path/bash/import matching → vercel.json routing → profiler boost → rank → budget+cap
 *
 * Skill metadata is resolved through the same skill-store contract used by
 * runtime hooks: project-cache → global-cache → rules-manifest fallback.
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
} from "../../hooks/src/patterns.mts";
import {
  createSkillStore,
  type SkillStore,
  type ResolvedSkillPayload,
  type SkillStoreLogger,
} from "../../hooks/src/skill-store.mts";
import {
  resolveVercelJsonSkills,
  isVercelJsonPath,
  VERCEL_JSON_SKILLS,
} from "../../hooks/src/vercel-config.mts";

const MAX_SKILLS = 3;
const DEFAULT_INJECTION_BUDGET_BYTES = 12_000;
const DEFAULT_PLUGIN_ROOT = resolve(import.meta.dir, "../..");

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
  /** Byte size of the skill payload (null if unavailable) */
  bodyBytes: number | null;
  /** Human-readable explanation of why the skill was dropped or how it was injected */
  capReason: string;
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
  /** Warnings from skill-store loading (malformed frontmatter, missing fields, etc.) */
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
  /** Plugin root directory (default: resolved from import.meta) */
  pluginRoot?: string;
  /** Emit debug diagnostics to stderr */
  debug?: boolean;
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
  const opts = options || {};
  const budget = opts.budgetBytes ?? DEFAULT_INJECTION_BUDGET_BYTES;
  const pluginRoot = opts.pluginRoot ?? DEFAULT_PLUGIN_ROOT;

  // Parse likely skills for profiler boost simulation
  const likelySkills = new Set<string>();
  if (opts.likelySkills) {
    for (const s of opts.likelySkills.split(",")) {
      const trimmed = s.trim();
      if (trimmed) likelySkills.add(trimmed);
    }
  }

  // Build a debug logger that writes to stderr
  const buildWarnings: string[] = [];
  const logger: SkillStoreLogger | undefined = opts.debug
    ? {
        debug(event, data) {
          console.error(JSON.stringify({ event, ...data }));
        },
        issue(code, message, hint, data) {
          buildWarnings.push(`${code}: ${message}`);
          console.error(JSON.stringify({ event: "explain-issue", code, message, hint, ...data }));
        },
      }
    : {
        issue(code, message) {
          buildWarnings.push(`${code}: ${message}`);
        },
      };

  // Load skill metadata through the skill-store contract
  const store = createSkillStore(
    {
      projectRoot,
      pluginRoot,
      includeRulesManifest:
        process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1",
    },
    logger,
  );

  const loaded = store.loadSkillSet(logger);
  if (!loaded) {
    throw new Error(
      `No skill metadata available. Expected ~/.vercel-plugin cache entries or ${join(
        pluginRoot,
        "generated",
        "skill-rules.json",
      )}.`,
    );
  }

  if (opts.debug) {
    console.error(
      JSON.stringify({
        event: "explain-skill-store-loaded",
        projectRoot,
        roots: store.roots.map((root) => ({
          source: root.source,
          rootDir: root.rootDir,
          manifestPath: root.manifestPath,
        })),
        skillCount: Object.keys(loaded.skillMap).length,
      }),
    );
  }

  const { skillMap, compiledSkills } = loaded;

  const targetType = detectTargetType(target, opts.toolName);

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

  for (const entry of compiledSkills) {
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

  // Sort by effectivePriority DESC, then skill name ASC
  const rankedEntries = rankEntries(matchedEntries);

  // Simulate byte budget + cap selection using the skill store
  const injectionPlan = simulateInjection(rankedEntries, store, budget);

  // Build result with injection/cap/budget tracking
  const matches: ExplainMatch[] = rankedEntries.map((entry) => {
    const plan = injectionPlan.get(entry.skill)!;
    return {
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
// Byte budget + cap simulation using skill store payload resolution
// ---------------------------------------------------------------------------

interface InjectionPlan {
  mode: "full" | "summary" | "droppedByCap" | "droppedByBudget";
  bodyBytes: number | null;
  capReason: string;
}

function skillInvocationMessage(skill: string): string {
  return `You must run the Skill(${skill}) tool.`;
}

function summaryFallbackText(payload: ResolvedSkillPayload): string {
  return [
    skillInvocationMessage(payload.skill),
    payload.summary.trim() !== "" ? `Summary: ${payload.summary.trim()}` : null,
    payload.docs.length > 0 ? `Docs: ${payload.docs.join(", ")}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function simulateInjection(
  rankedEntries: Array<{ skill: string }>,
  store: SkillStore,
  budgetBytes: number,
): Map<string, InjectionPlan> & { usedBytes: number } {
  const result = new Map<string, InjectionPlan>() as Map<string, InjectionPlan> & { usedBytes: number };
  let loadedCount = 0;
  let usedBytes = 0;

  for (const entry of rankedEntries) {
    const skill = entry.skill;
    const payload = store.resolveSkillPayload(skill);

    if (!payload) {
      result.set(skill, {
        mode: "droppedByBudget",
        bodyBytes: null,
        capReason: "skill payload unavailable",
      });
      continue;
    }

    // Compute the wrapped text that would be injected at runtime
    const isBody = payload.mode === "body" && payload.body !== null;
    const wrapped = isBody
      ? `<!-- skill:${skill} -->\n${payload.body}\n<!-- /skill:${skill} -->`
      : summaryFallbackText(payload);
    const wrappedBytes = Buffer.byteLength(wrapped, "utf-8");

    // Hard ceiling check (same as runtime)
    if (loadedCount >= MAX_SKILLS) {
      result.set(skill, {
        mode: "droppedByCap",
        bodyBytes: wrappedBytes,
        capReason: `exceeded MAX_SKILLS=${MAX_SKILLS} hard cap (${loadedCount} already injected)`,
      });
      continue;
    }

    // Budget check: always allow the first skill, then enforce budget
    if (loadedCount > 0 && usedBytes + wrappedBytes > budgetBytes) {
      // Try summary fallback if we had a full body
      if (isBody) {
        const summaryWrapped = summaryFallbackText(payload);
        const summaryBytes = Buffer.byteLength(summaryWrapped, "utf-8");
        if (usedBytes + summaryBytes <= budgetBytes) {
          result.set(skill, {
            mode: "summary",
            bodyBytes: wrappedBytes,
            capReason: `full body (${wrappedBytes}B) exceeds budget (${usedBytes}+${wrappedBytes} > ${budgetBytes}B); using summary (${summaryBytes}B)`,
          });
          loadedCount++;
          usedBytes += summaryBytes;
          continue;
        }
      }
      result.set(skill, {
        mode: "droppedByBudget",
        bodyBytes: wrappedBytes,
        capReason: `would exceed byte budget (${usedBytes}+${wrappedBytes} = ${usedBytes + wrappedBytes}B > ${budgetBytes}B)`,
      });
      continue;
    }

    const position = loadedCount + 1;
    const mode = isBody ? "full" : "summary";
    result.set(skill, {
      mode,
      bodyBytes: wrappedBytes,
      capReason: `injected #${position} (${wrappedBytes}B, total ${usedBytes + wrappedBytes}B / ${budgetBytes}B)`,
    });
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

    const priStr = m.effectivePriority !== m.priority
      ? `${m.effectivePriority} (base ${m.priority})`
      : `${m.priority}`;
    const bytesStr = m.bodyBytes != null ? ` (${m.bodyBytes} bytes)` : "";
    lines.push(`  [${status}] ${m.skill}${bytesStr}`);
    lines.push(`          priority: ${priStr}`);
    lines.push(`          pattern:  ${m.matchedPattern} (${m.matchType})`);
    lines.push(`          reason:   ${m.capReason}`);
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
