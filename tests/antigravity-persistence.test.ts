import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { getAntigravityEnvPath, loadAntigravityEnv, saveAntigravityEnv } from "../hooks/src/antigravity-env.mts";

describe("Antigravity Persistence", () => {
  const envPath = getAntigravityEnvPath();

  afterEach(() => {
    if (existsSync(envPath)) {
      unlinkSync(envPath);
    }
  });

  test("saveAntigravityEnv writes to the persistence file", () => {
    process.env.ANTIGRAVITY_AGENT = "1";
    saveAntigravityEnv("TEST_KEY", "test-value");

    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain('export TEST_KEY="test-value"');
  });

  test("loadAntigravityEnv populates process.env from file", () => {
    process.env.ANTIGRAVITY_AGENT = "1";
    saveAntigravityEnv("LOAD_TEST", "verified");

    const mockEnv: NodeJS.ProcessEnv = { ANTIGRAVITY_AGENT: "1" };
    loadAntigravityEnv(mockEnv);

    expect(mockEnv.LOAD_TEST).toBe("verified");
  });

  test("handles empty values correctly", () => {
    process.env.ANTIGRAVITY_AGENT = "1";
    saveAntigravityEnv("EMPTY_KEY", "");

    const mockEnv: NodeJS.ProcessEnv = { ANTIGRAVITY_AGENT: "1" };
    loadAntigravityEnv(mockEnv);

    expect(mockEnv.EMPTY_KEY).toBe("");
  });

  test("escapes sensitive shell characters", () => {
    process.env.ANTIGRAVITY_AGENT = "1";
    saveAntigravityEnv("SAFE_KEY", 'value"with$`quotes');

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain('export SAFE_KEY="value\\"with\\$\\`quotes"');

    const mockEnv: NodeJS.ProcessEnv = { ANTIGRAVITY_AGENT: "1" };
    loadAntigravityEnv(mockEnv);
    expect(mockEnv.SAFE_KEY).toBe('value"with$`quotes');
  });

  test("does nothing if ANTIGRAVITY_AGENT is not 1", () => {
    delete process.env.ANTIGRAVITY_AGENT;
    saveAntigravityEnv("NO_OP", "should-not-save");
    expect(existsSync(envPath)).toBe(false);
  });
});
