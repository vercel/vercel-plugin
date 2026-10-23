#!/usr/bin/env node
/**
 * SessionStart hook: inject a thin Vercel session context.
 * Claude Code receives plain-text stdout.
 * Cursor receives `{ additional_context: "..." }` JSON on stdout.
 *
 * Claude Code caps each hook's output at 10,000 characters (JS string length)
 * and replaces longer output with a file path and a preview of up to 2,000
 * characters. The session context, greenfield guidance and knowledge update
 * together are longer than that, so they are packed in order into parts of at
 * most INJECT_CLAUDE_MD_PART_BUDGET characters, split at `##` sections (and at
 * top-level blocks of a section that is too long on its own). hooks.json runs
 * this hook once per part with `--part <i>/<n>`. Without `--part` it prints
 * every part.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatOutput, type HookPlatform } from "./compat.mjs";
import { pluginRoot, safeReadFile } from "./hook-env.mjs";
import { hasSessionStartActivationMarkers, isGreenfieldDirectory } from "./session-start-activation.mjs";

interface InjectClaudeMdInput {
  session_id?: string;
  conversation_id?: string;
  cursor_version?: string;
  [key: string]: unknown;
}

/**
 * Longest part, in UTF-16 code units (the JS string length Claude Code
 * compares with its 10,000-character cap). The gap is headroom.
 */
export const INJECT_CLAUDE_MD_PART_BUDGET = 9_000;

const PART_FLAG = "--part";
const PART_SEPARATOR = "\n\n";

const GREENFIELD_CONTEXT = `<!-- vercel-plugin:greenfield-execution -->
## Greenfield execution mode

This directory is empty.
Do not stop in planning mode or spin up a read-only planning subagent.
Choose sensible defaults immediately.
Start executing with real tool calls.
Use non-interactive scaffolding commands (--yes) where available.
Only ask follow-up questions when blocked by missing credentials or irreversible decisions.`;

export function parseInjectClaudeMdInput(raw: string): InjectClaudeMdInput | null {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw) as InjectClaudeMdInput;
  } catch {
    return null;
  }
}

export function detectInjectClaudeMdPlatform(
  input: InjectClaudeMdInput | null,
  _env: NodeJS.ProcessEnv = process.env,
): HookPlatform {
  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }

  return "claude-code";
}

export function buildInjectClaudeMdParts(
  content: string | null,
  env: NodeJS.ProcessEnv = process.env,
  knowledgeUpdate: string | null = null,
  greenfield = env.VERCEL_PLUGIN_GREENFIELD === "true",
): string[] {
  const parts: string[] = [];

  if (content !== null) {
    parts.push(content);
  }

  // Greenfield guidance belongs to the session context, so it comes before the
  // knowledge update and lands in the first part with it.
  if (greenfield) {
    parts.push(GREENFIELD_CONTEXT);
  }

  if (knowledgeUpdate !== null) {
    parts.push(knowledgeUpdate);
  }

  return parts;
}

interface ContextBlock {
  text: string;
  /** Printed above the block when it starts a part, so a continued document keeps its title. */
  continuationHeader: string | null;
}

const FENCE_PATTERN = /^ {0,3}(```|~~~)/;
const LIST_ITEM_PATTERN = /^(?:[-*+]|\d+[.)])\s/;

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/** Indexes of the lines that satisfy `isStart`, skipping lines inside code fences. */
function lineStarts(lines: string[], isStart: (line: string, previous: string | undefined) => boolean): number[] {
  const starts: number[] = [];
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

/** Splits markdown before each `##` heading. Text before the first heading is its own section. */
function splitMarkdownSections(markdown: string): string[] {
  const lines = markdown.split("\n");
  const boundaries = [0, ...lineStarts(lines, (line) => line.startsWith("## ")).filter((index) => index > 0)];
  return boundaries
    .map((start, i) => trimBlankLines(lines.slice(start, boundaries[i + 1] ?? lines.length).join("\n")))
    .filter(Boolean);
}

/**
 * Splits a section that is longer than `limit` between its top-level blocks
 * (list items and paragraphs; a code fence stays with the block before it).
 * Pieces after the first repeat the heading with "(continued)". A single block
 * longer than `limit` stays whole.
 */
function splitLongSection(section: string, limit: number): string[] {
  const lines = section.split("\n");
  const heading = lines[0].startsWith("## ") ? lines[0] : null;
  const boundaries = [
    0,
    ...lineStarts(lines, (line, previous) =>
      line.trim() !== "" && !/^\s/.test(line) && (LIST_ITEM_PATTERN.test(line) || previous?.trim() === ""),
    ).filter((index) => index > (heading === null ? 0 : 1)),
  ];
  const render = (from: number, to: number): string => {
    const body = trimBlankLines(lines.slice(boundaries[from], boundaries[to + 1] ?? lines.length).join("\n"));
    return from === 0 || heading === null ? body : `${heading} (continued)${PART_SEPARATOR}${body}`;
  };

  const pieces: string[] = [];
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

function knowledgeUpdateBlocks(knowledgeUpdate: string, budget: number): ContextBlock[] {
  const title = knowledgeUpdate.split("\n", 1)[0];
  const continuationHeader = title.startsWith("# ") ? `${title} (continued)` : null;
  const limit = budget - (continuationHeader === null ? 0 : continuationHeader.length + PART_SEPARATOR.length);
  return splitMarkdownSections(knowledgeUpdate)
    .flatMap((section) => (section.length <= limit ? [section] : splitLongSection(section, limit)))
    .map((text, index) => ({ text, continuationHeader: index === 0 ? null : continuationHeader }));
}

/** Packs blocks in order, starting a new part whenever the next block would push it over `budget`. */
function packBlocks(blocks: ContextBlock[], budget: number): string[] {
  const parts: string[] = [];
  let current: string | null = null;
  for (const block of blocks) {
    if (current !== null) {
      const joined: string = `${current}${PART_SEPARATOR}${block.text}`;
      if (joined.length <= budget) {
        current = joined;
        continue;
      }
      parts.push(current);
    }
    current = block.continuationHeader === null
      ? block.text
      : `${block.continuationHeader}${PART_SEPARATOR}${block.text}`;
  }
  if (current !== null) {
    parts.push(current);
  }
  return parts;
}

/**
 * The session-start context as Claude Code hook outputs: the parts from
 * `buildInjectClaudeMdParts`, in order, with the knowledge update split at
 * `##` sections, packed into parts of at most `budget` characters. A block that
 * cannot be split below `budget` gets a part of its own and is not truncated.
 */
export function buildInjectClaudeMdOutputs(
  content: string | null,
  env: NodeJS.ProcessEnv = process.env,
  knowledgeUpdate: string | null = null,
  greenfield = env.VERCEL_PLUGIN_GREENFIELD === "true",
  budget = INJECT_CLAUDE_MD_PART_BUDGET,
): string[] {
  const blocks: ContextBlock[] = buildInjectClaudeMdParts(content, env, null, greenfield)
    .map((text) => ({ text, continuationHeader: null }));
  if (knowledgeUpdate !== null) {
    blocks.push(...knowledgeUpdateBlocks(knowledgeUpdate, budget));
  }
  return packBlocks(blocks, budget);
}

export interface InjectClaudeMdPart {
  /** 1-based. */
  index: number;
  count: number;
}

/** Reads `--part <index>/<count>` from the hook arguments. */
export function parseInjectClaudeMdPart(args: string[]): InjectClaudeMdPart | null {
  const flagIndex = args.indexOf(PART_FLAG);
  if (flagIndex === -1) return null;
  const match = /^(\d+)\/(\d+)$/.exec(args[flagIndex + 1] ?? "");
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  return index >= 1 && index <= count ? { index, count } : null;
}

/**
 * What one invocation prints. With more outputs than registered parts, the
 * last part prints all the remaining outputs rather than dropping them.
 */
export function selectInjectClaudeMdPart(outputs: string[], part: InjectClaudeMdPart | null): string {
  if (part === null) return outputs.join(PART_SEPARATOR);
  if (part.index < part.count) return outputs[part.index - 1] ?? "";
  return outputs.slice(part.count - 1).join(PART_SEPARATOR);
}

export function formatInjectClaudeMdOutput(platform: HookPlatform, content: string): string {
  if (platform === "cursor") {
    return JSON.stringify(formatOutput(platform, { additionalContext: content }));
  }

  return content;
}

function resolveInjectClaudeMdProjectRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PROJECT_ROOT ?? env.CURSOR_PROJECT_DIR ?? process.cwd();
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

function main(): void {
  const input = parseInjectClaudeMdInput(readFileSync(0, "utf8"));
  const platform = detectInjectClaudeMdPlatform(input);
  const args = process.argv.slice(2);
  const part = parseInjectClaudeMdPart(args);
  if (part === null && args.includes(PART_FLAG)) {
    process.stderr.write(`[vercel-plugin] inject-claude-md: ignoring invalid ${args.join(" ")}; printing every part.\n`);
  }
  const projectRoot = resolveInjectClaudeMdProjectRoot();
  const isGreenfield = isGreenfieldDirectory(projectRoot);
  const greenfieldOverride = process.env.VERCEL_PLUGIN_GREENFIELD === "true";
  const shouldActivate =
    isGreenfield || greenfieldOverride || !existsSync(projectRoot) || hasSessionStartActivationMarkers(projectRoot);
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
    isGreenfield || greenfieldOverride,
  );

  if (part !== null && part.index === part.count && outputs.length > part.count) {
    process.stderr.write(
      `[vercel-plugin] inject-claude-md: the session context needs ${outputs.length} parts but hooks.json runs ${part.count}. ` +
        `Part ${part.count} prints the rest and may exceed Claude Code's hook output cap.\n`,
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

const INJECT_CLAUDE_MD_ENTRYPOINT = fileURLToPath(import.meta.url);
const isInjectClaudeMdEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === INJECT_CLAUDE_MD_ENTRYPOINT
  : false;

if (isInjectClaudeMdEntrypoint) {
  main();
}
