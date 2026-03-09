import { describe, test, expect, beforeEach } from "bun:test";
import {
  normalizePromptText,
  compilePromptSignals,
  matchPromptWithReason,
} from "../hooks/prompt-patterns.mjs";
import type { CompiledPromptSignals } from "../hooks/prompt-patterns.mjs";
import {
  selectInvestigationCompanion,
  INVESTIGATION_COMPANION_SKILLS,
} from "../hooks/user-prompt-submit-skill-inject.mjs";

// ---------------------------------------------------------------------------
// normalizePromptText
// ---------------------------------------------------------------------------

describe("normalizePromptText", () => {
  test("lowercases and trims", () => {
    expect(normalizePromptText("  Hello World  ")).toBe("hello world");
  });

  test("collapses multiple whitespace to single space", () => {
    expect(normalizePromptText("a   b\t\tc\n\nd")).toBe("a b c d");
  });

  test("returns empty string for non-string input", () => {
    // @ts-expect-error - testing runtime behavior
    expect(normalizePromptText(undefined)).toBe("");
    // @ts-expect-error
    expect(normalizePromptText(null)).toBe("");
    // @ts-expect-error
    expect(normalizePromptText(42)).toBe("");
  });

  test("returns empty string for empty/whitespace-only input", () => {
    expect(normalizePromptText("")).toBe("");
    expect(normalizePromptText("   ")).toBe("");
    expect(normalizePromptText("\t\n")).toBe("");
  });

  test("preserves non-ASCII characters", () => {
    expect(normalizePromptText("Ünïcödé Têxt")).toBe("ünïcödé têxt");
  });

  test("expands common contractions", () => {
    expect(normalizePromptText("it's stuck")).toBe("it is stuck");
    expect(normalizePromptText("don't do that")).toBe("do not do that");
    expect(normalizePromptText("can't find it")).toBe("cannot find it");
    expect(normalizePromptText("won't work")).toBe("will not work");
    expect(normalizePromptText("what's wrong")).toBe("what is wrong");
    expect(normalizePromptText("where's the log")).toBe("where is the log");
  });

  test("normalizes smart/curly apostrophes before expanding", () => {
    // \u2019 = right single quotation mark (smart apostrophe)
    expect(normalizePromptText("it\u2019s broken")).toBe("it is broken");
    // \u2018 = left single quotation mark
    expect(normalizePromptText("it\u2018s weird")).toBe("it is weird");
  });
});

// ---------------------------------------------------------------------------
// compilePromptSignals
// ---------------------------------------------------------------------------

describe("compilePromptSignals", () => {
  test("lowercases all signal terms", () => {
    const compiled = compilePromptSignals({
      phrases: ["AI Elements", "AI SDK"],
      allOf: [["Markdown", "Streamed"]],
      anyOf: ["React", "Vue"],
      noneOf: ["README"],
      minScore: 6,
    });
    expect(compiled.phrases).toEqual(["ai elements", "ai sdk"]);
    expect(compiled.allOf).toEqual([["markdown", "streamed"]]);
    expect(compiled.anyOf).toEqual(["react", "vue"]);
    expect(compiled.noneOf).toEqual(["readme"]);
  });

  test("defaults missing arrays to empty", () => {
    const compiled = compilePromptSignals({} as any);
    expect(compiled.phrases).toEqual([]);
    expect(compiled.allOf).toEqual([]);
    expect(compiled.anyOf).toEqual([]);
    expect(compiled.noneOf).toEqual([]);
  });

  test("defaults minScore to 6 when missing or NaN", () => {
    expect(compilePromptSignals({} as any).minScore).toBe(6);
    expect(
      compilePromptSignals({ minScore: NaN } as any).minScore,
    ).toBe(6);
  });

  test("preserves explicit minScore", () => {
    expect(
      compilePromptSignals({ minScore: 10 } as any).minScore,
    ).toBe(10);
    expect(
      compilePromptSignals({ minScore: 0 } as any).minScore,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchPromptWithReason — phrase matching
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — phrases", () => {
  const compiled: CompiledPromptSignals = {
    phrases: ["streaming markdown", "ai elements"],
    allOf: [],
    anyOf: [],
    noneOf: [],
    minScore: 6,
  };

  test("single phrase hit scores +6 and matches", () => {
    const result = matchPromptWithReason(
      "add ai elements to the chat component",
      compiled,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBe(6);
    expect(result.reason).toContain('phrase "ai elements" +6');
  });

  test("two phrase hits score +12", () => {
    const result = matchPromptWithReason(
      "use ai elements for streaming markdown in the chat",
      compiled,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBe(12);
  });

  test("anyOf alone can match when score reaches minScore (no phrase needed)", () => {
    const withAnyOf: CompiledPromptSignals = {
      ...compiled,
      anyOf: ["render", "component", "text", "chat", "ui", "display", "format"],
      minScore: 2,
    };
    const result = matchPromptWithReason(
      "render the component text in the chat ui display format",
      withAnyOf,
    );
    // anyOf capped at +2 meets minScore 2 — phrase hit no longer required
    expect(result.matched).toBe(true);
    expect(result.score).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// matchPromptWithReason — allOf conjunction scoring
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — allOf", () => {
  const compiled: CompiledPromptSignals = {
    phrases: ["ai elements"],
    allOf: [
      ["markdown", "streamed", "text"],
      ["terminal", "markdown", "rendering"],
    ],
    anyOf: [],
    noneOf: [],
    minScore: 6,
  };

  test("+4 when all terms in a group match", () => {
    const result = matchPromptWithReason(
      "use ai elements for markdown streamed text output",
      compiled,
    );
    expect(result.matched).toBe(true);
    // phrase(6) + allOf group1(4) = 10
    expect(result.score).toBe(10);
    expect(result.reason).toContain("allOf");
  });

  test("no score when only partial group matches", () => {
    // group1 needs "markdown" + "streamed" + "text" — "streamed" absent here
    const result = matchPromptWithReason(
      "use ai elements with markdown and some plain content",
      compiled,
    );
    // phrase(6) only, no allOf bonus
    expect(result.score).toBe(6);
  });

  test("partial group does not score when a term is truly absent", () => {
    const result = matchPromptWithReason(
      "use ai elements with markdown output",
      compiled,
    );
    // phrase(6), group1 needs "streamed" and "text" — "text" absent, "streamed" absent
    // group2 needs "terminal" — absent
    expect(result.score).toBe(6);
  });

  test("both allOf groups can score independently", () => {
    const result = matchPromptWithReason(
      "use ai elements for markdown streamed text in terminal rendering",
      compiled,
    );
    // phrase(6) + group1(4) + group2(4) = 14
    expect(result.matched).toBe(true);
    expect(result.score).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// matchPromptWithReason — anyOf capping
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — anyOf capping", () => {
  const compiled: CompiledPromptSignals = {
    phrases: ["ai elements"],
    allOf: [],
    anyOf: ["react", "component", "render", "display", "chat"],
    noneOf: [],
    minScore: 6,
  };

  test("anyOf +1 per hit, capped at +2 total", () => {
    const result = matchPromptWithReason(
      "ai elements react component render display chat",
      compiled,
    );
    // phrase(6) + anyOf capped at 2 = 8
    expect(result.score).toBe(8);
  });

  test("single anyOf hit gives +1", () => {
    const result = matchPromptWithReason(
      "use ai elements with react",
      compiled,
    );
    // phrase(6) + anyOf(1) = 7
    expect(result.score).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// matchPromptWithReason — noneOf suppression
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — noneOf", () => {
  const compiled: CompiledPromptSignals = {
    phrases: ["ai elements"],
    allOf: [],
    anyOf: [],
    noneOf: ["readme", "markdown file"],
    minScore: 6,
  };

  test("noneOf term suppresses match entirely", () => {
    const result = matchPromptWithReason(
      "use ai elements to render the readme",
      compiled,
    );
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
    expect(result.reason).toContain("suppressed by noneOf");
  });

  test("multi-word noneOf term matches as substring", () => {
    const result = matchPromptWithReason(
      "use ai elements instead of editing the markdown file",
      compiled,
    );
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });

  test("no suppression when noneOf terms are absent", () => {
    const result = matchPromptWithReason(
      "use ai elements for streaming markdown in chat",
      compiled,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBe(6);
  });

  test("noneOf uses word boundaries — partial word does not suppress", () => {
    // "readme" should not suppress "readmeGenerator" or similar
    const signals: CompiledPromptSignals = {
      phrases: ["ai elements"],
      allOf: [],
      anyOf: [],
      noneOf: ["jest"],
      minScore: 6,
    };
    // "jesting" contains "jest" as substring but not as whole word
    const result = matchPromptWithReason(
      "i am not jesting, use ai elements now",
      signals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBe(6);
  });

  test("noneOf still suppresses when term appears as whole word", () => {
    const signals: CompiledPromptSignals = {
      phrases: ["ai elements"],
      allOf: [],
      anyOf: [],
      noneOf: ["jest"],
      minScore: 6,
    };
    const result = matchPromptWithReason(
      "configure jest for ai elements testing",
      signals,
    );
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
    expect(result.reason).toContain("suppressed by noneOf");
  });

  test("noneOf word boundary works at start and end of prompt", () => {
    const signals: CompiledPromptSignals = {
      phrases: ["ai elements"],
      allOf: [],
      anyOf: [],
      noneOf: ["jest"],
      minScore: 6,
    };
    // Term at start
    const r1 = matchPromptWithReason("jest config for ai elements", signals);
    expect(r1.matched).toBe(false);
    expect(r1.score).toBe(-Infinity);
    // Term at end
    const r2 = matchPromptWithReason("ai elements with jest", signals);
    expect(r2.matched).toBe(false);
    expect(r2.score).toBe(-Infinity);
  });
});

// ---------------------------------------------------------------------------
// matchPromptWithReason — threshold boundary cases
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — threshold boundaries", () => {
  test("score exactly at minScore matches (with phrase hit)", () => {
    const compiled: CompiledPromptSignals = {
      phrases: ["ai elements"],
      allOf: [],
      anyOf: [],
      noneOf: [],
      minScore: 6,
    };
    const result = matchPromptWithReason(
      "use ai elements here",
      compiled,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBe(6);
  });

  test("score one below minScore does not match", () => {
    const compiled: CompiledPromptSignals = {
      phrases: ["ai elements"],
      allOf: [],
      anyOf: [],
      noneOf: [],
      minScore: 7,
    };
    const result = matchPromptWithReason(
      "use ai elements here",
      compiled,
    );
    expect(result.matched).toBe(false);
    expect(result.score).toBe(6);
    expect(result.reason).toContain("score 6 < 7");
  });

  test("allOf alone can match when score reaches minScore (no phrase needed)", () => {
    const compiled: CompiledPromptSignals = {
      phrases: ["nonexistent-term"],
      allOf: [["markdown", "render"], ["text", "chat"]],
      anyOf: [],
      noneOf: [],
      minScore: 4,
    };
    const result = matchPromptWithReason(
      "render markdown text in chat",
      compiled,
    );
    // 2 allOf groups × 4 = 8 ≥ minScore 4 — phrase hit no longer required
    expect(result.matched).toBe(true);
    expect(result.score).toBe(8);
  });

  test("empty prompt returns early with score 0", () => {
    const compiled: CompiledPromptSignals = {
      phrases: ["anything"],
      allOf: [],
      anyOf: [],
      noneOf: [],
      minScore: 6,
    };
    const result = matchPromptWithReason("", compiled);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reason).toBe("empty prompt");
  });

  test("minScore of 0 matches with any signal hit (no phrase needed)", () => {
    const compiled: CompiledPromptSignals = {
      phrases: ["xyzzy"],
      allOf: [],
      anyOf: ["foo"],
      noneOf: [],
      minScore: 0,
    };
    // anyOf alone reaches minScore 0 — phrase hit no longer required
    const result = matchPromptWithReason("foo bar baz", compiled);
    expect(result.matched).toBe(true);
    expect(result.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Real-world scenario: ai-elements noneOf suppression
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — real-world ai-elements signals", () => {
  // These mirror the actual ai-elements SKILL.md promptSignals
  const aiElementsSignals: CompiledPromptSignals = compilePromptSignals({
    phrases: ["streaming markdown", "markdown formatting", "ai elements", "streaming ui", "chat components", "chat ui", "chat interface", "streaming response"],
    allOf: [["markdown", "stream"], ["markdown", "render"], ["chat", "ui"], ["chat", "interface"], ["stream", "response"], ["ai", "component"]],
    anyOf: ["terminal", "chat ui", "react-markdown", "useChat", "streamText"],
    noneOf: ["readme", "markdown file", "changelog"],
    minScore: 6,
  });

  test("'write a readme in markdown' does NOT match (noneOf suppression)", () => {
    const result = matchPromptWithReason(
      "write a readme in markdown",
      aiElementsSignals,
    );
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
    expect(result.reason).toContain("suppressed by noneOf");
  });

  test("'add markdown formatting to the streamed text results' DOES match", () => {
    const result = matchPromptWithReason(
      "Also, let's add markdown formatting to the streamed text results",
      aiElementsSignals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'update the changelog with markdown' does NOT match (noneOf)", () => {
    const result = matchPromptWithReason(
      "update the changelog with markdown",
      aiElementsSignals,
    );
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });

  test("'create a markdown file for docs' does NOT match (noneOf)", () => {
    const result = matchPromptWithReason(
      "create a markdown file for the project docs",
      aiElementsSignals,
    );
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });

  test("'build a chat ui with streaming' matches via allOf [chat, ui] + phrase", () => {
    const result = matchPromptWithReason(
      "build a chat ui with streaming",
      aiElementsSignals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("anyOf alone (e.g. 'terminal') does NOT meet threshold when score too low", () => {
    const result = matchPromptWithReason(
      "open a terminal and run the build command",
      aiElementsSignals,
    );
    expect(result.matched).toBe(false);
    expect(result.reason).toContain("below threshold");
  });
});

// ---------------------------------------------------------------------------
// Import-pattern co-firing: ai-elements patterns cover AI SDK imports
// ---------------------------------------------------------------------------

describe("import-pattern co-firing — ai-elements covers AI SDK imports", () => {
  let importPatternToRegex: (pattern: string) => RegExp;
  let matchImportWithReason: any;

  const aiElementsImportPatterns = ["ai", "@ai-sdk/*", "@ai-sdk/react", "@/components/ai-elements/*"];
  const aiSdkImportPatterns = ["ai", "@ai-sdk/*"];

  beforeEach(async () => {
    const mod = await import("../hooks/patterns.mjs");
    importPatternToRegex = mod.importPatternToRegex;
    matchImportWithReason = mod.matchImportWithReason;
  });

  function compilePatterns(patterns: string[]) {
    return patterns.map((p: string) => ({ pattern: p, regex: importPatternToRegex(p) }));
  }

  test("import from 'ai' triggers both ai-sdk and ai-elements", () => {
    const content = `import { streamText } from 'ai';\n`;
    const aiElemResult = matchImportWithReason(content, compilePatterns(aiElementsImportPatterns));
    const aiSdkResult = matchImportWithReason(content, compilePatterns(aiSdkImportPatterns));
    expect(aiElemResult).not.toBeNull();
    expect(aiSdkResult).not.toBeNull();
  });

  test("import from '@ai-sdk/openai' triggers both ai-sdk and ai-elements", () => {
    const content = `import { openai } from '@ai-sdk/openai';\n`;
    const aiElemResult = matchImportWithReason(content, compilePatterns(aiElementsImportPatterns));
    const aiSdkResult = matchImportWithReason(content, compilePatterns(aiSdkImportPatterns));
    expect(aiElemResult).not.toBeNull();
    expect(aiSdkResult).not.toBeNull();
  });

  test("import from '@ai-sdk/react' triggers both ai-sdk and ai-elements", () => {
    const content = `import { useChat } from '@ai-sdk/react';\n`;
    const aiElemResult = matchImportWithReason(content, compilePatterns(aiElementsImportPatterns));
    const aiSdkResult = matchImportWithReason(content, compilePatterns(aiSdkImportPatterns));
    expect(aiElemResult).not.toBeNull();
    expect(aiSdkResult).not.toBeNull();
  });

  test("import from '@ai-sdk/anthropic' triggers both via wildcard", () => {
    const content = `import { anthropic } from '@ai-sdk/anthropic';\n`;
    const aiElemResult = matchImportWithReason(content, compilePatterns(aiElementsImportPatterns));
    const aiSdkResult = matchImportWithReason(content, compilePatterns(aiSdkImportPatterns));
    expect(aiElemResult).not.toBeNull();
    expect(aiSdkResult).not.toBeNull();
  });

  test("require('ai') also triggers both", () => {
    const content = `const { generateText } = require('ai');\n`;
    const aiElemResult = matchImportWithReason(content, compilePatterns(aiElementsImportPatterns));
    const aiSdkResult = matchImportWithReason(content, compilePatterns(aiSdkImportPatterns));
    expect(aiElemResult).not.toBeNull();
    expect(aiSdkResult).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real-world scenario: investigation-mode frustration signals
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — investigation-mode frustration signals", () => {
  const investigationSignals: CompiledPromptSignals = compilePromptSignals({
    phrases: [
      "nothing happened", "still waiting",
      "it's stuck", "it's hung", "nothing is happening", "not responding",
      "just sitting there", "just sits there", "seems frozen", "is it frozen",
      "frozen", "why is it hanging",
      "check the logs", "check logs", "where are the logs",
      "how do I debug", "how to debug", "white screen", "blank page",
      "spinning forever", "timed out", "keeps timing out", "no response",
      "no output", "not loading", "debug this", "investigate why",
      "what went wrong", "why did it fail", "why is it failing",
      "something is broken", "something broke", "seems broken",
      "check what happened", "check the status",
      "where is the error", "where did it fail", "find the error",
      "show me the error", "why is it slow",
      "taking forever", "still loading", "not finishing", "seems dead",
      "been waiting", "waiting forever", "stuck on", "hung up",
      "not progressing", "stalled out", "is it running", "did it crash",
      "keeps failing", "why no response", "where did it go", "lost connection",
      "never finishes", "pending forever", "queue stuck", "job stuck",
      "build stuck", "request hanging", "api not responding",
    ],
    allOf: [
      ["stuck", "workflow"], ["stuck", "deploy"], ["stuck", "loading"],
      ["stuck", "build"], ["stuck", "queue"], ["stuck", "job"],
      ["hung", "request"], ["hung", "api"], ["frozen", "page"], ["frozen", "app"],
      ["check", "why"], ["check", "broken"], ["check", "error"],
      ["check", "status"], ["check", "logs"],
      ["debug", "workflow"], ["debug", "deploy"], ["debug", "api"],
      ["debug", "issue"], ["investigate", "error"],
      ["logs", "error"], ["logs", "check"], ["slow", "response"],
      ["slow", "loading"], ["timeout", "api"], ["timeout", "request"],
      ["waiting", "response"], ["waiting", "forever"], ["waiting", "deploy"],
      ["not working", "why"], ["not", "responding"],
      ["hanging", "for"], ["been", "hanging"], ["been", "stuck"],
      ["been", "waiting"],
      ["why", "slow"], ["why", "failing"], ["why", "stuck"], ["why", "hanging"],
      ["job", "failing"], ["queue", "processing"],
    ],
    anyOf: [
      "stuck", "hung", "frozen", "broken", "failing", "timeout",
      "slow", "debug", "investigate", "check", "logs", "error",
      "hanging", "waiting", "stalled", "pending", "processing",
      "loading", "unresponsive",
    ],
    noneOf: [
      "css stuck", "sticky position", "position: sticky", "z-index",
      "sticky nav", "sticky header", "sticky footer", "overflow: hidden",
      "add a button", "create a button", "style the button",
    ],
    minScore: 4,
  });

  test("'it's stuck' phrase hit matches (contraction expanded)", () => {
    const result = matchPromptWithReason(
      normalizePromptText("it's stuck and I don't know what to do"),
      investigationSignals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("'nothing is happening' phrase hit matches", () => {
    const result = matchPromptWithReason("nothing is happening after I deployed", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'check the logs' phrase hit matches", () => {
    const result = matchPromptWithReason("can you check the logs for errors", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'white screen' phrase hit matches", () => {
    const result = matchPromptWithReason("I'm getting a white screen after deploying", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'spinning forever' phrase hit matches", () => {
    const result = matchPromptWithReason("the page is spinning forever", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'why did it fail' phrase hit matches", () => {
    const result = matchPromptWithReason("why did it fail after I pushed", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("allOf [stuck, deploy] boosts score on top of phrase hit", () => {
    // "it's stuck" → "it is stuck" phrase hit (+6), and [stuck, deploy] allOf adds +4
    const result = matchPromptWithReason(
      normalizePromptText("it's stuck, the deploy won't finish"),
      investigationSignals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("allOf [debug, api] boosts score on top of phrase hit", () => {
    // "debug this" is a phrase hit (+6), and [debug, api] allOf adds +4
    const result = matchPromptWithReason("debug this api endpoint please", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("allOf [logs, error] boosts score on top of phrase hit", () => {
    // "check the logs" is a phrase hit (+6), and [logs, error] allOf adds +4
    const result = matchPromptWithReason("check the logs for the error message", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("allOf [slow, response] boosts score on top of phrase hit", () => {
    // "why is it slow" is a phrase hit (+6), and [slow, response] allOf adds +4
    const result = matchPromptWithReason("why is it slow, the response takes forever", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("noneOf suppresses CSS-related 'sticky' false positives", () => {
    const result = matchPromptWithReason("the sticky position isn't working with z-index", investigationSignals);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
    expect(result.reason).toContain("suppressed by noneOf");
  });

  test("noneOf suppresses 'sticky header' false positive", () => {
    const result = matchPromptWithReason("make the sticky header stay at top", investigationSignals);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });

  test("'why is my app just sitting there' scores >=4 (acceptance criteria)", () => {
    const result = matchPromptWithReason("why is my app just sitting there", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("'nothing happened' phrase hit matches", () => {
    const result = matchPromptWithReason("nothing happened after I clicked deploy", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'still waiting' phrase hit matches", () => {
    const result = matchPromptWithReason("still waiting for the build to finish", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'no output' phrase hit matches", () => {
    const result = matchPromptWithReason("there is no output from the function", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'show me the error' phrase hit matches", () => {
    const result = matchPromptWithReason("show me the error from the last deploy", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'where did it fail' phrase hit matches", () => {
    const result = matchPromptWithReason("where did it fail in the pipeline", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("allOf [check, logs] matches", () => {
    const result = matchPromptWithReason("can you check the server logs", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("allOf [debug, issue] matches", () => {
    const result = matchPromptWithReason("help me debug this issue", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("allOf [investigate, error] matches", () => {
    const result = matchPromptWithReason("investigate this error in production", investigationSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("noneOf suppresses 'add a button' false positive", () => {
    const result = matchPromptWithReason("add a button to the page", investigationSignals);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });

  test("generic 'why' alone does not match (score too low)", () => {
    const result = matchPromptWithReason("why did you choose React for this", investigationSignals);
    expect(result.matched).toBe(false);
    expect(result.reason).toContain("below threshold");
  });

  // --- acceptance criteria: natural language triggers without exact phrase hits ---

  test("'my workflow is stuck' triggers via allOf [stuck, workflow] without phrase hit", () => {
    const result = matchPromptWithReason(
      normalizePromptText("my workflow is stuck"),
      investigationSignals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.reason).toContain("allOf");
  });

  test("'it's been hanging for 5 minutes' triggers via contraction expansion + allOf", () => {
    const result = matchPromptWithReason(
      normalizePromptText("it's been hanging for 5 minutes"),
      investigationSignals,
    );
    // "it's" → "it is", then allOf [hanging, for] +4 and [been, hanging] +4, anyOf "hanging" +1
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("'why is this so slow' triggers via allOf [why, slow] + anyOf", () => {
    const result = matchPromptWithReason(
      normalizePromptText("why is this so slow"),
      investigationSignals,
    );
    // allOf [why, slow] +4, anyOf "slow" +1 = 5 ≥ 4
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("contraction 'it\u2019s stuck' (smart quote) normalizes and matches", () => {
    const result = matchPromptWithReason(
      normalizePromptText("it\u2019s stuck and nothing works"),
      investigationSignals,
    );
    // Smart apostrophe normalized → "it is stuck" matches phrase "it is stuck"
    expect(result.matched).toBe(true);
  });

  test("'don't know why it isn't working' expands contractions before matching", () => {
    const normalized = normalizePromptText("don't know why it isn't working");
    // "don't" → "do not", "isn't" → "is not"
    expect(normalized).toBe("do not know why it is not working");
  });
});

// ---------------------------------------------------------------------------
// Real-world scenario: observability prompt signals
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — observability signals", () => {
  const observabilitySignals: CompiledPromptSignals = compilePromptSignals({
    phrases: [
      "add logging", "add logs", "set up logging", "setup logging",
      "configure logging", "structured logging", "log drain", "log drains",
      "vercel analytics", "speed insights", "web analytics",
      "opentelemetry", "otel", "instrumentation", "monitoring",
      "set up monitoring", "add observability", "track errors",
      "error tracking", "sentry", "datadog",
      "check the logs", "show me the error", "what went wrong",
      "where did it fail", "show me the logs", "find the error",
      "why did it fail", "debug the error",
    ],
    allOf: [
      ["add", "logging"], ["add", "monitoring"], ["set up", "logs"],
      ["configure", "analytics"], ["vercel", "logs"], ["vercel", "analytics"],
      ["track", "performance"], ["track", "errors"],
    ],
    anyOf: [
      "logging", "monitoring", "analytics", "observability",
      "telemetry", "traces", "metrics",
    ],
    minScore: 6,
  });

  test("'add logging' phrase hit matches", () => {
    const result = matchPromptWithReason("I need to add logging to the API routes", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'opentelemetry' phrase hit matches", () => {
    const result = matchPromptWithReason("set up opentelemetry for tracing", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'sentry' phrase hit matches", () => {
    const result = matchPromptWithReason("integrate sentry for error tracking", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'set up monitoring' phrase hit matches", () => {
    const result = matchPromptWithReason("I want to set up monitoring for my app", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'vercel analytics' phrase hit matches", () => {
    const result = matchPromptWithReason("how do I add vercel analytics", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("allOf [track, errors] boosts score on top of phrase hit", () => {
    // "track errors" is a phrase hit (+6), and [track, errors] allOf adds +4
    const result = matchPromptWithReason("I need to track errors in production", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("'check the logs' debugCheck phrase hit matches", () => {
    const result = matchPromptWithReason("can you check the logs for this error", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'show me the error' debugCheck phrase hit matches", () => {
    const result = matchPromptWithReason("show me the error from the last deploy", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'what went wrong' debugCheck phrase hit matches", () => {
    const result = matchPromptWithReason("what went wrong with the build", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'where did it fail' debugCheck phrase hit matches", () => {
    const result = matchPromptWithReason("where did it fail in the pipeline", observabilitySignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Real-world scenario: workflow debugging signals
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — workflow debugging signals", () => {
  const workflowSignals: CompiledPromptSignals = compilePromptSignals({
    phrases: [
      "vercel workflow", "workflow devkit", "durable workflow", "durable execution",
      "workflow stuck", "workflow hung", "workflow failing", "workflow timeout",
      "workflow not running", "workflow error", "check workflow", "workflow logs",
      "workflow run status", "debug workflow", "workflow not finishing",
      "workflow run", "step failed", "run status", "run failed", "run logs",
      "workflow run failed", "workflow step failed",
    ],
    allOf: [
      ["workflow", "durable"], ["workflow", "retry"], ["workflow", "resume"],
      ["workflow", "stuck"], ["workflow", "hung"], ["workflow", "timeout"],
      ["workflow", "error"], ["workflow", "logs"], ["workflow", "debug"],
      ["workflow", "check"], ["workflow", "failing"], ["workflow", "status"],
      ["workflow", "run"], ["run", "logs"], ["step", "failed"],
    ],
    anyOf: ["long-running", "multi-step", "pipeline", "orchestration", "phase"],
    noneOf: ["github actions", ".github/workflows", "ci workflow", "aws step functions"],
    minScore: 4,
  });

  test("'workflow stuck' phrase hit matches", () => {
    const result = matchPromptWithReason("the workflow stuck on step 3", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("'debug workflow' phrase hit matches", () => {
    const result = matchPromptWithReason("I need to debug workflow execution", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("'workflow logs' phrase hit matches", () => {
    const result = matchPromptWithReason("where can I see the workflow logs", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("allOf [workflow, timeout] boosts score on top of phrase hit", () => {
    // "workflow timeout" is a phrase hit (+6), and [workflow, timeout] allOf adds +4
    const result = matchPromptWithReason("the workflow timeout keeps happening", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("noneOf suppresses GitHub Actions false positive", () => {
    const result = matchPromptWithReason("fix the github actions workflow", workflowSignals);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });

  test("noneOf suppresses CI workflow false positive", () => {
    const result = matchPromptWithReason("the ci workflow is broken", workflowSignals);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });

  test("'workflow run' workflowInvestigation phrase hit matches", () => {
    const result = matchPromptWithReason("check the workflow run for errors", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("'step failed' workflowInvestigation phrase hit matches", () => {
    const result = matchPromptWithReason("the step failed with an error", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("'run status' workflowInvestigation phrase hit matches", () => {
    const result = matchPromptWithReason("what is the run status", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("allOf [workflow, run] matches", () => {
    const result = matchPromptWithReason("the workflow run is taking too long", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("allOf [step, failed] matches", () => {
    const result = matchPromptWithReason("the processing step has failed", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  test("allOf [run, logs] matches", () => {
    const result = matchPromptWithReason("show me the run logs", workflowSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Real-world scenario: vercel-cli deployment-check signals
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — vercel-cli deployment-check signals", () => {
  const vercelCliSignals: CompiledPromptSignals = compilePromptSignals({
    phrases: [
      "check deployment", "check deploy", "deployment status", "deploy status",
      "vercel logs", "deployment logs", "deploy logs", "vercel inspect",
      "is it deployed", "deploy failing", "deploy failed", "deployment error",
      "check vercel", "vercel status",
    ],
    allOf: [
      ["check", "deployment"], ["check", "deploy"], ["vercel", "status"],
      ["vercel", "logs"], ["deploy", "error"], ["deploy", "failed"],
      ["deploy", "stuck"],
    ],
    anyOf: ["deployment", "deploy", "vercel", "production"],
    noneOf: ["terraform", "aws deploy", "heroku"],
    minScore: 6,
  });

  test("'check deployment' phrase hit matches", () => {
    const result = matchPromptWithReason("can you check deployment status", vercelCliSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'deploy failed' phrase hit matches", () => {
    const result = matchPromptWithReason("the deploy failed again", vercelCliSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'vercel logs' phrase hit matches", () => {
    const result = matchPromptWithReason("show me the vercel logs", vercelCliSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("allOf [deploy, stuck] boosts score on top of phrase hit", () => {
    // "deploy failing" is a phrase hit (+6), and [deploy, stuck] allOf adds +4
    const result = matchPromptWithReason("deploy failing, seems stuck in building", vercelCliSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("noneOf suppresses terraform false positive", () => {
    const result = matchPromptWithReason("check the terraform deployment", vercelCliSignals);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });

  test("noneOf suppresses heroku false positive", () => {
    const result = matchPromptWithReason("check heroku deployment status", vercelCliSignals);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(-Infinity);
  });
});

// ---------------------------------------------------------------------------
// Real-world scenario: agent-browser-verify page-check signals
// ---------------------------------------------------------------------------

describe("matchPromptWithReason — agent-browser-verify page-check signals", () => {
  const browserSignals: CompiledPromptSignals = compilePromptSignals({
    phrases: [
      "check the page", "check the browser", "check the site",
      "is the page working", "is it loading", "blank page", "white screen",
      "nothing showing", "page is broken", "screenshot the page",
      "take a screenshot", "check for errors", "console errors", "browser errors",
      "page won't load", "page will not load", "nothing renders", "nothing rendered",
      "ui is broken", "screen is blank", "screen is white", "app won't load",
    ],
    allOf: [
      ["check", "page"], ["check", "browser"], ["check", "site"],
      ["blank", "page"], ["white", "screen"], ["console", "errors"],
      ["page", "broken"], ["page", "loading"], ["not", "rendering"],
    ],
    anyOf: ["page", "browser", "screen", "rendering", "visual"],
    minScore: 6,
  });

  test("'check the page' phrase hit matches", () => {
    const result = matchPromptWithReason("can you check the page for me", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'blank page' phrase hit matches", () => {
    const result = matchPromptWithReason("I'm seeing a blank page after deploy", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'console errors' phrase hit matches", () => {
    const result = matchPromptWithReason("there are console errors on the page", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'take a screenshot' phrase hit matches", () => {
    const result = matchPromptWithReason("take a screenshot of the homepage", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("allOf [not, rendering] boosts score on top of phrase hit", () => {
    // "nothing showing" is a phrase hit (+6), and [not, rendering] allOf adds +4
    const result = matchPromptWithReason("nothing showing, the component is not rendering", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("allOf [page, broken] boosts score on top of phrase hit", () => {
    // "page is broken" is a phrase hit (+6), and [page, broken] allOf adds +4
    const result = matchPromptWithReason("the page is broken on mobile", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reason).toContain("allOf");
  });

  test("'page won't load' UI frustration phrase hit matches (contraction expanded)", () => {
    const result = matchPromptWithReason(
      normalizePromptText("the page won't load at all"),
      browserSignals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'nothing renders' UI frustration phrase hit matches", () => {
    const result = matchPromptWithReason("nothing renders on the screen", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'screen is blank' UI frustration phrase hit matches", () => {
    const result = matchPromptWithReason("the screen is blank after deploy", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("'ui is broken' UI frustration phrase hit matches", () => {
    const result = matchPromptWithReason("the ui is broken on the homepage", browserSignals);
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Investigation-mode companion selection
// ---------------------------------------------------------------------------

describe("selectInvestigationCompanion", () => {
  test("returns null when investigation-mode is not selected", () => {
    const result = selectInvestigationCompanion(
      ["ai-sdk", "nextjs"],
      { "ai-sdk": { score: 12, matched: true }, "nextjs": { score: 10, matched: true } },
    );
    expect(result.companion).toBeNull();
    expect(result.reason).toContain("not selected");
  });

  test("returns null when no companion scored high enough", () => {
    const result = selectInvestigationCompanion(
      ["investigation-mode"],
      {
        "investigation-mode": { score: 10, matched: true },
        "workflow": { score: 3, matched: false },
        "agent-browser-verify": { score: 2, matched: false },
        "vercel-cli": { score: 0, matched: false },
      },
    );
    expect(result.companion).toBeNull();
    expect(result.reason).toContain("no companion");
  });

  test("selects workflow when it scored highest among companions", () => {
    const result = selectInvestigationCompanion(
      ["investigation-mode", "workflow"],
      {
        "investigation-mode": { score: 14, matched: true },
        "workflow": { score: 12, matched: true },
        "agent-browser-verify": { score: 4, matched: false },
        "vercel-cli": { score: 2, matched: false },
      },
    );
    expect(result.companion).toBe("workflow");
  });

  test("selects agent-browser-verify when it scored highest among companions", () => {
    const result = selectInvestigationCompanion(
      ["investigation-mode"],
      {
        "investigation-mode": { score: 10, matched: true },
        "workflow": { score: 3, matched: false },
        "agent-browser-verify": { score: 8, matched: true },
        "vercel-cli": { score: 4, matched: false },
      },
    );
    expect(result.companion).toBe("agent-browser-verify");
  });

  test("selects vercel-cli when it is the only matched companion", () => {
    const result = selectInvestigationCompanion(
      ["investigation-mode"],
      {
        "investigation-mode": { score: 10, matched: true },
        "workflow": { score: 3, matched: false },
        "agent-browser-verify": { score: 2, matched: false },
        "vercel-cli": { score: 8, matched: true },
      },
    );
    expect(result.companion).toBe("vercel-cli");
  });

  test("prefers higher-scoring companion over priority order", () => {
    // agent-browser-verify scores higher than workflow → picked despite lower priority order
    const result = selectInvestigationCompanion(
      ["investigation-mode"],
      {
        "investigation-mode": { score: 14, matched: true },
        "workflow": { score: 6, matched: true },
        "agent-browser-verify": { score: 12, matched: true },
        "vercel-cli": { score: 4, matched: true },
      },
    );
    expect(result.companion).toBe("agent-browser-verify");
  });

  test("companion skills constant has expected members", () => {
    expect(INVESTIGATION_COMPANION_SKILLS).toContain("workflow");
    expect(INVESTIGATION_COMPANION_SKILLS).toContain("agent-browser-verify");
    expect(INVESTIGATION_COMPANION_SKILLS).toContain("vercel-cli");
    expect(INVESTIGATION_COMPANION_SKILLS).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Perf smoke: 40-skill fixture matching completes in <50ms
// ---------------------------------------------------------------------------

describe("perf smoke", () => {
  test("matching against 40-skill fixture completes in <50ms", () => {
    // Build 40 compiled skill signal sets
    const skills: CompiledPromptSignals[] = [];
    for (let i = 0; i < 40; i++) {
      skills.push({
        phrases: [`skill${i}`, `phrase${i}-a`, `phrase${i}-b`],
        allOf: [
          [`term${i}-a`, `term${i}-b`, `term${i}-c`],
          [`group${i}-x`, `group${i}-y`],
        ],
        anyOf: [`any${i}-1`, `any${i}-2`, `any${i}-3`],
        noneOf: [`block${i}`],
        minScore: 6,
      });
    }

    const prompt = normalizePromptText(
      "I want to use skill5 and add streaming markdown to the chat. " +
      "Also add phrase12-a and term20-a term20-b term20-c for good measure.",
    );

    const start = performance.now();
    for (const compiled of skills) {
      matchPromptWithReason(prompt, compiled);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});
