import { describe, test, expect } from "bun:test";
import { parseSeenSkills, appendSeenSkill } from "../hooks/patterns.mjs";

describe("parseSeenSkills", () => {
  test("parses comma-delimited string into a Set", () => {
    const parsed = parseSeenSkills("nextjs,ai-sdk,workflow");
    expect([...parsed]).toEqual(["nextjs", "ai-sdk", "workflow"]);
  });

  test("handles empty string", () => {
    expect([...parseSeenSkills("")]).toEqual([]);
  });

  test("handles whitespace-only", () => {
    expect([...parseSeenSkills("   ")]).toEqual([]);
  });

  test("handles undefined/non-string", () => {
    expect([...parseSeenSkills(undefined)]).toEqual([]);
  });

  test("trims whitespace around skills", () => {
    const parsed = parseSeenSkills(" nextjs , ai-sdk , workflow ");
    expect([...parsed]).toEqual(["nextjs", "ai-sdk", "workflow"]);
  });

  test("deduplicates skills", () => {
    const parsed = parseSeenSkills("nextjs,ai-sdk,nextjs");
    expect([...parsed]).toEqual(["nextjs", "ai-sdk"]);
  });

  test("skips empty segments from trailing commas", () => {
    const parsed = parseSeenSkills("nextjs,,ai-sdk,");
    expect([...parsed]).toEqual(["nextjs", "ai-sdk"]);
  });
});

describe("appendSeenSkill", () => {
  test("appends to empty string", () => {
    expect(appendSeenSkill("", "nextjs")).toBe("nextjs");
  });

  test("appends with comma to existing", () => {
    expect(appendSeenSkill("nextjs", "ai-sdk")).toBe("nextjs,ai-sdk");
  });

  test("appends to multi-skill string", () => {
    expect(appendSeenSkill("nextjs,ai-sdk", "workflow")).toBe("nextjs,ai-sdk,workflow");
  });

  test("no-ops for blank skill", () => {
    expect(appendSeenSkill("nextjs", "")).toBe("nextjs");
    expect(appendSeenSkill("nextjs", "   ")).toBe("nextjs");
  });

  test("handles undefined envValue", () => {
    expect(appendSeenSkill(undefined, "nextjs")).toBe("nextjs");
  });
});
