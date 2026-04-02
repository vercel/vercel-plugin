// hooks/src/vercel-context.mts
import { join } from "path";
import {
  pluginRoot as resolvePluginRoot,
  safeReadFile,
  syncSessionFileFromClaims,
  tryClaimSessionKey
} from "./hook-env.mjs";
var PLUGIN_ROOT = resolvePluginRoot();
var DEFAULT_CONTEXT_CHUNK_BUDGET_BYTES = 1800;
var CONTEXT_CHUNK_KIND = "seen-context-chunks";
var SKILL_TO_CHUNK = {
  "nextjs": { chunkId: "nextjs-platform", heading: "Next.js and Rendering" },
  "next-cache-components": { chunkId: "nextjs-platform", heading: "Next.js and Rendering" },
  "next-upgrade": { chunkId: "nextjs-platform", heading: "Next.js and Rendering" },
  "turbopack": { chunkId: "nextjs-platform", heading: "Next.js and Rendering" },
  "next-forge": { chunkId: "nextjs-platform", heading: "Next.js and Rendering" },
  "ai-sdk": { chunkId: "ai-stack", heading: "AI Stack" },
  "ai-gateway": { chunkId: "ai-stack", heading: "AI Stack" },
  "chat-sdk": { chunkId: "ai-stack", heading: "AI Stack" },
  "vercel-functions": { chunkId: "compute-routing", heading: "Compute and Routing" },
  "routing-middleware": { chunkId: "compute-routing", heading: "Compute and Routing" },
  "runtime-cache": { chunkId: "compute-routing", heading: "Compute and Routing" },
  "vercel-sandbox": { chunkId: "compute-routing", heading: "Compute and Routing" },
  "vercel-cli": { chunkId: "deploy-operations", heading: "Deploy and Operations" },
  "deployments-cicd": { chunkId: "deploy-operations", heading: "Deploy and Operations" },
  "env-vars": { chunkId: "deploy-operations", heading: "Deploy and Operations" },
  "marketplace": { chunkId: "deploy-operations", heading: "Deploy and Operations" },
  "vercel-storage": { chunkId: "storage-data", heading: "Storage and Data" },
  "workflow": { chunkId: "workflow-durable", heading: "Workflow and Durability" }
};
function extractDirectSection(markdown, headingText) {
  const specText = headingText.trim().toLowerCase();
  const lines = markdown.split("\n");
  let startLine = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!headingMatch) continue;
    const lineLevel = headingMatch[1].length;
    const lineText = headingMatch[2].trim().toLowerCase();
    if (lineText === specText) {
      startLine = i;
      headingLevel = lineLevel;
      break;
    }
  }
  if (startLine === -1) return "";
  const contentLines = [];
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1].length <= headingLevel) {
      break;
    }
    contentLines.push(lines[i]);
  }
  return contentLines.join("\n").trim();
}
function getManagedContextChunkForSkill(skill, options) {
  const mapping = SKILL_TO_CHUNK[skill];
  if (!mapping) return null;
  const root = options?.pluginRoot ?? PLUGIN_ROOT;
  const raw = safeReadFile(join(root, "vercel.md"));
  if (raw === null) return null;
  const content = extractDirectSection(raw, mapping.heading);
  if (!content) return null;
  const wrapped = `<!-- vercel-context-chunk:${mapping.chunkId} -->
${content}
<!-- /vercel-context-chunk:${mapping.chunkId} -->`;
  const bytes = Buffer.byteLength(wrapped, "utf8");
  const budget = options?.budgetBytes ?? DEFAULT_CONTEXT_CHUNK_BUDGET_BYTES;
  if (bytes > budget) return null;
  return {
    chunkId: mapping.chunkId,
    heading: mapping.heading,
    skill,
    content,
    wrapped,
    bytes
  };
}
function claimManagedContextChunk(chunkId, sessionId) {
  if (!sessionId) return true;
  const claimed = tryClaimSessionKey(sessionId, CONTEXT_CHUNK_KIND, chunkId);
  if (claimed) {
    syncSessionFileFromClaims(sessionId, CONTEXT_CHUNK_KIND);
  }
  return claimed;
}
function selectManagedContextChunk(orderedSkills, options) {
  if (orderedSkills.length === 0) return null;
  const topSkill = orderedSkills[0];
  const chunk = getManagedContextChunkForSkill(topSkill, options);
  if (!chunk) return null;
  return claimManagedContextChunk(chunk.chunkId, options?.sessionId) ? chunk : null;
}
export {
  DEFAULT_CONTEXT_CHUNK_BUDGET_BYTES,
  claimManagedContextChunk,
  getManagedContextChunkForSkill,
  selectManagedContextChunk
};
