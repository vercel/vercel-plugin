#!/usr/bin/env node
/**
 * SubagentStart hook: injects project context into spawned subagents.
 *
 * Input: JSON on stdin with { session_id, cwd, agent_id, agent_type, hook_event_name }
 * Output: JSON on stdout with { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "..." } } or {}
 *
 * Reads the profiler's VERCEL_PLUGIN_LIKELY_SKILLS env var and injects
 * lightweight skill summaries as additionalContext, scaled by agent type.
 *
 * Agent type budgets:
 *   Explore / Plan  — minimal (~1KB): project profile + top skill names only
 *   general-purpose — standard (~8KB): profile + top skill summaries
 *   other / custom  — standard (~8KB): treat as general-purpose
 */

import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginRoot as resolvePluginRoot, safeReadFile } from "./hook-env.mjs";
import { loadSkills } from "./pretooluse-skill-inject.mjs";
import { createLogger, type Logger } from "./logger.mjs";

const PLUGIN_ROOT = resolvePluginRoot();

/** Budget caps per agent type category. */
const MINIMAL_BUDGET_BYTES = 1_024;
const STANDARD_BUDGET_BYTES = 8_000;
const MINIMAL_AGENT_TYPES = new Set(["Explore", "Plan"]);

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface SubagentStartInput {
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  hook_event_name?: string;
}

function parseInput(): SubagentStartInput | null {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as SubagentStartInput;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

function getLikelySkills(): string[] {
  const raw = process.env.VERCEL_PLUGIN_LIKELY_SKILLS;
  if (!raw || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Build a minimal context string: project profile line + skill name list.
 */
function buildMinimalContext(agentType: string, likelySkills: string[]): string {
  const parts: string[] = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" -->`);
  parts.push("Vercel plugin active. Project likely uses: " + (likelySkills.length > 0 ? likelySkills.join(", ") : "unknown stack") + ".");
  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return parts.join("\n");
}

/**
 * Build standard context: project profile + top skill summaries (from frontmatter).
 */
function buildStandardContext(agentType: string, likelySkills: string[], budgetBytes: number): string {
  const parts: string[] = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" -->`);
  parts.push("Vercel plugin active. Project likely uses: " + (likelySkills.length > 0 ? likelySkills.join(", ") : "unknown stack") + ".");

  // Load skill summaries for likely skills
  let usedBytes = Buffer.byteLength(parts.join("\n"), "utf8");
  const loaded = loadSkills(PLUGIN_ROOT, log);
  if (loaded) {
    for (const skill of likelySkills) {
      const config = loaded.skillMap[skill];
      if (!config) continue;
      const summary = config.summary;
      if (!summary) continue;

      const line = `- **${skill}**: ${summary}`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (usedBytes + lineBytes + 1 > budgetBytes) break;
      parts.push(line);
      usedBytes += lineBytes + 1;
    }
  }

  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const input = parseInput();
  if (!input) {
    process.exit(0);
  }

  const agentId = input.agent_id ?? "unknown";
  const agentType = input.agent_type ?? "unknown";

  log.debug("subagent-start-bootstrap", { agentId, agentType });

  const likelySkills = getLikelySkills();
  const isMinimal = MINIMAL_AGENT_TYPES.has(agentType);

  let context: string;
  if (isMinimal) {
    context = buildMinimalContext(agentType, likelySkills);
  } else {
    context = buildStandardContext(agentType, likelySkills, STANDARD_BUDGET_BYTES);
  }

  // Enforce byte budget
  const maxBytes = isMinimal ? MINIMAL_BUDGET_BYTES : STANDARD_BUDGET_BYTES;
  if (Buffer.byteLength(context, "utf8") > maxBytes) {
    context = context.slice(0, maxBytes);
  }

  const output: SyncHookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

const ENTRYPOINT = fileURLToPath(import.meta.url);
const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === ENTRYPOINT
  : false;

if (isEntrypoint) {
  main();
}

// Exports for testing
export { parseInput, buildMinimalContext, buildStandardContext, getLikelySkills, main };
