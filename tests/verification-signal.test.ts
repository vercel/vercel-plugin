import { describe, expect, test } from "bun:test";
import {
  classifyVerificationSignal,
  type NormalizedVerificationSignal,
} from "../hooks/src/verification-signal.mts";

// ---------------------------------------------------------------------------
// Helper: assert classification result shape
// ---------------------------------------------------------------------------

function expectSignal(
  result: NormalizedVerificationSignal | null,
  expected: Partial<NormalizedVerificationSignal>,
): void {
  expect(result).not.toBeNull();
  for (const [key, value] of Object.entries(expected)) {
    expect((result as Record<string, unknown>)[key]).toBe(value);
  }
}

// ---------------------------------------------------------------------------
// Bash strong signals
// ---------------------------------------------------------------------------

describe("classifyVerificationSignal — Bash strong signals", () => {
  test("curl http request → clientRequest + strong + bash", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "curl http://localhost:3000/dashboard" },
    });
    expectSignal(result, {
      boundary: "clientRequest",
      matchedPattern: "http-client",
      signalStrength: "strong",
      evidenceSource: "bash",
      toolName: "Bash",
      inferredRoute: "/dashboard",
    });
  });

  test("wget request → clientRequest + strong", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "wget http://localhost:3000/api/users" },
    });
    expectSignal(result, {
      boundary: "clientRequest",
      signalStrength: "strong",
      evidenceSource: "bash",
      inferredRoute: "/api/users",
    });
  });

  test("playwright command → uiRender + strong + browser", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "npx playwright test" },
    });
    expectSignal(result, {
      boundary: "uiRender",
      matchedPattern: "playwright-cli",
      signalStrength: "strong",
      evidenceSource: "browser",
      toolName: "Bash",
    });
  });

  test("open browser URL → uiRender + strong", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "open https://localhost:3000/settings" },
    });
    expectSignal(result, {
      boundary: "uiRender",
      signalStrength: "strong",
      evidenceSource: "browser",
    });
  });

  test("vercel logs → serverHandler + strong", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "vercel logs --follow" },
    });
    expectSignal(result, {
      boundary: "serverHandler",
      signalStrength: "strong",
    });
  });

  test("printenv → environment + strong", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "printenv DATABASE_URL" },
    });
    expectSignal(result, {
      boundary: "environment",
      signalStrength: "strong",
      evidenceSource: "bash",
    });
  });

  test("Bash with empty command → null", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "" },
    });
    expect(result).toBeNull();
  });

  test("Bash with unrecognized command → null", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "ls -la" },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Browser tool strong signals
// ---------------------------------------------------------------------------

describe("classifyVerificationSignal — browser tool strong signals", () => {
  test("agent_browser → uiRender + strong + browser", () => {
    const result = classifyVerificationSignal({
      toolName: "agent_browser",
      toolInput: { url: "http://localhost:3000/profile" },
    });
    expectSignal(result, {
      boundary: "uiRender",
      matchedPattern: "browser-tool",
      signalStrength: "strong",
      evidenceSource: "browser",
      toolName: "agent_browser",
      inferredRoute: "/profile",
    });
  });

  test("mcp__browser__screenshot → uiRender + strong (no URL)", () => {
    const result = classifyVerificationSignal({
      toolName: "mcp__browser__screenshot",
      toolInput: {},
    });
    expectSignal(result, {
      boundary: "uiRender",
      signalStrength: "strong",
      evidenceSource: "browser",
      toolName: "mcp__browser__screenshot",
    });
    expect(result!.inferredRoute).toBeNull();
    expect(result!.summary).toBe("mcp__browser__screenshot");
  });

  test("mcp__playwright__navigate → uiRender + strong with route", () => {
    const result = classifyVerificationSignal({
      toolName: "mcp__playwright__navigate",
      toolInput: { url: "http://localhost:3000/settings/account" },
    });
    expectSignal(result, {
      boundary: "uiRender",
      signalStrength: "strong",
      inferredRoute: "/settings/account",
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP tool strong signals
// ---------------------------------------------------------------------------

describe("classifyVerificationSignal — HTTP tool strong signals", () => {
  test("WebFetch → clientRequest + strong + http", () => {
    const result = classifyVerificationSignal({
      toolName: "WebFetch",
      toolInput: { url: "https://example.com/api/data" },
    });
    expectSignal(result, {
      boundary: "clientRequest",
      matchedPattern: "web-fetch",
      signalStrength: "strong",
      evidenceSource: "http",
      toolName: "WebFetch",
      inferredRoute: "/api/data",
    });
  });

  test("WebFetch without URL → null", () => {
    const result = classifyVerificationSignal({
      toolName: "WebFetch",
      toolInput: {},
    });
    expect(result).toBeNull();
  });

  test("mcp__fetch__fetch → clientRequest + strong + http", () => {
    const result = classifyVerificationSignal({
      toolName: "mcp__fetch__fetch",
      toolInput: { url: "http://localhost:3000/api/health" },
    });
    expectSignal(result, {
      boundary: "clientRequest",
      matchedPattern: "http-tool",
      signalStrength: "strong",
      evidenceSource: "http",
      toolName: "mcp__fetch__fetch",
      inferredRoute: "/api/health",
    });
  });

  test("mcp__http__post without URL → still strong http", () => {
    const result = classifyVerificationSignal({
      toolName: "mcp__http__post",
      toolInput: { body: '{"key":"val"}' },
    });
    expectSignal(result, {
      boundary: "clientRequest",
      matchedPattern: "http-tool",
      signalStrength: "strong",
      evidenceSource: "http",
    });
    expect(result!.inferredRoute).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Soft signals — env reads
// ---------------------------------------------------------------------------

describe("classifyVerificationSignal — env-read soft signals", () => {
  test("Read .env.local → environment + soft + env-read", () => {
    const result = classifyVerificationSignal({
      toolName: "Read",
      toolInput: { file_path: "/repo/.env.local" },
    });
    expectSignal(result, {
      boundary: "environment",
      matchedPattern: "env-file-read",
      signalStrength: "soft",
      evidenceSource: "env-read",
      toolName: "Read",
    });
    expect(result!.inferredRoute).toBeNull();
  });

  test("Read vercel.json → environment + soft", () => {
    const result = classifyVerificationSignal({
      toolName: "Read",
      toolInput: { file_path: "/repo/vercel.json" },
    });
    expectSignal(result, {
      boundary: "environment",
      matchedPattern: "vercel-config-read",
      signalStrength: "soft",
      evidenceSource: "env-read",
    });
  });

  test("Read .vercel/project.json → environment + soft", () => {
    const result = classifyVerificationSignal({
      toolName: "Read",
      toolInput: { file_path: "/repo/.vercel/project.json" },
    });
    expectSignal(result, {
      boundary: "environment",
      signalStrength: "soft",
    });
  });

  test("Grep in .env → environment + soft", () => {
    const result = classifyVerificationSignal({
      toolName: "Grep",
      toolInput: { pattern: "API_KEY", path: ".env" },
    });
    expectSignal(result, {
      boundary: "environment",
      matchedPattern: "env-grep",
      signalStrength: "soft",
      evidenceSource: "env-read",
    });
  });

  test("Glob for .env* → environment + soft", () => {
    const result = classifyVerificationSignal({
      toolName: "Glob",
      toolInput: { pattern: ".env*" },
    });
    expectSignal(result, {
      boundary: "environment",
      signalStrength: "soft",
      evidenceSource: "env-read",
    });
  });
});

// ---------------------------------------------------------------------------
// Soft signals — log reads
// ---------------------------------------------------------------------------

describe("classifyVerificationSignal — log-read soft signals", () => {
  test("Read server.log → serverHandler + soft + log-read", () => {
    const result = classifyVerificationSignal({
      toolName: "Read",
      toolInput: { file_path: "/repo/.next/server/app.log" },
    });
    expectSignal(result, {
      boundary: "serverHandler",
      matchedPattern: "log-file-read",
      signalStrength: "soft",
      evidenceSource: "log-read",
      toolName: "Read",
    });
  });

  test("Grep in log directory → serverHandler + soft", () => {
    const result = classifyVerificationSignal({
      toolName: "Grep",
      toolInput: { pattern: "ERROR", path: "/var/log/app.log" },
    });
    expectSignal(result, {
      boundary: "serverHandler",
      matchedPattern: "log-grep",
      signalStrength: "soft",
      evidenceSource: "log-read",
    });
  });

  test("Glob for *.log → serverHandler + soft", () => {
    const result = classifyVerificationSignal({
      toolName: "Glob",
      toolInput: { pattern: "**/*.log" },
    });
    expectSignal(result, {
      boundary: "serverHandler",
      signalStrength: "soft",
      evidenceSource: "log-read",
    });
  });
});

// ---------------------------------------------------------------------------
// Unsupported / null cases
// ---------------------------------------------------------------------------

describe("classifyVerificationSignal — unsupported evidence", () => {
  test("Read generic .ts file → null", () => {
    const result = classifyVerificationSignal({
      toolName: "Read",
      toolInput: { file_path: "/repo/src/index.ts" },
    });
    expect(result).toBeNull();
  });

  test("Edit → null (mutations, not observations)", () => {
    const result = classifyVerificationSignal({
      toolName: "Edit",
      toolInput: { file_path: "/repo/src/page.tsx" },
    });
    expect(result).toBeNull();
  });

  test("Write → null (mutations, not observations)", () => {
    const result = classifyVerificationSignal({
      toolName: "Write",
      toolInput: { file_path: "/repo/src/page.tsx" },
    });
    expect(result).toBeNull();
  });

  test("Unknown tool → null", () => {
    const result = classifyVerificationSignal({
      toolName: "SomeFutureTool",
      toolInput: { data: "test" },
    });
    expect(result).toBeNull();
  });

  test("Grep in generic path → null", () => {
    const result = classifyVerificationSignal({
      toolName: "Grep",
      toolInput: { pattern: "foo", path: "/repo/src" },
    });
    expect(result).toBeNull();
  });

  test("Glob for *.ts → null", () => {
    const result = classifyVerificationSignal({
      toolName: "Glob",
      toolInput: { pattern: "**/*.ts" },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("classifyVerificationSignal — determinism", () => {
  test("same input always produces same output", () => {
    const input = {
      toolName: "Bash",
      toolInput: { command: "curl http://localhost:3000/dashboard" },
    };
    const r1 = classifyVerificationSignal(input);
    const r2 = classifyVerificationSignal(input);
    expect(r1).toEqual(r2);
  });

  test("same null result for same unsupported input", () => {
    const input = { toolName: "Edit", toolInput: { file_path: "/repo/x.ts" } };
    expect(classifyVerificationSignal(input)).toBeNull();
    expect(classifyVerificationSignal(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expected outputs from task spec
// ---------------------------------------------------------------------------

describe("classifyVerificationSignal — spec examples", () => {
  test("curl http://localhost:3000/dashboard → spec output", () => {
    const result = classifyVerificationSignal({
      toolName: "Bash",
      toolInput: { command: "curl http://localhost:3000/dashboard" },
    });
    expect(result).toEqual({
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/dashboard",
      signalStrength: "strong",
      evidenceSource: "bash",
      summary: "curl http://localhost:3000/dashboard",
      toolName: "Bash",
    });
  });

  test("Read .env.local → spec output", () => {
    const result = classifyVerificationSignal({
      toolName: "Read",
      toolInput: { file_path: "/repo/.env.local" },
    });
    expect(result).toEqual({
      boundary: "environment",
      matchedPattern: "env-file-read",
      inferredRoute: null,
      signalStrength: "soft",
      evidenceSource: "env-read",
      summary: "/repo/.env.local",
      toolName: "Read",
    });
  });
});
