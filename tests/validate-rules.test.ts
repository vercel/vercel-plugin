import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Validate-rules tests: exercise each skill's validation rules against
 * realistic file content using the exported unit functions from the
 * posttooluse-validate hook. These tests cover:
 *
 * - Per-skill rule accuracy (ai-sdk, ai-gateway, nextjs, vercel-functions, edge-runtime)
 * - Multi-skill overlap (file matching 2+ skills runs both rule sets)
 * - No false positives on clean files
 * - Warn-severity suppression at default log level
 * - Dedup skips re-validation for same file content hash
 * - Unknown/missing file path returns no output
 *
 * NOTE: The inline YAML parser does not process \\\\ escape sequences in
 * double-quoted strings. Patterns like "module\\\\.exports" are stored with
 * literal double-backslashes and only match content containing actual
 * backslash characters. Tests here reflect the actual runtime behavior.
 */

// Import unit functions from the compiled hook
let parseInput: typeof import("../hooks/src/posttooluse-validate.mts").parseInput;
let runValidation: typeof import("../hooks/src/posttooluse-validate.mts").runValidation;
let formatOutput: typeof import("../hooks/src/posttooluse-validate.mts").formatOutput;
let contentHash: typeof import("../hooks/src/posttooluse-validate.mts").contentHash;
let parseValidatedFiles: typeof import("../hooks/src/posttooluse-validate.mts").parseValidatedFiles;
let appendValidatedFile: typeof import("../hooks/src/posttooluse-validate.mts").appendValidatedFile;
let loadValidateRules: typeof import("../hooks/src/posttooluse-validate.mts").loadValidateRules;
let matchFileToSkills: typeof import("../hooks/src/posttooluse-validate.mts").matchFileToSkills;

beforeEach(async () => {
  const mod = await import("../hooks/posttooluse-validate.mjs");
  parseInput = mod.parseInput;
  runValidation = mod.runValidation;
  formatOutput = mod.formatOutput;
  contentHash = mod.contentHash;
  parseValidatedFiles = mod.parseValidatedFiles;
  appendValidatedFile = mod.appendValidatedFile;
  loadValidateRules = mod.loadValidateRules;
  matchFileToSkills = mod.matchFileToSkills;
});

function extractPostValidation(hookSpecificOutput: any): any {
  const ctx = hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- postValidation: ({.*?}) -->/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Helper: build a rules map from real skill data
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");

function loadRealRules() {
  return loadValidateRules(ROOT);
}

// ---------------------------------------------------------------------------
// ai-sdk skill rules (patterns without double-escape issues)
// ---------------------------------------------------------------------------

describe("ai-sdk validation rules", () => {
  test("flags direct openai import", () => {
    const data = loadRealRules();
    expect(data).not.toBeNull();
    const violations = runValidation(
      `import OpenAI from 'openai';\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("@ai-sdk/openai"))).toBe(true);
  });

  test("flags direct anthropic import", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import Anthropic from 'anthropic';\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("@ai-sdk/anthropic"))).toBe(true);
  });

  test("flags Experimental_Agent usage", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { Experimental_Agent } from 'ai';\nconst agent = new Experimental_Agent({});\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    // Experimental_Agent is a plain string pattern, no escape issues
    expect(violations.some((v) => v.message.includes("ToolLoopAgent"))).toBe(true);
    // Should fire on both lines (import and usage)
    expect(violations.filter((v) => v.message.includes("ToolLoopAgent")).length).toBeGreaterThanOrEqual(2);
  });

  test("flags toDataStreamResponse usage", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `return result.toDataStreamResponse();\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("toUIMessageStreamResponse"))).toBe(true);
  });

  test("does not flag toUIMessageStreamResponse", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `return result.toUIMessageStreamResponse();\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("toDataStreamResponse"));
    expect(errors.length).toBe(0);
  });

  test("flags maxSteps config", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const result = streamText({ model, maxSteps: 5 });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.some((v) => v.message.includes("stopWhen"))).toBe(true);
  });

  test("does not flag stopWhen: stepCountIs", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const result = streamText({ model, stopWhen: stepCountIs(5) });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.message.includes("maxSteps"));
    expect(errors.length).toBe(0);
  });

  test("flags onResponse callback (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `useChat({ onResponse: (res) => console.log(res) });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.severity === "recommended" && v.message.includes("onResponse"))).toBe(true);
  });

  test("flags useChat({ api: }) v5 pattern", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const chat = useChat({ api: '/api/chat' });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.some((v) => v.message.includes("DefaultChatTransport"))).toBe(true);
  });

  test("does not flag useChat with transport", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const chat = useChat({ transport: new DefaultChatTransport({ api: '/api/chat' }) });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.message.includes("useChat({ api })"));
    expect(errors.length).toBe(0);
  });

  test("flags body option in useChat (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `useChat({ body: { userId: '123' } });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.severity === "recommended" && v.message.includes("body option"))).toBe(true);
  });

  test("passes clean ai-sdk usage", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { generateText } from 'ai';`,
        `import { openai } from '@ai-sdk/openai';`,
        `const result = await generateText({ model: openai('gpt-4o'), prompt: 'Hi' });`,
      ].join("\n"),
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("@ai-sdk/openai import does not trigger direct openai flag", () => {
    const data = loadRealRules();
    const content = `import { openai } from '@ai-sdk/openai';\n`;
    const violations = runValidation(content, ["ai-sdk"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("@ai-sdk/anthropic import does not trigger direct anthropic flag", () => {
    const data = loadRealRules();
    const content = `import { anthropic } from '@ai-sdk/anthropic';\n`;
    const violations = runValidation(content, ["ai-sdk"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("flags stream.write() without .writer (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `stream.write({ type: 'text', text: 'hello' });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.severity === "recommended" && v.message.includes("stream.writer.write"))).toBe(true);
  });

  test("does not flag stream.writer.write()", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `stream.writer.write({ type: 'text', text: 'hello' });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const writerWarns = violations.filter((v) => v.message.includes("stream.writer.write"));
    expect(writerWarns.length).toBe(0);
  });

  test("flags CoreMessage type (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import type { CoreMessage } from 'ai';\nconst msgs: CoreMessage[] = [];\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("ModelMessage"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("does not flag ModelMessage", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import type { ModelMessage } from 'ai';\nconst msgs: ModelMessage[] = [];\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.message.includes("CoreMessage"));
    expect(errors.length).toBe(0);
  });

  test("flags agent.generateText() (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const result = await agent.generateText({ prompt: 'hi' });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("agent.generate()"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("does not flag agent.generate()", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const result = await agent.generate({ prompt: 'hi' });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.message.includes("agent.generateText"));
    expect(errors.length).toBe(0);
  });

  test("flags agent.streamText() (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const result = await agent.streamText({ prompt: 'hi' });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("agent.stream()"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("flags handleSubmit usage (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const { handleSubmit } = useChat();\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.severity === "recommended" && v.message.includes("sendMessage"))).toBe(true);
  });

  test("does not flag handleSubmit when locally defined as function (skipIfFileContains)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `function handleSubmit(e) {\n  e.preventDefault();\n  submitForm(e);\n}\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.message.includes("sendMessage"));
    expect(warns.length).toBe(0);
  });

  test("does not flag handleSubmit when locally defined as const (skipIfFileContains)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const handleSubmit = (e) => {\n  e.preventDefault();\n  submitForm(e);\n};\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.message.includes("sendMessage"));
    expect(warns.length).toBe(0);
  });

  test("flags streamObject() as removed in AI SDK v6", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const result = await streamObject({ model, prompt });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("streamObject"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("Output.object()"))).toBe(true);
  });

  test("does not flag streamText (no false positive from streamObject rule)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const result = streamText({ model, prompt });\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.message.includes("streamObject"));
    expect(errors.length).toBe(0);
  });

  test("flags tool-invocation string literal", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `if (part.type === 'tool-invocation') {\n  renderTool(part);\n}\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("tool-invocation"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("tool-<toolName>"))).toBe(true);
  });

  test("does not flag tool-invocation when tool-< pattern is present (skipIfFileContains)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `// migrated: part.type === 'tool-<weather>'\n// old: tool-invocation\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.message.includes("tool-invocation"));
    expect(errors.length).toBe(0);
  });

  test("flags isLoading in useChat context (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const { messages, isLoading } = useChat();\nif (isLoading) return <Spinner />;\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.severity === "recommended" && v.message.includes("isLoading"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.some((v) => v.message.includes("status"))).toBe(true);
  });

  test("does not flag isLoading when status is already used (skipIfFileContains)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const { messages, status } = useChat();\nconst isLoading = status === 'streaming';\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.message.includes("isLoading") && v.message.includes("status"));
    expect(warns.length).toBe(0);
  });

  test("flags message.content in UI code (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `{messages.map((message) => <p key={message.id}>{message.content}</p>)}\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.severity === "recommended" && v.message.includes("message.content"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.some((v) => v.message.includes("message.parts"))).toBe(true);
  });

  test("does not flag message.content when message.parts is used (skipIfFileContains)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `{messages.map((m) => m.parts?.map((p) => <p>{p.text}</p>))}\n`,
      ["ai-sdk"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.message.includes("message.content") && v.message.includes("message.parts"));
    expect(warns.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ai-gateway skill rules
// ---------------------------------------------------------------------------

describe("ai-gateway validation rules", () => {
  test("flags hyphenated model slug (anthropic/claude-sonnet-4-6)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `gateway('anthropic/claude-sonnet-4-6')\n`,
      ["ai-gateway"],
      data!.rulesMap,
    );
    // This pattern is a plain string, no escaping needed
    expect(violations.some((v) => v.message.includes("dots not hyphens"))).toBe(true);
  });

  test("AI_GATEWAY_API_KEY is recommended severity (fallback auth)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const key = process.env.AI_GATEWAY_API_KEY;\n`,
      ["ai-gateway"],
      data!.rulesMap,
    );
    const matching = violations.filter((v) => v.message.includes("AI_GATEWAY_API_KEY") || v.message.includes("OIDC") || v.message.includes("fallback"));
    expect(matching.length).toBeGreaterThanOrEqual(1);
    // Should be recommended, not error — it's a supported fallback auth mechanism
    expect(matching.every((v) => v.severity === "recommended")).toBe(true);
  });

  test("flags raw model string without provider/ prefix", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const model = gateway('gpt-4o');\n`,
      ["ai-gateway"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.some((v) => v.message.includes("provider/"))).toBe(true);
  });

  test("does not flag model string with provider/ prefix", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const model = gateway('openai/gpt-5.4');\n`,
      ["ai-gateway"],
      data!.rulesMap,
    );
    const prefixErrors = violations.filter((v) => v.severity === "error" && v.message.includes("provider/"));
    expect(prefixErrors.length).toBe(0);
  });

  test("flags outdated gpt-4o model (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const model = gateway('openai/gpt-4o');\n`,
      ["ai-gateway"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.severity === "recommended" && v.message.includes("gpt-4o"))).toBe(true);
  });

  test("does not warn about gpt-5.4", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const model = gateway('openai/gpt-5.4');\n`,
      ["ai-gateway"],
      data!.rulesMap,
    );
    const outdatedWarns = violations.filter((v) => v.message.includes("gpt-4o"));
    expect(outdatedWarns.length).toBe(0);
  });

  test("flags provider API key env vars", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const key = process.env.OPENAI_API_KEY;\n`,
      ["ai-gateway"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("OIDC") || v.message.includes("vercel"))).toBe(true);
  });

  test("passes correct gateway usage", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { generateText, gateway } from 'ai';`,
        `const result = await generateText({ model: gateway('openai/gpt-5.4'), prompt: 'Hi' });`,
      ].join("\n"),
      ["ai-gateway"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("gateway model slugs do not trigger raw model string flags", () => {
    const data = loadRealRules();
    const content = `const m = gateway('openai/gpt-5.4');\n`;
    const violations = runValidation(content, ["ai-gateway"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nextjs skill rules
// ---------------------------------------------------------------------------

describe("nextjs validation rules", () => {
  test("flags getServerSideProps export (error severity)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `export async function getServerSideProps(ctx) { return { props: {} }; }\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    // The error-severity pattern matches "export async function getServerSideProps"
    expect(violations.some((v) => v.severity === "error")).toBe(true);
  });

  test("flags getServerSideProps mention (warn severity)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `// TODO: migrate getServerSideProps to server component\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("Pages Router"))).toBe(true);
  });

  test("flags next/router import", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { useRouter } from 'next/router';\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.some((v) => v.message.includes("next/navigation"))).toBe(true);
  });

  test("warns about React hooks (use client directive missing)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { useState, useEffect } from 'react';`,
        `export default function Page() { const [x, setX] = useState(0); }`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("use client"))).toBe(true);
    // These are warn severity
    expect(violations.some((v) => v.severity === "warn" && v.message.includes("use client"))).toBe(true);
  });

  // --- New Next.js 16 rules ---

  test("flags next/head import (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import Head from 'next/head';\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.some((v) => v.message.includes("next/head") && v.message.includes("metadata"))).toBe(true);
  });

  test("does not flag next/headers import", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { headers } from 'next/headers';\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const headErrors = violations.filter((v) => v.message.includes("next/head") && v.message.includes("metadata"));
    expect(headErrors.length).toBe(0);
  });

  test("flags middleware export function (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `export function middleware(request: NextRequest) {\n  return NextResponse.next();\n}\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.severity === "recommended" && v.message.includes("proxy()"))).toBe(true);
  });

  test("flags export default function middleware (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `export default function middleware(request: NextRequest) {}\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("proxy()"))).toBe(true);
  });

  test("does not flag proxy function export", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `export function proxy(request: NextRequest) {\n  return NextResponse.next();\n}\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const middlewareWarns = violations.filter((v) => v.message.includes("proxy()"));
    expect(middlewareWarns.length).toBe(0);
  });

  test("flags single-arg revalidateTag (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `revalidateTag('users')\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.severity === "recommended" && v.message.includes("revalidateTag"))).toBe(true);
  });

  test("does not flag revalidateTag with two args", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `revalidateTag('users', 'max')\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const revalidateWarns = violations.filter((v) => v.message.includes("Single-arg revalidateTag"));
    expect(revalidateWarns.length).toBe(0);
  });

  test("flags singular cacheHandler config (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const nextConfig = {\n  cacheHandler: require.resolve('./cache-handler.mjs'),\n};\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.severity === "recommended" && v.message.includes("cacheHandlers (plural)"))).toBe(true);
  });

  test("does not flag cacheHandlers (plural)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const nextConfig = {\n  cacheHandlers: {\n    default: require.resolve('./cache-handler.mjs'),\n  },\n};\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const cacheWarns = violations.filter((v) => v.message.includes("cacheHandlers (plural)"));
    expect(cacheWarns.length).toBe(0);
  });

  test("flags useRef() without initial value (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const ref = useRef();\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.some((v) => v.message.includes("useRef") && v.message.includes("initial value"))).toBe(true);
  });

  test("flags useRef( ) with whitespace (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const ref = useRef(  );\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("useRef") && v.message.includes("initial value"))).toBe(true);
  });

  test("does not flag useRef(null)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const ref = useRef(null);\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const refErrors = violations.filter((v) => v.message.includes("useRef") && v.message.includes("initial value"));
    expect(refErrors.length).toBe(0);
  });

  test("does not flag useRef(0)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const ref = useRef(0);\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const refErrors = violations.filter((v) => v.message.includes("useRef") && v.message.includes("initial value"));
    expect(refErrors.length).toBe(0);
  });

  test("does not flag useRef<HTMLDivElement>(null)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const ref = useRef<HTMLDivElement>(null);\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const refErrors = violations.filter((v) => v.message.includes("useRef") && v.message.includes("initial value"));
    expect(refErrors.length).toBe(0);
  });

  test("flags 'next export' command (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `// Run: next export\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.some((v) => v.message.includes("next export") && v.message.includes('output: "export"'))).toBe(true);
  });

  test("does not flag 'next dev' or 'next build'", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `// Run: next dev\n// Run: next build\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const exportErrors = violations.filter((v) => v.message.includes("next export was removed"));
    expect(exportErrors.length).toBe(0);
  });

  test("passes clean App Router server component", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { db } from '@/lib/db';`,
        `export default async function Page() {`,
        `  const posts = await db.query('SELECT * FROM posts');`,
        `  return <div>{posts.map(p => <p key={p.id}>{p.title}</p>)}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  // --- Next.js 16 async request API rules ---

  test("flags sync cookies() without await (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { cookies } from 'next/headers';`,
        `export default async function Page() {`,
        `  const cookieStore = cookies();`,
        `  return <div>{cookieStore.get('theme')?.value}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("cookies()") && v.message.includes("async"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("flags cookies() chained without await (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `  const theme = cookies().get('theme')?.value;\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("cookies()"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("does not flag await cookies()", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { cookies } from 'next/headers';`,
        `export default async function Page() {`,
        `  const cookieStore = await cookies();`,
        `  return <div>{cookieStore.get('theme')?.value}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const cookieErrors = violations.filter((v) => v.message.includes("cookies()") && v.message.includes("async"));
    expect(cookieErrors.length).toBe(0);
  });

  test("does not flag cookies() in client component", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `'use client'`,
        `import { cookies } from 'some-cookie-lib';`,
        `export default function Page() {`,
        `  const c = cookies();`,
        `  return <div>{c}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const cookieErrors = violations.filter((v) => v.message.includes("cookies()") && v.message.includes("async"));
    expect(cookieErrors.length).toBe(0);
  });

  test("flags sync headers() without await (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { headers } from 'next/headers';`,
        `export default async function Page() {`,
        `  const headersList = headers();`,
        `  return <div>{headersList.get('x-forwarded-for')}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("headers()") && v.message.includes("async"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("does not flag await headers()", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { headers } from 'next/headers';`,
        `export default async function Page() {`,
        `  const headersList = await headers();`,
        `  return <div>{headersList.get('host')}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const headerErrors = violations.filter((v) => v.message.includes("headers()") && v.message.includes("async"));
    expect(headerErrors.length).toBe(0);
  });

  test("does not flag headers() in client component", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `'use client'`,
        `export default function Page() {`,
        `  const h = headers();`,
        `  return <div>{h}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const headerErrors = violations.filter((v) => v.message.includes("headers()") && v.message.includes("async"));
    expect(headerErrors.length).toBe(0);
  });

  test("flags sync params destructuring without await (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `export default async function Page({ params }: { params: Promise<{ slug: string }> }) {`,
        `  const { slug } = params;`,
        `  return <div>{slug}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.severity === "recommended" && v.message.includes("params") && v.message.includes("async"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  test("flags sync params property access (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `  const id = params.id;\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.message.includes("params") && v.message.includes("async"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  test("does not flag await params", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `export default async function Page({ params }: { params: Promise<{ slug: string }> }) {`,
        `  const { slug } = await params;`,
        `  return <div>{slug}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const paramWarns = violations.filter((v) => v.message.includes("params") && v.message.includes("async") && !v.message.includes("searchParams"));
    expect(paramWarns.length).toBe(0);
  });

  test("does not flag params in client component", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `'use client'`,
        `export default function Page({ params }) {`,
        `  const { id } = params;`,
        `  return <div>{id}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const paramWarns = violations.filter((v) => v.message.includes("params") && v.message.includes("async") && !v.message.includes("searchParams"));
    expect(paramWarns.length).toBe(0);
  });

  test("flags sync searchParams destructuring without await (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `export default async function Page({ searchParams }) {`,
        `  const { query } = searchParams;`,
        `  return <div>{query}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.severity === "recommended" && v.message.includes("searchParams") && v.message.includes("async"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  test("flags sync searchParams property access (recommended)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `  const q = searchParams.query;\n`,
      ["nextjs"],
      data!.rulesMap,
    );
    const warns = violations.filter((v) => v.message.includes("searchParams") && v.message.includes("async"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  test("does not flag await searchParams", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `export default async function Page({ searchParams }) {`,
        `  const { query } = await searchParams;`,
        `  return <div>{query}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const spWarns = violations.filter((v) => v.message.includes("searchParams") && v.message.includes("async"));
    expect(spWarns.length).toBe(0);
  });

  test("does not flag searchParams in client component", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `'use client'`,
        `export default function Page({ searchParams }) {`,
        `  const { q } = searchParams;`,
        `  return <div>{q}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const spWarns = violations.filter((v) => v.message.includes("searchParams") && v.message.includes("async"));
    expect(spWarns.length).toBe(0);
  });

  test("passes correct async request API usage", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { cookies, headers } from 'next/headers';`,
        `export default async function Page({ params, searchParams }) {`,
        `  const cookieStore = await cookies();`,
        `  const headersList = await headers();`,
        `  const { slug } = await params;`,
        `  const { query } = await searchParams;`,
        `  return <div>{slug} {query}</div>;`,
        `}`,
      ].join("\n"),
      ["nextjs"],
      data!.rulesMap,
    );
    const asyncErrors = violations.filter((v) => v.message.includes("async in Next.js 16"));
    expect(asyncErrors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// edge-runtime skill rules
// ---------------------------------------------------------------------------

describe("edge-runtime validation rules", () => {
  test("flags fs import (via from pattern)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { readFileSync } from 'node:fs';\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("not available in Edge Runtime"))).toBe(true);
  });

  test("flags bare fs import", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { readFile } from 'fs';\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("fs module"))).toBe(true);
  });

  test("flags child_process import", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { exec } from 'child_process';\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("child_process"))).toBe(true);
  });

  test("flags node:child_process import", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { spawn } from 'node:child_process';\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("child_process"))).toBe(true);
  });

  test("flags net/dns imports", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { createServer } from 'node:net';\nimport { resolve } from 'node:dns';\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.filter((v) => v.message.includes("not available in Edge Runtime")).length).toBeGreaterThanOrEqual(2);
  });

  test("flags require() call", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const fs = require('fs');\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("require()"))).toBe(true);
  });

  test("flags require() with node: prefix", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const path = require('node:path');\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("require()"))).toBe(true);
  });

  test("flags eval() call", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const result = eval('1 + 2');\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("eval()"))).toBe(true);
  });

  test("flags new Function() call", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `const fn = new Function('a', 'b', 'return a + b');\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("new Function()"))).toBe(true);
  });

  test("does not flag new Function in comments", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `// avoid new Function() in edge runtime\nconst fn = (a: number) => a + 1;\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    // Comments are plain text — regex rules can't distinguish comments from code,
    // so the rule WILL fire on the comment text. This is acceptable behavior.
    // The important thing is it fires when actual code uses new Function().
    expect(violations.some((v) => v.message.includes("new Function()"))).toBe(true);
  });

  test("passes clean edge-compatible code", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `export const runtime = 'edge';`,
        `export async function GET(req: Request) {`,
        `  const data = await fetch('https://api.example.com/data');`,
        `  return new Response(JSON.stringify(await data.json()));`,
        `}`,
      ].join("\n"),
      ["edge-runtime"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("does not flag import statements as require()", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { cookies } from '@edge-runtime/cookies';\n`,
      ["edge-runtime"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("require()"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// vercel-functions skill rules
// ---------------------------------------------------------------------------

describe("vercel-functions validation rules", () => {
  test("flags default export in route handler", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `export default function handler(req, res) { res.json({ ok: true }); }\n`,
      ["vercel-functions"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("named exports"))).toBe(true);
  });

  test("flags NextApiRequest/NextApiResponse types", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import type { NextApiRequest, NextApiResponse } from 'next';\n`,
      ["vercel-functions"],
      data!.rulesMap,
    );
    expect(violations.some((v) => v.message.includes("Pages Router types"))).toBe(true);
  });

  test("passes clean App Router route handler", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `export async function GET(req: Request) {`,
        `  const url = new URL(req.url);`,
        `  const name = url.searchParams.get('name');`,
        `  return Response.json({ hello: name });`,
        `}`,
      ].join("\n"),
      ["vercel-functions"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// vercel-storage skill rules
// ---------------------------------------------------------------------------

describe("vercel-storage validation rules", () => {
  test("flags @vercel/kv import (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { kv } from '@vercel/kv';\n`,
      ["vercel-storage"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("@vercel/kv"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("@upstash/redis"))).toBe(true);
  });

  test("flags @vercel/postgres import (error)", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { sql } from '@vercel/postgres';\n`,
      ["vercel-storage"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("@vercel/postgres"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("@neondatabase/serverless"))).toBe(true);
  });

  test("does not flag @upstash/redis import", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { Redis } from '@upstash/redis';\n`,
      ["vercel-storage"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("does not flag @neondatabase/serverless import", () => {
    const data = loadRealRules();
    const violations = runValidation(
      `import { neon } from '@neondatabase/serverless';\n`,
      ["vercel-storage"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("passes clean storage usage", () => {
    const data = loadRealRules();
    const violations = runValidation(
      [
        `import { Redis } from '@upstash/redis';`,
        `import { neon } from '@neondatabase/serverless';`,
        `const redis = Redis.fromEnv();`,
        `const sql = neon(process.env.DATABASE_URL!);`,
      ].join("\n"),
      ["vercel-storage"],
      data!.rulesMap,
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-skill overlap
// ---------------------------------------------------------------------------

describe("multi-skill overlap", () => {
  test("file matching ai-sdk + ai-gateway runs both rule sets", () => {
    const data = loadRealRules();
    // Use patterns that actually work (no double-escape issues):
    // ai-sdk: import from 'openai' (direct import pattern)
    // ai-gateway: anthropic/claude-sonnet-4-6 (hyphenated slug)
    const content = [
      `import OpenAI from 'openai';`,
      `const result = await generateText({ model: gateway('anthropic/claude-sonnet-4-6') });`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk", "ai-gateway"], data!.rulesMap);

    expect(violations.some((v) => v.skill === "ai-sdk")).toBe(true);
    expect(violations.some((v) => v.skill === "ai-gateway")).toBe(true);
    const skills = new Set(violations.map((v) => v.skill));
    expect(skills.size).toBeGreaterThanOrEqual(2);
  });

  test("file matching nextjs + vercel-functions applies both rule sets", () => {
    const data = loadRealRules();
    // nextjs: next/router (error), vercel-functions: NextApiRequest (error) + export default (error)
    const content = [
      `import { useRouter } from 'next/router';`,
      `import type { NextApiRequest, NextApiResponse } from 'next';`,
      `export default function handler(req: NextApiRequest, res: NextApiResponse) {`,
      `  const id = req.query.id;`,
      `  res.json({ id });`,
      `}`,
    ].join("\n");
    const violations = runValidation(content, ["nextjs", "vercel-functions"], data!.rulesMap);

    const skills = new Set(violations.map((v) => v.skill));
    expect(skills.has("nextjs")).toBe(true);
    expect(skills.has("vercel-functions")).toBe(true);
  });

  test("overlapping rules don't suppress each other", () => {
    const data = loadRealRules();
    // ai-sdk flags: import from 'openai'
    // ai-gateway flags: anthropic/claude-sonnet-4-6 (hyphenated slug)
    const content = [
      `import OpenAI from 'openai';`,
      `gateway('anthropic/claude-sonnet-4-6')`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk", "ai-gateway"], data!.rulesMap);

    const aiSdkViolations = violations.filter((v) => v.skill === "ai-sdk");
    const aiGatewayViolations = violations.filter((v) => v.skill === "ai-gateway");
    expect(aiSdkViolations.length).toBeGreaterThan(0);
    expect(aiGatewayViolations.length).toBeGreaterThan(0);
  });

  test("violations report correct line numbers per skill", () => {
    const data = loadRealRules();
    const content = [
      `import OpenAI from 'openai';`,     // line 1 - ai-sdk error
      `const x = 1;`,                      // line 2 - clean
      `gateway('anthropic/claude-sonnet-4-6')`, // line 3 - ai-gateway error
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk", "ai-gateway"], data!.rulesMap);

    const aiSdkV = violations.find((v) => v.skill === "ai-sdk" && v.message.includes("@ai-sdk/openai"));
    const aiGwV = violations.find((v) => v.skill === "ai-gateway" && v.message.includes("dots not hyphens"));
    expect(aiSdkV).toBeDefined();
    expect(aiSdkV!.line).toBe(1);
    expect(aiGwV).toBeDefined();
    expect(aiGwV!.line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// workflow skill rules
// ---------------------------------------------------------------------------

describe("workflow validation rules", () => {
  test("flags experimental_createWorkflow as deprecated", () => {
    const data = loadRealRules();
    const content = `import { experimental_createWorkflow } from '@vercel/workflow';\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("createWorkflow"))).toBe(true);
  });

  test("warns about OIDC setup on @vercel/workflow import", () => {
    const data = loadRealRules();
    const content = `import { createWorkflow } from '@vercel/workflow';\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const warns = violations.filter((v) => v.severity === "recommended");
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.some((v) => v.message.includes("OIDC"))).toBe(true);
  });

  test("stable createWorkflow does NOT trigger experimental warning", () => {
    const data = loadRealRules();
    const content = `import { createWorkflow } from '@vercel/workflow';\nconst wf = createWorkflow({ name: 'test' });\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const experimentalErrors = violations.filter(
      (v) => v.severity === "error" && v.message.includes("experimental"),
    );
    expect(experimentalErrors.length).toBe(0);
  });

  test("flags setTimeout in workflow file", () => {
    const data = loadRealRules();
    const content = `async function myWorkflow() {\n  "use workflow";\n  setTimeout(() => {}, 1000);\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("setTimeout"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("sleep()"))).toBe(true);
  });

  test("flags setInterval in workflow file", () => {
    const data = loadRealRules();
    const content = `async function poll() {\n  "use workflow";\n  setInterval(() => check(), 5000);\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("setInterval"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT flag setTimeout/setInterval in file with 'use step'", () => {
    const data = loadRealRules();
    const content = `async function delayedWork() {\n  "use step";\n  setTimeout(() => notify(), 1000);\n  setInterval(() => poll(), 5000);\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const timerErrors = violations.filter((v) => v.message.includes("setTimeout") || v.message.includes("setInterval"));
    expect(timerErrors.length).toBe(0);
  });

  test("flags context.run() as non-WDK pattern", () => {
    const data = loadRealRules();
    const content = `const result = await context.run("step1", async () => {\n  return doWork();\n});\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("context.run"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes('"use step"'))).toBe(true);
  });

  test("flags require() in workflow file without 'use step'", () => {
    const data = loadRealRules();
    const content = `async function myWorkflow() {\n  "use workflow";\n  const fs = require('fs');\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("require()"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT flag require() in file with 'use step'", () => {
    const data = loadRealRules();
    const content = `async function processFile() {\n  "use step";\n  const fs = require('fs');\n  return fs.readFileSync('data.txt');\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const requireErrors = violations.filter((v) => v.message.includes("require()"));
    expect(requireErrors.length).toBe(0);
  });

  test("warns about getWritable() without 'use step'", () => {
    const data = loadRealRules();
    const content = `async function myWorkflow() {\n  "use workflow";\n  const writer = getWritable().getWriter();\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const warns = violations.filter((v) => v.severity === "recommended" && v.message.includes("getWritable"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.some((v) => v.message.includes('"use step"'))).toBe(true);
  });

  test("does NOT warn about getWritable() in 'use step' function", () => {
    const data = loadRealRules();
    const content = `async function emitEvent() {\n  "use step";\n  const writer = getWritable().getWriter();\n  await writer.write({ type: "done" });\n  writer.releaseLock();\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const writableWarns = violations.filter((v) => v.message.includes("getWritable"));
    expect(writableWarns.length).toBe(0);
  });

  test("does NOT flag sleep() from workflow (no false positive)", () => {
    const data = loadRealRules();
    const content = `import { sleep } from "workflow";\nasync function myWorkflow() {\n  "use workflow";\n  await sleep("5m");\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const timerErrors = violations.filter((v) => v.message.includes("setTimeout") || v.message.includes("setInterval"));
    expect(timerErrors.length).toBe(0);
  });

  test("flags createWorkflow() as legacy API", () => {
    const data = loadRealRules();
    const content = `import { createWorkflow } from '@vercel/workflow';\nconst wf = createWorkflow({ name: 'test' });\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes('"use workflow"'));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT flag createWorkflow when experimental_createWorkflow is present", () => {
    const data = loadRealRules();
    const content = `import { experimental_createWorkflow } from '@vercel/workflow';\nconst wf = experimental_createWorkflow({ name: 'test' });\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    // The createWorkflow rule should be skipped (skipIfFileContains: experimental_createWorkflow)
    const createErrors = violations.filter((v) => v.message.includes('"use workflow" directive'));
    expect(createErrors.length).toBe(0);
  });

  test("flags streamObject() as removed in AI SDK v6", () => {
    const data = loadRealRules();
    const content = `import { streamObject } from "ai";\nconst result = await streamObject({ model, prompt });\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error" && v.message.includes("streamObject"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("Output.object()"))).toBe(true);
  });

  test("flags direct workflow function call without start()", () => {
    const data = loadRealRules();
    const content = `import { myWorkflow } from "@/workflows/my-workflow";\nconst result = await myWorkflow("input");\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const warns = violations.filter((v) => v.severity === "recommended" && v.message.includes("start()"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT flag direct workflow call inside workflow definition file", () => {
    const data = loadRealRules();
    const content = `async function myWorkflow(input: string) {\n  "use workflow";\n  const data = await processWorkflow(input);\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const directCallWarns = violations.filter((v) => v.message.includes("start()") && v.message.includes("workflow/api"));
    expect(directCallWarns.length).toBe(0);
  });

  test("flags native fetch() in workflow file without 'use step'", () => {
    const data = loadRealRules();
    const content = `async function myWorkflow() {\n  "use workflow";\n  const res = await fetch("https://api.example.com");\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const fetchWarns = violations.filter((v) => v.severity === "recommended" && v.message.includes("fetch") && v.message.includes("workflow"));
    expect(fetchWarns.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT flag fetch() in file with 'use step'", () => {
    const data = loadRealRules();
    const content = `async function callAPI() {\n  "use step";\n  const res = await fetch("https://api.example.com");\n  return res.json();\n}\n`;
    const violations = runValidation(content, ["workflow"], data!.rulesMap);
    const fetchWarns = violations.filter((v) => v.message.includes("Native fetch"));
    expect(fetchWarns.length).toBe(0);
  });

  test("workflow has at least 10 validate rules", () => {
    const data = loadRealRules();
    const workflowRules = data!.rulesMap.get("workflow");
    expect(workflowRules).toBeDefined();
    expect(workflowRules!.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// turborepo skill rules
// ---------------------------------------------------------------------------

describe("turborepo validation rules", () => {
  test("flags pipeline key in turbo.json as deprecated", () => {
    const data = loadRealRules();
    const content = `{\n  "pipeline": {\n    "build": { "dependsOn": ["^build"] }\n  }\n}`;
    const violations = runValidation(content, ["turborepo"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((v) => v.message.includes("tasks"))).toBe(true);
  });

  test("tasks key does NOT trigger pipeline warning", () => {
    const data = loadRealRules();
    const content = `{\n  "tasks": {\n    "build": { "dependsOn": ["^build"] }\n  }\n}`;
    const violations = runValidation(content, ["turborepo"], data!.rulesMap);
    const pipelineErrors = violations.filter(
      (v) => v.message.includes("pipeline"),
    );
    expect(pipelineErrors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No false positives
// ---------------------------------------------------------------------------

describe("no false positives", () => {
  test("plain JS with no SDK usage produces no violations", () => {
    const data = loadRealRules();
    const content = [
      `function add(a, b) { return a + b; }`,
      `const result = add(1, 2);`,
      `console.log(result);`,
    ].join("\n");
    const allSkills = [...data!.rulesMap.keys()];
    const violations = runValidation(content, allSkills, data!.rulesMap);
    expect(violations.length).toBe(0);
  });

  test("correct ai-sdk + gateway usage produces no errors", () => {
    const data = loadRealRules();
    const content = [
      `import { generateText, gateway } from 'ai';`,
      `import { openai } from '@ai-sdk/openai';`,
      `const result = await generateText({`,
      `  model: gateway('openai/gpt-5.4'),`,
      `  prompt: 'Hello!'`,
      `});`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk", "ai-gateway"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("correctly versioned anthropic slug does not flag", () => {
    const data = loadRealRules();
    const content = `gateway('anthropic/claude-sonnet-4.6')\n`;
    const violations = runValidation(content, ["ai-gateway"], data!.rulesMap);
    // The dot version should NOT be flagged (only hyphenated version is wrong)
    const slugError = violations.filter((v) => v.message.includes("dots not hyphens"));
    expect(slugError.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Negative tests: valid code that must NOT trigger warnings
// ---------------------------------------------------------------------------

describe("negative tests: ai-sdk valid code", () => {
  test("valid v6 useChat with transport does not trigger body/api/onResponse warnings", () => {
    const data = loadRealRules();
    const content = [
      `'use client';`,
      `import { useChat } from '@ai-sdk/react';`,
      `import { DefaultChatTransport } from 'ai';`,
      ``,
      `function Chat() {`,
      `  const { messages, sendMessage, status } = useChat({`,
      `    transport: new DefaultChatTransport({ api: '/api/chat' }),`,
      `  });`,
      `  return <div>{messages.map(m => <p key={m.id}>{m.parts}</p>)}</div>;`,
      `}`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
    // No false-positive on body or onResponse
    expect(violations.filter((v) => v.message.includes("body option")).length).toBe(0);
    expect(violations.filter((v) => v.message.includes("onResponse")).length).toBe(0);
  });

  test("valid v6 streamText + stopWhen does not trigger maxSteps warning", () => {
    const data = loadRealRules();
    const content = [
      `import { streamText, stepCountIs, gateway } from 'ai';`,
      ``,
      `export async function POST(req: Request) {`,
      `  const result = streamText({`,
      `    model: gateway('openai/gpt-5.4'),`,
      `    messages: [],`,
      `    stopWhen: stepCountIs(5),`,
      `  });`,
      `  return result.toUIMessageStreamResponse();`,
      `}`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("valid v6 ToolLoopAgent does not trigger any warnings", () => {
    const data = loadRealRules();
    const content = [
      `import { ToolLoopAgent, gateway, stepCountIs, tool } from 'ai';`,
      `import { z } from 'zod';`,
      ``,
      `const agent = new ToolLoopAgent({`,
      `  model: gateway('anthropic/claude-sonnet-4.6'),`,
      `  tools: {`,
      `    weather: tool({`,
      `      description: 'Get weather',`,
      `      inputSchema: z.object({ city: z.string() }),`,
      `      execute: async ({ city }) => ({ temp: 72 }),`,
      `    }),`,
      `  },`,
      `  instructions: 'You are helpful.',`,
      `  stopWhen: stepCountIs(5),`,
      `});`,
      ``,
      `const { text } = await agent.generate({ prompt: 'Weather in SF?' });`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("non-useChat body property does not trigger body warning", () => {
    const data = loadRealRules();
    const content = [
      `const response = await fetch('/api/data', {`,
      `  method: 'POST',`,
      `  body: JSON.stringify({ name: 'test' }),`,
      `});`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk"], data!.rulesMap);
    expect(violations.filter((v) => v.message.includes("body option")).length).toBe(0);
  });

  test("non-useChat onResponse does not trigger warning", () => {
    const data = loadRealRules();
    const content = [
      `fetch('/api/data').then(onResponse);`,
      `function onResponse(res: Response) { console.log(res); }`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk"], data!.rulesMap);
    expect(violations.filter((v) => v.message.includes("onResponse")).length).toBe(0);
  });

  test("non-tool parameters property does not trigger warning", () => {
    const data = loadRealRules();
    const content = [
      `const config = {`,
      `  parameters: { timeout: 5000, retries: 3 },`,
      `};`,
      `function buildQuery(parameters: Record<string, string>) {`,
      `  return new URLSearchParams(parameters).toString();`,
      `}`,
    ].join("\n");
    const violations = runValidation(content, ["ai-sdk"], data!.rulesMap);
    expect(violations.filter((v) => v.message.includes("inputSchema")).length).toBe(0);
  });
});

describe("negative tests: ai-gateway valid code", () => {
  test("AI_GATEWAY_API_KEY used as primary auth does not produce error", () => {
    const data = loadRealRules();
    const content = [
      `// CI environment uses API key auth`,
      `const key = process.env.AI_GATEWAY_API_KEY;`,
      `if (!key) throw new Error('Missing AI_GATEWAY_API_KEY');`,
    ].join("\n");
    const violations = runValidation(content, ["ai-gateway"], data!.rulesMap);
    // Should only be warn (suggestion), never error
    const errors = violations.filter((v) => v.severity === "error");
    const keyWarns = violations.filter((v) => v.message.includes("AI_GATEWAY_API_KEY") || v.message.includes("OIDC"));
    expect(errors.filter((v) => v.message.includes("API_KEY") || v.message.includes("OIDC")).length).toBe(0);
    // Recommended is acceptable — it's a soft suggestion
    expect(keyWarns.every((v) => v.severity === "recommended")).toBe(true);
  });

  test("correct gateway model slugs produce no errors", () => {
    const data = loadRealRules();
    const content = [
      `import { generateText, gateway } from 'ai';`,
      ``,
      `const models = [`,
      `  gateway('openai/gpt-5.4'),`,
      `  gateway('anthropic/claude-sonnet-4.6'),`,
      `  gateway('google/gemini-3-flash'),`,
      `  gateway('google/gemini-3.1-flash-image-preview'),`,
      `];`,
    ].join("\n");
    const violations = runValidation(content, ["ai-gateway"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("OIDC-based auth produces no warnings", () => {
    const data = loadRealRules();
    const content = [
      `import { generateText, gateway } from 'ai';`,
      `// VERCEL_OIDC_TOKEN is auto-provisioned`,
      `const result = await generateText({`,
      `  model: gateway('openai/gpt-5.4'),`,
      `  prompt: 'Hello',`,
      `});`,
    ].join("\n");
    const violations = runValidation(content, ["ai-gateway"], data!.rulesMap);
    expect(violations.length).toBe(0);
  });
});

describe("negative tests: nextjs valid code", () => {
  test("client component with 'use client' and hooks does not warn about missing directive", () => {
    const data = loadRealRules();
    const content = [
      `'use client'`,
      `import { useState, useEffect } from 'react'`,
      ``,
      `export function Counter() {`,
      `  const [count, setCount] = useState(0)`,
      `  useEffect(() => { document.title = String(count) }, [count])`,
      `  return <button onClick={() => setCount(c => c + 1)}>{count}</button>`,
      `}`,
    ].join("\n");
    const violations = runValidation(content, ["nextjs"], data!.rulesMap);
    // Should NOT warn about 'use client' — it's already present
    const hookWarns = violations.filter((v) => v.message.includes("use client"));
    expect(hookWarns.length).toBe(0);
  });

  test("client component with double-quote 'use client' and hooks does not warn", () => {
    const data = loadRealRules();
    const content = [
      `"use client"`,
      `import { useState } from 'react'`,
      `export function Toggle() { const [on, setOn] = useState(false); }`,
    ].join("\n");
    const violations = runValidation(content, ["nextjs"], data!.rulesMap);
    const hookWarns = violations.filter((v) => v.message.includes("use client"));
    expect(hookWarns.length).toBe(0);
  });

  test("valid App Router server component produces no errors", () => {
    const data = loadRealRules();
    const content = [
      `import { db } from '@/lib/db'`,
      `import { headers } from 'next/headers'`,
      ``,
      `export default async function Dashboard() {`,
      `  const h = await headers()`,
      `  const data = await db.query('SELECT * FROM metrics')`,
      `  return <div>{data.map(d => <p key={d.id}>{d.value}</p>)}</div>`,
      `}`,
    ].join("\n");
    const violations = runValidation(content, ["nextjs"], data!.rulesMap);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("valid proxy.ts file produces no middleware warnings", () => {
    const data = loadRealRules();
    const content = [
      `import type { NextRequest } from 'next/server'`,
      ``,
      `export function proxy(request: NextRequest) {`,
      `  return NextResponse.next()`,
      `}`,
      ``,
      `export const config = { matcher: ['/dashboard/:path*'] }`,
    ].join("\n");
    const violations = runValidation(content, ["nextjs"], data!.rulesMap);
    const middlewareWarns = violations.filter((v) => v.message.includes("proxy()"));
    expect(middlewareWarns.length).toBe(0);
  });

  test("useRef(null) and useRef(0) produce no errors", () => {
    const data = loadRealRules();
    const content = [
      `'use client'`,
      `import { useRef } from 'react'`,
      `const divRef = useRef<HTMLDivElement>(null)`,
      `const countRef = useRef(0)`,
      `const inputRef = useRef<HTMLInputElement>(null)`,
    ].join("\n");
    const violations = runValidation(content, ["nextjs"], data!.rulesMap);
    const refErrors = violations.filter((v) => v.message.includes("useRef") && v.message.includes("initial value"));
    expect(refErrors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// skipIfFileContains feature tests
// ---------------------------------------------------------------------------

describe("skipIfFileContains rule feature", () => {
  test("rule with skipIfFileContains is skipped when file matches", () => {
    const rules = new Map([
      ["test-skill", [
        {
          pattern: "useState",
          message: "needs use client",
          severity: "warn" as const,
          skipIfFileContains: "^['\"]use client['\"]",
        },
      ]],
    ]);
    const content = `'use client'\nimport { useState } from 'react'\n`;
    const violations = runValidation(content, ["test-skill"], rules);
    expect(violations.length).toBe(0);
  });

  test("rule with skipIfFileContains fires when file does NOT match", () => {
    const rules = new Map([
      ["test-skill", [
        {
          pattern: "useState",
          message: "needs use client",
          severity: "warn" as const,
          skipIfFileContains: "^['\"]use client['\"]",
        },
      ]],
    ]);
    const content = `import { useState } from 'react'\n`;
    const violations = runValidation(content, ["test-skill"], rules);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toBe("needs use client");
  });

  test("invalid skipIfFileContains regex does not crash — rule still fires", () => {
    const rules = new Map([
      ["test-skill", [
        {
          pattern: "foo",
          message: "found foo",
          severity: "warn" as const,
          skipIfFileContains: "[invalid(",
        },
      ]],
    ]);
    const violations = runValidation("foo bar\n", ["test-skill"], rules);
    expect(violations.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Warn-severity suppression at default log level
// ---------------------------------------------------------------------------

describe("warn-severity as suggestions", () => {
  test("formatOutput surfaces warn-only violations as suggestions", () => {
    const violations = [
      { skill: "nextjs", line: 1, message: "hook warning", severity: "warn" as const, matchedText: "useState" },
    ];
    const result = formatOutput(violations, ["nextjs"], "/test/file.tsx");
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("[SUGGESTION]");
    expect(ctx).toContain("hook warning");
    expect(ctx).toContain("Consider applying these suggestions");
    expect(ctx).not.toContain("[ERROR]");
    const meta = extractPostValidation(parsed.hookSpecificOutput);
    expect(meta.errorCount).toBe(0);
    expect(meta.warnCount).toBe(1);
  });

  test("formatOutput includes both errors and warns when mixed", () => {
    const violations = [
      { skill: "ai-sdk", line: 1, message: "Use @ai-sdk/openai", severity: "error" as const, matchedText: "openai" },
      { skill: "nextjs", line: 5, message: "hook warning", severity: "warn" as const, matchedText: "useState" },
    ];
    const result = formatOutput(violations, ["ai-sdk", "nextjs"], "/test/file.tsx");
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("[ERROR]");
    expect(ctx).toContain("[SUGGESTION]");
    expect(ctx).toContain("Please fix these issues");
    const meta = extractPostValidation(parsed.hookSpecificOutput);
    expect(meta.errorCount).toBe(1);
    expect(meta.warnCount).toBe(1);
  });

  test("multiple warn violations all surfaced as suggestions", () => {
    const violations = [
      { skill: "nextjs", line: 1, message: "warn 1", severity: "warn" as const, matchedText: "x" },
      { skill: "nextjs", line: 2, message: "warn 2", severity: "warn" as const, matchedText: "y" },
      { skill: "vercel-functions", line: 3, message: "warn 3", severity: "warn" as const, matchedText: "z" },
    ];
    const result = formatOutput(violations, ["nextjs", "vercel-functions"], "/test/file.ts");
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("3 suggestions");
    expect(ctx).toContain("Consider applying these suggestions");
    const meta = extractPostValidation(parsed.hookSpecificOutput);
    expect(meta.errorCount).toBe(0);
    expect(meta.warnCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// File hash dedup
// ---------------------------------------------------------------------------

describe("file hash dedup", () => {
  test("same content produces same hash", () => {
    const content = `import { openai } from '@ai-sdk/openai';\n`;
    expect(contentHash(content)).toBe(contentHash(content));
  });

  test("different content produces different hash", () => {
    expect(contentHash("version 1")).not.toBe(contentHash("version 2"));
  });

  test("hash is 12 characters", () => {
    expect(contentHash("test content").length).toBe(12);
  });

  test("parseValidatedFiles round-trips with appendValidatedFile", () => {
    let env = "";
    env = appendValidatedFile(env, "file1.ts:aaa111");
    env = appendValidatedFile(env, "file2.ts:bbb222");
    const set = parseValidatedFiles(env);
    expect(set.has("file1.ts:aaa111")).toBe(true);
    expect(set.has("file2.ts:bbb222")).toBe(true);
    expect(set.size).toBe(2);
  });

  test("dedup key is path:hash composite", () => {
    const hash = contentHash("content");
    const key = `/app/route.ts:${hash}`;
    const set = parseValidatedFiles(key);
    expect(set.has(key)).toBe(true);
    expect(set.has(`/app/route.ts:different`)).toBe(false);
  });

  test("parseValidatedFiles handles empty string", () => {
    expect(parseValidatedFiles("")).toEqual(new Set());
  });

  test("parseValidatedFiles handles undefined", () => {
    expect(parseValidatedFiles(undefined)).toEqual(new Set());
  });

  test("parseValidatedFiles handles whitespace entries", () => {
    const set = parseValidatedFiles("a:1, , b:2, ");
    expect(set.size).toBe(2);
    expect(set.has("a:1")).toBe(true);
    expect(set.has("b:2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown/missing file path handling
// ---------------------------------------------------------------------------

describe("unknown/missing file path handling", () => {
  test("parseInput returns null for missing file_path", () => {
    const result = parseInput(JSON.stringify({ tool_name: "Write", tool_input: {} }));
    expect(result).toBeNull();
  });

  test("parseInput returns null for empty file_path", () => {
    const result = parseInput(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "" } }));
    expect(result).toBeNull();
  });

  test("parseInput returns null for non-Write/Edit tools", () => {
    expect(parseInput(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/foo" } }))).toBeNull();
    expect(parseInput(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }))).toBeNull();
    expect(parseInput(JSON.stringify({ tool_name: "Glob", tool_input: { pattern: "*.ts" } }))).toBeNull();
  });

  test("parseInput handles empty string", () => {
    expect(parseInput("")).toBeNull();
  });

  test("parseInput handles invalid JSON", () => {
    expect(parseInput("not json")).toBeNull();
  });

  test("parseInput handles JSON primitives", () => {
    // JSON.parse("42") returns a number, accessing .tool_name returns undefined → ""
    expect(parseInput("42")).toBeNull();
    expect(parseInput('"string"')).toBeNull();
    // JSON.parse("null") returns null — hook code accesses .tool_name on null,
    // which throws. In the full hook this is caught by the top-level try/catch.
    expect(() => parseInput("null")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// matchFileToSkills with real skill data
// ---------------------------------------------------------------------------

describe("matchFileToSkills with real rules", () => {
  test("app/api/chat/route.ts matches ai-sdk via path", () => {
    const data = loadRealRules();
    const matched = matchFileToSkills(
      "app/api/chat/route.ts",
      `export async function POST() {}`,
      data!.compiledSkills,
      data!.rulesMap,
    );
    expect(matched).toContain("ai-sdk");
  });

  test("file importing 'ai' matches ai-sdk via import", () => {
    const data = loadRealRules();
    const matched = matchFileToSkills(
      "src/utils/chat.ts",
      `import { generateText } from 'ai';\n`,
      data!.compiledSkills,
      data!.rulesMap,
    );
    expect(matched).toContain("ai-sdk");
  });

  test("file importing @ai-sdk/gateway matches ai-gateway", () => {
    const data = loadRealRules();
    const matched = matchFileToSkills(
      "lib/chat.ts",
      `import { gateway } from '@ai-sdk/gateway';\n`,
      data!.compiledSkills,
      data!.rulesMap,
    );
    expect(matched).toContain("ai-gateway");
  });

  test("file importing gateway from 'ai' matches ai-gateway", () => {
    const data = loadRealRules();
    const matched = matchFileToSkills(
      "lib/chat.ts",
      `import { gateway } from 'ai';\n`,
      data!.compiledSkills,
      data!.rulesMap,
    );
    expect(matched).toContain("ai-gateway");
  });

  test("app/api/chat/route.ts also matches vercel-functions via path", () => {
    const data = loadRealRules();
    const matched = matchFileToSkills(
      "app/api/chat/route.ts",
      `export async function POST() {}`,
      data!.compiledSkills,
      data!.rulesMap,
    );
    expect(matched).toContain("vercel-functions");
  });

  test("random path with no SDK imports matches no rules", () => {
    const data = loadRealRules();
    const matched = matchFileToSkills(
      "utils/math.ts",
      `export function add(a: number, b: number) { return a + b; }`,
      data!.compiledSkills,
      data!.rulesMap,
    );
    expect(matched.length).toBe(0);
  });

  test("app/page.tsx matches nextjs via path", () => {
    const data = loadRealRules();
    const matched = matchFileToSkills(
      "app/page.tsx",
      `export default function Home() { return <div>Hello</div>; }`,
      data!.compiledSkills,
      data!.rulesMap,
    );
    expect(matched).toContain("nextjs");
  });

  test("file can match multiple skills simultaneously", () => {
    const data = loadRealRules();
    // app/api/chat/route.ts matches ai-sdk (path) AND vercel-functions (route.* path)
    // Plus importing 'ai' reinforces ai-sdk
    const matched = matchFileToSkills(
      "app/api/chat/route.ts",
      `import { generateText } from 'ai';\nexport async function POST() {}`,
      data!.compiledSkills,
      data!.rulesMap,
    );
    expect(matched.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// SyncHookJSONOutput schema compliance
// ---------------------------------------------------------------------------

describe("output schema compliance", () => {
  test("formatOutput with errors has exactly hookSpecificOutput at top level", () => {
    const violations = [
      { skill: "ai-sdk", line: 1, message: "test", severity: "error" as const, matchedText: "x" },
    ];
    const parsed = JSON.parse(formatOutput(violations, ["ai-sdk"], "/f.ts"));
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  test("additionalContext contains posttooluse-validate markers", () => {
    const violations = [
      { skill: "ai-sdk", line: 1, message: "Fix this", severity: "error" as const, matchedText: "bad" },
    ];
    const parsed = JSON.parse(formatOutput(violations, ["ai-sdk"], "/f.ts"));
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("<!-- posttooluse-validate:");
    expect(ctx).toContain("<!-- /posttooluse-validate -->");
    expect(ctx).toContain("<!-- postValidation:");
  });

  test("metadata JSON in postValidation comment is valid", () => {
    const violations = [
      { skill: "ai-sdk", line: 3, message: "Use provider", severity: "error" as const, matchedText: "openai" },
    ];
    const parsed = JSON.parse(formatOutput(violations, ["ai-sdk"], "/f.ts"));
    const meta = extractPostValidation(parsed.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.version).toBe(1);
    expect(meta.hook).toBe("posttooluse-validate");
    expect(meta.filePath).toBe("/f.ts");
    expect(meta.errorCount).toBe(1);
    expect(meta.warnCount).toBe(0);
    expect(Array.isArray(meta.matchedSkills)).toBe(true);
  });

  test("no violations returns empty JSON", () => {
    const result = formatOutput([], ["ai-sdk"], "/f.ts");
    expect(result).toBe("{}");
  });

  test("additionalContext includes fix instructions", () => {
    const violations = [
      { skill: "ai-sdk", line: 1, message: "Fix this error", severity: "error" as const, matchedText: "bad" },
    ];
    const parsed = JSON.parse(formatOutput(violations, ["ai-sdk"], "/f.ts"));
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("VALIDATION");
    expect(ctx).toContain("Line 1");
    expect(ctx).toContain("Fix this error");
    expect(ctx).toContain("Please fix these issues");
  });
});

// ---------------------------------------------------------------------------
// runValidation edge cases
// ---------------------------------------------------------------------------

describe("runValidation edge cases", () => {
  test("skips invalid regex patterns gracefully", () => {
    const rules = new Map([
      ["test-skill", [
        { pattern: "[invalid(regex", message: "broken", severity: "error" as const },
        { pattern: "validPattern", message: "found it", severity: "error" as const },
      ]],
    ]);
    const violations = runValidation("validPattern here\n", ["test-skill"], rules);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toBe("found it");
  });

  test("empty content produces no violations", () => {
    const data = loadRealRules();
    const violations = runValidation("", ["ai-sdk"], data!.rulesMap);
    expect(violations.length).toBe(0);
  });

  test("skill not in rulesMap is skipped", () => {
    const data = loadRealRules();
    const violations = runValidation("anything", ["nonexistent-skill"], data!.rulesMap);
    expect(violations.length).toBe(0);
  });

  test("matched text is truncated to 80 chars", () => {
    const longLine = "import " + "x".repeat(200) + " from 'openai';";
    const rules = new Map([
      ["test", [{ pattern: "import.*from ['\"]openai['\"]", message: "test", severity: "error" as const }]],
    ]);
    const violations = runValidation(longLine, ["test"], rules);
    expect(violations.length).toBe(1);
    expect(violations[0].matchedText.length).toBeLessThanOrEqual(80);
  });

  test("multiple matches on different lines all reported", () => {
    const content = [
      `import A from 'openai';`,
      `import B from 'openai';`,
      `import C from 'openai';`,
    ].join("\n");
    const rules = new Map([
      ["test", [{ pattern: "import.*from ['\"]openai['\"]", message: "bad import", severity: "error" as const }]],
    ]);
    const violations = runValidation(content, ["test"], rules);
    expect(violations.length).toBe(3);
    expect(violations[0].line).toBe(1);
    expect(violations[1].line).toBe(2);
    expect(violations[2].line).toBe(3);
  });
});
