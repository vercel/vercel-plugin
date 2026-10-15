import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";
import { compileSkillPatterns, matchImportWithReason, matchPathWithReason, type CompiledSkillEntry } from "../hooks/src/patterns.mts";

let sdk: CompiledSkillEntry;
let bootstrap: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(import.meta.dirname, "../skills"));
  sdk = compileSkillPatterns({ "ai-sdk": skills["ai-sdk"] })[0];
  bootstrap = compileSkillPatterns({ bootstrap: skills.bootstrap })[0];
});

describe("selected-stack routing evidence", () => {
  test.each(["app/api/chat/route.ts", "lib/ai/client.ts", "src/lib/agent.ts"])("does not infer the AI SDK from a generic file path: %s", (path) => {
    expect(matchPathWithReason(path, sdk.compiledPaths)).toBeNull();
  });

  test.each([
    'import { streamText } from "ai";',
    'import { useChat } from "@ai-sdk/react";',
  ])("recognizes actual AI SDK imports: %s", (source) => {
    expect(matchImportWithReason(source, sdk.compiledImports)).not.toBeNull();
  });

  test.each([
    'import OpenAI from "openai";',
    'import { ChatOpenAI } from "@langchain/openai";',
  ])("does not treat another provider or framework as SDK selection: %s", (source) => {
    expect(matchImportWithReason(source, sdk.compiledImports)).toBeNull();
  });

  test.each(["package.json", "prisma/schema.prisma", ".env.example"])("does not require Vercel bootstrap from generic setup files: %s", (path) => {
    expect(matchPathWithReason(path, bootstrap.compiledPaths)).toBeNull();
  });

  test.each([".vercel/project.json", ".vercel/repo.json", "vercel.ts"])("recognizes explicit Vercel project configuration: %s", (path) => {
    expect(matchPathWithReason(path, bootstrap.compiledPaths)).not.toBeNull();
  });
});
