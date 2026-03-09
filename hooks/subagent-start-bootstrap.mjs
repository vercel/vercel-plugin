#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginRoot as resolvePluginRoot } from "./hook-env.mjs";
import { loadSkills } from "./pretooluse-skill-inject.mjs";
import { createLogger } from "./logger.mjs";
const PLUGIN_ROOT = resolvePluginRoot();
const MINIMAL_BUDGET_BYTES = 1024;
const STANDARD_BUDGET_BYTES = 8e3;
const MINIMAL_AGENT_TYPES = /* @__PURE__ */ new Set(["Explore", "Plan"]);
const log = createLogger();
function parseInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function getLikelySkills() {
  const raw = process.env.VERCEL_PLUGIN_LIKELY_SKILLS;
  if (!raw || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function buildMinimalContext(agentType, likelySkills) {
  const parts = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" -->`);
  parts.push("Vercel plugin active. Project likely uses: " + (likelySkills.length > 0 ? likelySkills.join(", ") : "unknown stack") + ".");
  parts.push("<!-- /vercel-plugin:subagent-bootstrap -->");
  return parts.join("\n");
}
function buildStandardContext(agentType, likelySkills, budgetBytes) {
  const parts = [];
  parts.push(`<!-- vercel-plugin:subagent-bootstrap agent_type="${agentType}" -->`);
  parts.push("Vercel plugin active. Project likely uses: " + (likelySkills.length > 0 ? likelySkills.join(", ") : "unknown stack") + ".");
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
function main() {
  const input = parseInput();
  if (!input) {
    process.exit(0);
  }
  const agentId = input.agent_id ?? "unknown";
  const agentType = input.agent_type ?? "unknown";
  log.debug("subagent-start-bootstrap", { agentId, agentType });
  const likelySkills = getLikelySkills();
  const isMinimal = MINIMAL_AGENT_TYPES.has(agentType);
  let context;
  if (isMinimal) {
    context = buildMinimalContext(agentType, likelySkills);
  } else {
    context = buildStandardContext(agentType, likelySkills, STANDARD_BUDGET_BYTES);
  }
  const maxBytes = isMinimal ? MINIMAL_BUDGET_BYTES : STANDARD_BUDGET_BYTES;
  if (Buffer.byteLength(context, "utf8") > maxBytes) {
    context = context.slice(0, maxBytes);
  }
  const output = {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: context
    }
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
const ENTRYPOINT = fileURLToPath(import.meta.url);
const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === ENTRYPOINT : false;
if (isEntrypoint) {
  main();
}
export {
  buildMinimalContext,
  buildStandardContext,
  getLikelySkills,
  main,
  parseInput
};
