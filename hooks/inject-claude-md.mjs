#!/usr/bin/env node

// hooks/src/inject-claude-md.mts
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { formatOutput } from "./compat.mjs";
import { pluginRoot, safeReadFile } from "./hook-env.mjs";
import { hasSessionStartActivationMarkers, isGreenfieldDirectory } from "./session-start-activation.mjs";
var INJECT_CLAUDE_MD_PART_BUDGET = 9e3;
var PART_FLAG = "--part";
var PART_SEPARATOR = "\n\n";
var GREENFIELD_CONTEXT = `<!-- vercel-plugin:greenfield-execution -->
## Greenfield execution mode

This directory is empty.
Do not stop in planning mode or spin up a read-only planning subagent.
Choose sensible defaults immediately.
Start executing with real tool calls.
Use non-interactive scaffolding commands (--yes) where available.
Only ask follow-up questions when blocked by missing credentials or irreversible decisions.`;
function parseInjectClaudeMdInput(raw) {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function detectInjectClaudeMdPlatform(input, _env = process.env) {
  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }
  return "claude-code";
}
function buildInjectClaudeMdParts(content, env = process.env, knowledgeUpdate = null, greenfield = env.VERCEL_PLUGIN_GREENFIELD === "true") {
  const parts = [];
  if (content !== null) {
    parts.push(content);
  }
  if (greenfield) {
    parts.push(GREENFIELD_CONTEXT);
  }
  if (knowledgeUpdate !== null) {
    parts.push(knowledgeUpdate);
  }
  return parts;
}
var FENCE_PATTERN = /^ {0,3}(```|~~~)/;
var LIST_ITEM_PATTERN = /^(?:[-*+]|\d+[.)])\s/;
function trimBlankLines(text) {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}
function lineStarts(lines, isStart) {
  const starts = [];
  let inFence = false;
  lines.forEach((line, index) => {
    const isFence = FENCE_PATTERN.test(line);
    if (!inFence && !isFence && isStart(line, lines[index - 1])) {
      starts.push(index);
    }
    if (isFence) {
      inFence = !inFence;
    }
  });
  return starts;
}
function splitMarkdownSections(markdown) {
  const lines = markdown.split("\n");
  const boundaries = [0, ...lineStarts(lines, (line) => line.startsWith("## ")).filter((index) => index > 0)];
  return boundaries.map((start, i) => trimBlankLines(lines.slice(start, boundaries[i + 1] ?? lines.length).join("\n"))).filter(Boolean);
}
function splitLongSection(section, limit) {
  const lines = section.split("\n");
  const heading = lines[0].startsWith("## ") ? lines[0] : null;
  const boundaries = [
    0,
    ...lineStarts(
      lines,
      (line, previous) => line.trim() !== "" && !/^\s/.test(line) && (LIST_ITEM_PATTERN.test(line) || previous?.trim() === "")
    ).filter((index) => index > (heading === null ? 0 : 1))
  ];
  const render = (from, to) => {
    const body = trimBlankLines(lines.slice(boundaries[from], boundaries[to + 1] ?? lines.length).join("\n"));
    return from === 0 || heading === null ? body : `${heading} (continued)${PART_SEPARATOR}${body}`;
  };
  const pieces = [];
  for (let from = 0; from < boundaries.length; ) {
    let to = from;
    while (to + 1 < boundaries.length && render(from, to + 1).length <= limit) {
      to++;
    }
    pieces.push(render(from, to));
    from = to + 1;
  }
  return pieces;
}
function knowledgeUpdateBlocks(knowledgeUpdate, budget) {
  const title = knowledgeUpdate.split("\n", 1)[0];
  const continuationHeader = title.startsWith("# ") ? `${title} (continued)` : null;
  const limit = budget - (continuationHeader === null ? 0 : continuationHeader.length + PART_SEPARATOR.length);
  return splitMarkdownSections(knowledgeUpdate).flatMap((section) => section.length <= limit ? [section] : splitLongSection(section, limit)).map((text, index) => ({ text, continuationHeader: index === 0 ? null : continuationHeader }));
}
function packBlocks(blocks, budget) {
  const parts = [];
  let current = null;
  for (const block of blocks) {
    if (current !== null) {
      const joined = `${current}${PART_SEPARATOR}${block.text}`;
      if (joined.length <= budget) {
        current = joined;
        continue;
      }
      parts.push(current);
    }
    current = block.continuationHeader === null ? block.text : `${block.continuationHeader}${PART_SEPARATOR}${block.text}`;
  }
  if (current !== null) {
    parts.push(current);
  }
  return parts;
}
function buildInjectClaudeMdOutputs(content, env = process.env, knowledgeUpdate = null, greenfield = env.VERCEL_PLUGIN_GREENFIELD === "true", budget = INJECT_CLAUDE_MD_PART_BUDGET) {
  const blocks = buildInjectClaudeMdParts(content, env, null, greenfield).map((text) => ({ text, continuationHeader: null }));
  if (knowledgeUpdate !== null) {
    blocks.push(...knowledgeUpdateBlocks(knowledgeUpdate, budget));
  }
  return packBlocks(blocks, budget);
}
function parseInjectClaudeMdPart(args) {
  const flagIndex = args.indexOf(PART_FLAG);
  if (flagIndex === -1) return null;
  const match = /^(\d+)\/(\d+)$/.exec(args[flagIndex + 1] ?? "");
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  return index >= 1 && index <= count ? { index, count } : null;
}
function selectInjectClaudeMdPart(outputs, part) {
  if (part === null) return outputs.join(PART_SEPARATOR);
  if (part.index < part.count) return outputs[part.index - 1] ?? "";
  return outputs.slice(part.count - 1).join(PART_SEPARATOR);
}
function formatInjectClaudeMdOutput(platform, content) {
  if (platform === "cursor") {
    return JSON.stringify(formatOutput(platform, { additionalContext: content }));
  }
  return content;
}
function resolveInjectClaudeMdProjectRoot(env = process.env) {
  return env.CLAUDE_PROJECT_ROOT ?? env.CURSOR_PROJECT_DIR ?? process.cwd();
}
function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}
function main() {
  const input = parseInjectClaudeMdInput(readFileSync(0, "utf8"));
  const platform = detectInjectClaudeMdPlatform(input);
  const args = process.argv.slice(2);
  const part = parseInjectClaudeMdPart(args);
  if (part === null && args.includes(PART_FLAG)) {
    process.stderr.write(`[vercel-plugin] inject-claude-md: ignoring invalid ${args.join(" ")}; printing every part.
`);
  }
  const projectRoot = resolveInjectClaudeMdProjectRoot();
  const isGreenfield = isGreenfieldDirectory(projectRoot);
  const greenfieldOverride = process.env.VERCEL_PLUGIN_GREENFIELD === "true";
  const shouldActivate = isGreenfield || greenfieldOverride || !existsSync(projectRoot) || hasSessionStartActivationMarkers(projectRoot);
  if (!shouldActivate) {
    if (platform === "cursor") {
      process.stdout.write(JSON.stringify(formatOutput(platform, {})));
    }
    return;
  }
  const thinSessionContext = safeReadFile(join(pluginRoot(), "vercel-session.md"));
  const knowledgeUpdateRaw = safeReadFile(join(pluginRoot(), "skills", "knowledge-update", "SKILL.md"));
  const knowledgeUpdate = knowledgeUpdateRaw !== null ? stripFrontmatter(knowledgeUpdateRaw) : null;
  const outputs = buildInjectClaudeMdOutputs(
    thinSessionContext,
    process.env,
    knowledgeUpdate,
    isGreenfield || greenfieldOverride
  );
  if (part !== null && part.index === part.count && outputs.length > part.count) {
    process.stderr.write(
      `[vercel-plugin] inject-claude-md: the session context needs ${outputs.length} parts but hooks.json runs ${part.count}. Part ${part.count} prints the rest and may exceed Claude Code's hook output cap.
`
    );
  }
  const content = selectInjectClaudeMdPart(outputs, part);
  if (!content) {
    if (platform === "cursor") {
      process.stdout.write(JSON.stringify(formatOutput(platform, {})));
    }
    return;
  }
  process.stdout.write(formatInjectClaudeMdOutput(platform, content));
}
var INJECT_CLAUDE_MD_ENTRYPOINT = fileURLToPath(import.meta.url);
var isInjectClaudeMdEntrypoint = process.argv[1] ? resolve(process.argv[1]) === INJECT_CLAUDE_MD_ENTRYPOINT : false;
if (isInjectClaudeMdEntrypoint) {
  main();
}
export {
  INJECT_CLAUDE_MD_PART_BUDGET,
  buildInjectClaudeMdOutputs,
  buildInjectClaudeMdParts,
  detectInjectClaudeMdPlatform,
  formatInjectClaudeMdOutput,
  parseInjectClaudeMdInput,
  parseInjectClaudeMdPart,
  selectInjectClaudeMdPart
};
