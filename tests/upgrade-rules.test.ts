import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

let loadValidateRules: typeof import("../hooks/src/posttooluse-validate.mts").loadValidateRules;
let runValidation: typeof import("../hooks/src/posttooluse-validate.mts").runValidation;

const ROOT = resolve(import.meta.dirname, "..");

beforeEach(async () => {
  const mod = await import("../hooks/posttooluse-validate.mjs");
  loadValidateRules = mod.loadValidateRules;
  runValidation = mod.runValidation;
});

function getUpgradeViolations(skill: string, content: string, upgradeToSkill: string) {
  const data = loadValidateRules(ROOT);
  expect(data).not.toBeNull();

  return runValidation(content, [skill], data!.rulesMap).filter(
    (violation) => violation.upgradeToSkill === upgradeToSkill,
  );
}

describe("upgrade validate rules", () => {
  describe("nextjs -> auth", () => {
    test("triggers auth upgrade for next-auth usage", () => {
      const violations = getUpgradeViolations(
        "nextjs",
        `import NextAuth from "next-auth";\n`,
        "auth",
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.upgradeToSkill).toBe("auth");
    });

    test("skips auth upgrade when a managed auth provider is already present", () => {
      const violations = getUpgradeViolations(
        "nextjs",
        [
          `import NextAuth from "next-auth";`,
          `import { ClerkProvider } from "@clerk/nextjs";`,
        ].join("\n"),
        "auth",
      );

      expect(violations).toHaveLength(0);
    });
  });

  describe("nextjs -> vercel-functions", () => {
    test("triggers vercel-functions upgrade for Pages Router API types", () => {
      const violations = getUpgradeViolations(
        "nextjs",
        `type HandlerRequest = NextApiRequest;\n`,
        "vercel-functions",
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.upgradeToSkill).toBe("vercel-functions");
    });

    test("skips vercel-functions upgrade for App Router handlers", () => {
      const violations = getUpgradeViolations(
        "nextjs",
        [
          `type HandlerRequest = NextApiRequest;`,
          `export async function GET() {`,
          `  return Response.json({ ok: true });`,
          `}`,
        ].join("\n"),
        "vercel-functions",
      );

      expect(violations).toHaveLength(0);
    });
  });

  describe("vercel-functions -> ai-sdk", () => {
    test("triggers ai-sdk upgrade for direct provider SDK usage", () => {
      const violations = getUpgradeViolations(
        "vercel-functions",
        `import OpenAI from "openai";\n`,
        "ai-sdk",
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.upgradeToSkill).toBe("ai-sdk");
    });

    test("skips ai-sdk upgrade when AI SDK usage is already present", () => {
      const violations = getUpgradeViolations(
        "vercel-functions",
        [
          `import OpenAI from "openai";`,
          `import { streamText } from "ai";`,
        ].join("\n"),
        "ai-sdk",
      );

      expect(violations).toHaveLength(0);
    });
  });

  describe("ai-sdk -> ai-gateway", () => {
    test("triggers ai-gateway upgrade for direct provider credentials", () => {
      const violations = getUpgradeViolations(
        "ai-sdk",
        `const apiKey = process.env.OPENAI_API_KEY;\n`,
        "ai-gateway",
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.upgradeToSkill).toBe("ai-gateway");
    });

    test("skips ai-gateway upgrade when gateway() is already used", () => {
      const violations = getUpgradeViolations(
        "ai-sdk",
        [
          `const model = gateway("openai/gpt-5.4");`,
          `const apiKey = process.env.OPENAI_API_KEY;`,
        ].join("\n"),
        "ai-gateway",
      );

      expect(violations).toHaveLength(0);
    });
  });

  describe("ai-sdk -> ai-elements", () => {
    test("triggers ai-elements upgrade for manual HTML rendering", () => {
      const violations = getUpgradeViolations(
        "ai-sdk",
        `return <div dangerouslySetInnerHTML={{ __html: html }} />;\n`,
        "ai-elements",
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.upgradeToSkill).toBe("ai-elements");
    });

    test("skips ai-elements upgrade when MessageResponse is already present", () => {
      const violations = getUpgradeViolations(
        "ai-sdk",
        [
          `import { MessageResponse } from "@/components/ai-elements/message";`,
          `return <div dangerouslySetInnerHTML={{ __html: html }} />;`,
        ].join("\n"),
        "ai-elements",
      );

      expect(violations).toHaveLength(0);
    });
  });

  describe("vercel-functions -> workflow", () => {
    test("triggers workflow upgrade for delayed execution logic", () => {
      const violations = getUpgradeViolations(
        "vercel-functions",
        `setTimeout(() => console.log("later"), 1_000);\n`,
        "workflow",
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.upgradeToSkill).toBe("workflow");
    });

    test("skips workflow upgrade when workflow directives are already present", () => {
      const violations = getUpgradeViolations(
        "vercel-functions",
        [
          `"use workflow";`,
          `setTimeout(() => console.log("later"), 1_000);`,
        ].join("\n"),
        "workflow",
      );

      expect(violations).toHaveLength(0);
    });
  });

  describe("vercel-functions -> vercel-storage", () => {
    test("triggers vercel-storage upgrade for filesystem writes", () => {
      const violations = getUpgradeViolations(
        "vercel-functions",
        `writeFileSync("/tmp/output.txt", "hello");\n`,
        "vercel-storage",
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.upgradeToSkill).toBe("vercel-storage");
    });

    test("skips vercel-storage upgrade when Vercel Blob is already present", () => {
      const violations = getUpgradeViolations(
        "vercel-functions",
        [
          `import { put } from "@vercel/blob";`,
          `writeFileSync("/tmp/output.txt", "hello");`,
        ].join("\n"),
        "vercel-storage",
      );

      expect(violations).toHaveLength(0);
    });
  });
});
