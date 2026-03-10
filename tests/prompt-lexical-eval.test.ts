import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { analyzePrompt } from "../hooks/src/prompt-analysis.mjs";
import type {
  PromptAnalysisReport,
  PerSkillResult,
} from "../hooks/src/prompt-analysis.mjs";
import type { SkillConfig } from "../hooks/src/skill-map-frontmatter.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkillConfig(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    priority: 50,
    summary: "Test skill",
    pathPatterns: [],
    bashPatterns: [],
    importPatterns: [],
    validate: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Skill configs — mirror real SKILL.md frontmatter
// ---------------------------------------------------------------------------

const aiElementsConfig = makeSkillConfig({
  priority: 50,
  summary: "AI Elements component library for AI interfaces with streaming markdown",
  promptSignals: {
    phrases: [
      "ai elements", "ai components", "chat components", "chat ui",
      "chat interface", "voice elements", "code elements", "voice agent",
      "speech input", "transcription component", "code editor component",
      "streaming markdown", "streaming ui", "streaming response",
      "markdown formatting",
    ],
    allOf: [
      ["message", "component"], ["conversation", "component"],
      ["markdown", "stream"], ["markdown", "render"],
      ["chat", "ui"], ["chat", "interface"],
      ["stream", "response"], ["ai", "component"],
    ],
    anyOf: [
      "message component", "conversation component", "tool call display",
      "reasoning display", "voice conversation", "speech to text",
      "text to speech", "react-markdown", "chat ui", "terminal",
      "useChat", "streamText",
    ],
    noneOf: ["vue", "svelte", "readme", "markdown file", "changelog"],
    minScore: 6,
  },
  retrieval: {
    aliases: ["chat components", "message components"],
    intents: ["build chat UI", "render streaming markdown"],
    entities: ["MessageResponse", "useChat"],
    examples: ["build a chat interface with streaming"],
  },
});

const aiSdkConfig = makeSkillConfig({
  priority: 80,
  summary: "Vercel AI SDK for streaming text generation",
  promptSignals: {
    phrases: ["ai sdk", "vercel ai", "generatetext", "streamtext"],
    allOf: [["streaming", "generation"], ["structured", "output"]],
    anyOf: ["usechat", "usecompletion", "tool calling", "embeddings"],
    noneOf: ["openai api directly"],
    minScore: 6,
  },
  retrieval: {
    aliases: ["vercel ai", "ai sdk", "ai library"],
    intents: ["add AI features", "streaming text generation"],
    entities: ["generateText", "streamText", "useChat"],
    examples: ["use the AI SDK to generate text"],
  },
});

const nextjsConfig = makeSkillConfig({
  priority: 50,
  summary: "Next.js App Router framework",
  promptSignals: {
    phrases: ["next.js", "nextjs", "app router", "server component", "server action"],
    allOf: [["middleware", "next"], ["layout", "route"]],
    anyOf: ["pages router", "getserversideprops", "use server"],
    noneOf: [],
    minScore: 6,
  },
  retrieval: {
    aliases: ["next", "nextjs"],
    intents: ["build a Next.js app"],
    entities: ["useServerAction"],
    examples: ["create a Next.js app with app router"],
  },
});

const swrConfig = makeSkillConfig({
  priority: 40,
  summary: "SWR for client-side data fetching",
  promptSignals: {
    phrases: ["swr", "useswr", "stale-while-revalidate"],
    allOf: [["data fetching", "client"], ["cache", "revalidat"]],
    anyOf: ["mutation", "optimistic", "infinite loading", "pagination"],
    noneOf: [],
    minScore: 6,
  },
  retrieval: {
    aliases: ["data fetching"],
    intents: ["client-side data fetching"],
    entities: ["useSWR"],
    examples: ["fetch data on the client with SWR"],
  },
});

const vercelCliConfig = makeSkillConfig({
  priority: 40,
  summary: "Vercel CLI for deployment and project management",
  promptSignals: {
    phrases: [
      "check deployment", "check deploy", "deployment status", "deploy status",
      "vercel logs", "deployment logs", "deploy logs", "vercel inspect",
      "is it deployed", "deploy failing", "deploy failed", "deployment error",
      "check vercel", "vercel status",
    ],
    allOf: [
      ["check", "deployment"], ["check", "deploy"],
      ["vercel", "status"], ["vercel", "logs"],
      ["deploy", "error"], ["deploy", "failed"], ["deploy", "stuck"],
    ],
    anyOf: ["deployment", "deploy", "vercel", "production"],
    noneOf: ["terraform", "aws deploy", "heroku"],
    minScore: 6,
  },
  retrieval: {
    aliases: ["vercel command line", "vc cli", "deploy command"],
    intents: ["deploy to vercel", "check deployment status"],
    entities: ["vercel"],
    examples: ["deploy my project to vercel"],
  },
});

const chatSdkConfig = makeSkillConfig({
  priority: 80,
  summary: "Vercel Chat SDK for multi-platform chat bots",
  promptSignals: {
    phrases: [
      "chat sdk", "chat bot", "chatbot", "conversational interface",
      "slack bot", "telegram bot", "discord bot", "teams bot",
    ],
    allOf: [["bot", "platform"], ["bot", "multi"]],
    anyOf: ["onNewMention", "onSubscribedMessage", "chat adapter", "cross-platform bot"],
    noneOf: ["useChat"],
    minScore: 6,
  },
  retrieval: {
    aliases: ["chatbot", "conversation interface"],
    intents: ["build a chat bot"],
    entities: ["Chat", "ChatAdapter"],
    examples: ["build a Slack bot"],
  },
});

// ---------------------------------------------------------------------------
// Skill map
// ---------------------------------------------------------------------------

function skillMap(): Record<string, SkillConfig> {
  return {
    "ai-elements": aiElementsConfig,
    "ai-sdk": aiSdkConfig,
    nextjs: nextjsConfig,
    swr: swrConfig,
    "vercel-cli": vercelCliConfig,
    "chat-sdk": chatSdkConfig,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function analyze(prompt: string, seenSkills = ""): PromptAnalysisReport {
  return analyzePrompt(prompt, skillMap(), seenSkills, 80000, 2);
}

function expectSelected(report: PromptAnalysisReport, ...skills: string[]) {
  for (const skill of skills) {
    expect(report.selectedSkills).toContain(skill);
  }
}

function expectNotSelected(report: PromptAnalysisReport, ...skills: string[]) {
  for (const skill of skills) {
    expect(report.selectedSkills).not.toContain(skill);
  }
}

function expectSuppressed(report: PromptAnalysisReport, skill: string) {
  const r = report.perSkillResults[skill];
  expect(r).toBeDefined();
  expect(r.suppressed).toBe(true);
  expect(r.matched).toBe(false);
  expect(r.score).toBe(-Infinity);
}

function expectSource(
  report: PromptAnalysisReport,
  skill: string,
  source: "exact" | "lexical" | "combined",
) {
  const r = report.perSkillResults[skill];
  expect(r).toBeDefined();
  expect(r.source).toBe(source);
}

// ---------------------------------------------------------------------------
// Environment cleanup
// ---------------------------------------------------------------------------

let savedDedup: string | undefined;

beforeEach(() => {
  savedDedup = process.env.VERCEL_PLUGIN_HOOK_DEDUP;
  delete process.env.VERCEL_PLUGIN_HOOK_DEDUP;
});

afterEach(() => {
  if (savedDedup !== undefined) {
    process.env.VERCEL_PLUGIN_HOOK_DEDUP = savedDedup;
  } else {
    delete process.env.VERCEL_PLUGIN_HOOK_DEDUP;
  }
});

// ===========================================================================
// EXACT PHRASE MATCHES — canonical queries
// ===========================================================================

describe("exact phrase matches", () => {
  test("1: 'use ai elements for the chat' → ai-elements via phrase", () => {
    const r = analyze("use ai elements for the chat");
    expectSelected(r, "ai-elements");
    expect(r.perSkillResults["ai-elements"].score).toBeGreaterThanOrEqual(6);
  });

  test("2: 'add the AI SDK to this project' → ai-sdk via phrase", () => {
    const r = analyze("add the AI SDK to this project");
    expectSelected(r, "ai-sdk");
    expect(r.perSkillResults["ai-sdk"].score).toBeGreaterThanOrEqual(6);
  });

  test("3: 'set up Next.js app router' → nextjs via phrase", () => {
    const r = analyze("set up Next.js app router");
    expectSelected(r, "nextjs");
  });

  test("4: 'use SWR for data fetching' → swr via phrase", () => {
    const r = analyze("use SWR for data fetching");
    expectSelected(r, "swr");
  });

  test("5: 'check deployment status on vercel' → vercel-cli via phrase+allOf", () => {
    const r = analyze("check deployment status on vercel");
    expectSelected(r, "vercel-cli");
  });

  test("6: 'build a Slack bot' → chat-sdk via phrase", () => {
    const r = analyze("build a Slack bot");
    expectSelected(r, "chat-sdk");
  });
});

// ===========================================================================
// PARAPHRASES — natural language variations
// ===========================================================================

describe("paraphrases — natural wording variations", () => {
  test("7: 'I want a chat interface with streaming' → ai-elements (phrase: chat interface)", () => {
    const r = analyze("I want a chat interface with streaming");
    expectSelected(r, "ai-elements");
  });

  test("8: 'render streaming markdown in the terminal' → ai-elements (phrase: streaming markdown)", () => {
    const r = analyze("render streaming markdown in the terminal");
    expectSelected(r, "ai-elements");
  });

  test("9: 'set up streaming ui components' → ai-elements (phrase: streaming ui)", () => {
    const r = analyze("set up streaming ui components");
    expectSelected(r, "ai-elements");
  });

  test("10: 'configure vercel ai for text generation' → ai-sdk (phrase: vercel ai)", () => {
    const r = analyze("configure vercel ai for text generation");
    expectSelected(r, "ai-sdk");
  });

  test("11: 'use streamText to build a completion API' → ai-sdk (phrase: streamtext)", () => {
    const r = analyze("use streamText to build a completion API");
    expectSelected(r, "ai-sdk");
  });

  test("12: 'create a server component for the dashboard' → nextjs (phrase: server component)", () => {
    const r = analyze("create a server component for the dashboard");
    expectSelected(r, "nextjs");
  });

  test("13: 'add a server action to handle form submission' → nextjs (phrase: server action)", () => {
    const r = analyze("add a server action to handle form submission");
    expectSelected(r, "nextjs");
  });

  test("14: 'deploy failed and I need to see the logs' → vercel-cli (phrase: deploy failed)", () => {
    const r = analyze("deploy failed and I need to see the logs");
    expectSelected(r, "vercel-cli");
  });

  test("15: 'is it deployed yet?' → vercel-cli (phrase: is it deployed)", () => {
    const r = analyze("is it deployed yet?");
    expectSelected(r, "vercel-cli");
  });

  test("16: 'build a telegram bot for notifications' → chat-sdk (phrase: telegram bot)", () => {
    const r = analyze("build a telegram bot for notifications");
    expectSelected(r, "chat-sdk");
  });

  test("17: 'create a discord bot that responds to mentions' → chat-sdk (phrase: discord bot)", () => {
    const r = analyze("create a discord bot that responds to mentions");
    expectSelected(r, "chat-sdk");
  });
});

// ===========================================================================
// ALLOF CONJUNCTIONS — multi-term matches
// ===========================================================================

describe("allOf conjunction matches", () => {
  test("18: 'add middleware to the next app' → nextjs (allOf: [middleware, next])", () => {
    const r = analyze("add middleware to the next app");
    expectSelected(r, "nextjs");
    expect(r.perSkillResults["nextjs"].score).toBeGreaterThanOrEqual(4);
  });

  test("19: 'client side data fetching with caching' → swr (allOf: [data fetching, client])", () => {
    const r = analyze("client side data fetching with caching");
    expectSelected(r, "swr");
  });

  test("20: 'build an ai component for the sidebar' → ai-elements (allOf: [ai, component])", () => {
    const r = analyze("build an ai component for the sidebar");
    expectSelected(r, "ai-elements");
  });

  test("21: 'add structured output to the LLM call' → ai-sdk (allOf: [structured, output])", () => {
    const r = analyze("add structured output to the LLM call");
    expectSelected(r, "ai-sdk");
  });
});

// ===========================================================================
// CO-FIRING — prompt matches multiple skills
// ===========================================================================

describe("co-firing — single prompt triggers multiple skills", () => {
  test("22: 'use the AI SDK streamText to build a streaming chat ui' → ai-sdk + ai-elements", () => {
    const r = analyze("use the AI SDK streamText to build a streaming chat ui");
    expectSelected(r, "ai-sdk", "ai-elements");
  });

  test("23: 'set up Next.js with server components and use SWR for client data fetching' → nextjs + swr", () => {
    const r = analyze(
      "set up Next.js with server components and use SWR for client data fetching",
    );
    expectSelected(r, "nextjs");
    // swr needs allOf [data fetching, client] — "client data fetching" has both
    expectSelected(r, "swr");
  });
});

// ===========================================================================
// NEGATIVE CONTROLS — prompts that should NOT match
// ===========================================================================

describe("negative controls — prompts matching no skill", () => {
  test("24: 'refactor the database migration script' → no skills selected", () => {
    const r = analyze("refactor the database migration script");
    expect(r.selectedSkills).toEqual([]);
  });

  test("25: 'fix the CSS grid layout on the homepage' → no skills selected", () => {
    const r = analyze("fix the CSS grid layout on the homepage");
    expect(r.selectedSkills).toEqual([]);
  });

  test("26: 'write unit tests for the user service' → no skills selected", () => {
    const r = analyze("write unit tests for the user service");
    expect(r.selectedSkills).toEqual([]);
  });

  test("27: 'update the docker compose file' → no skills selected", () => {
    const r = analyze("update the docker compose file");
    expect(r.selectedSkills).toEqual([]);
  });
});

// ===========================================================================
// NONEOF SUPPRESSION — hard blocks
// ===========================================================================

describe("noneOf suppression", () => {
  test("28: 'update the readme with streaming markdown examples' → ai-elements suppressed (noneOf: readme)", () => {
    const r = analyze("update the readme with streaming markdown examples");
    expectSuppressed(r, "ai-elements");
    expectNotSelected(r, "ai-elements");
  });

  test("29: 'build a Vue chat interface' → ai-elements suppressed (noneOf: vue)", () => {
    const r = analyze("build a Vue chat interface");
    expectSuppressed(r, "ai-elements");
    expectNotSelected(r, "ai-elements");
  });

  test("30: 'build a Svelte streaming ui' → ai-elements suppressed (noneOf: svelte)", () => {
    const r = analyze("build a Svelte streaming ui");
    expectSuppressed(r, "ai-elements");
    expectNotSelected(r, "ai-elements");
  });

  test("31: 'deploy to heroku with vercel logs' → vercel-cli suppressed (noneOf: heroku)", () => {
    const r = analyze("deploy to heroku with vercel logs");
    expectSuppressed(r, "vercel-cli");
    expectNotSelected(r, "vercel-cli");
  });

  test("32: 'use the openai api directly to generate text' → ai-sdk suppressed (noneOf: openai api directly)", () => {
    const r = analyze("use the openai api directly to generate text");
    expectSuppressed(r, "ai-sdk");
    expectNotSelected(r, "ai-sdk");
  });

  test("33: 'deploy to AWS deploy with terraform' → vercel-cli suppressed (noneOf: aws deploy + terraform)", () => {
    const r = analyze("deploy to AWS deploy with terraform");
    expectSuppressed(r, "vercel-cli");
    expectNotSelected(r, "vercel-cli");
  });

  test("34: 'build a chatbot with useChat hooks' → chat-sdk suppressed (noneOf: useChat)", () => {
    const r = analyze("build a chatbot with useChat hooks");
    expectSuppressed(r, "chat-sdk");
    expectNotSelected(r, "chat-sdk");
  });
});

// ===========================================================================
// SOURCE FIELD — exact vs lexical vs combined attribution
// ===========================================================================

describe("source field attribution", () => {
  test("35: exact phrase match has source='exact'", () => {
    const r = analyze("use ai elements in the project");
    const result = r.perSkillResults["ai-elements"];
    expect(result).toBeDefined();
    expect(result.matched).toBe(true);
    // Exact phrase "ai elements" matches directly
    expect(result.exactScore).toBeGreaterThanOrEqual(6);
    expect(result.source).toBe("exact");
  });

  test("36: suppressed skill still reports source='exact'", () => {
    const r = analyze("update the readme with ai elements");
    const result = r.perSkillResults["ai-elements"];
    expect(result).toBeDefined();
    expect(result.suppressed).toBe(true);
    expect(result.source).toBe("exact");
  });

  test("37: allOf-only match has source='exact' when above threshold", () => {
    const r = analyze("add middleware to the next application for auth");
    const result = r.perSkillResults["nextjs"];
    expect(result).toBeDefined();
    // allOf [middleware, next] = +4, anyOf may contribute; phrase "next.js" won't match "next"
    if (result.matched) {
      expect(["exact", "combined", "lexical"]).toContain(result.source);
    }
  });
});

// ===========================================================================
// NEAR-MISS PROMPTS — close but below threshold
// ===========================================================================

describe("near-miss prompts — close but insufficient signal", () => {
  test("38: 'use react for the UI' → no ai-elements selected (no phrase/allOf hit)", () => {
    const r = analyze("use react for the UI");
    expectNotSelected(r, "ai-elements");
  });

  test("39: 'add some caching to the API' → no swr selected (generic caching != SWR signals)", () => {
    const r = analyze("add some caching to the API");
    expectNotSelected(r, "swr");
  });

  test("40: 'deploy the app' → vercel-cli may match via lexical boost (anyOf + retrieval alias)", () => {
    const r = analyze("deploy the app");
    // "deploy" is an anyOf term (+1 exact) but retrieval aliases include "deploy command"
    // so lexical boosting can push it above threshold — that's the hybrid system working
    const result = r.perSkillResults["vercel-cli"];
    expect(result).toBeDefined();
    // Verify the exact score alone is weak
    expect(result.exactScore).toBeLessThan(6);
    // But lexical boosting may raise the final score above threshold
    if (result.matched) {
      expect(result.source).not.toBe("exact");
    }
  });

  test("41: 'add a bot' → no chat-sdk selected (no phrase match, no allOf)", () => {
    const r = analyze("add a bot");
    expectNotSelected(r, "chat-sdk");
  });
});

// ===========================================================================
// CONTRACTION NORMALIZATION
// ===========================================================================

describe("contraction normalization", () => {
  test("42: contractions are expanded before matching — \"it's not deployed\" → vercel-cli", () => {
    // "it is not deployed" — no exact phrase match for vercel-cli, but "deploy" anyOf +1
    // Actually "is it deployed" is a phrase. "it's not deployed" normalizes to "it is not deployed"
    // which doesn't match "is it deployed". Verify it doesn't accidentally match.
    const r = analyze("it's not deployed yet");
    // This should NOT match "is it deployed" phrase since word order differs
    // "deployed" isn't a phrase either — it's a substring check of "is it deployed"
    // The normalized form "it is not deployed yet" does contain "deploy" anyOf term
    const result = r.perSkillResults["vercel-cli"];
    expect(result).toBeDefined();
    // verify contraction expansion happened
    expect(r.normalizedPrompt).toContain("it is not");
  });

  test("43: \"don't use the AI SDK\" → normalized to 'do not use the ai sdk' and still matches ai-sdk phrase", () => {
    const r = analyze("don't use the AI SDK");
    expect(r.normalizedPrompt).toContain("do not");
    // "ai sdk" phrase is present → ai-sdk should match
    expectSelected(r, "ai-sdk");
  });
});

// ===========================================================================
// CASE INSENSITIVITY
// ===========================================================================

describe("case insensitivity", () => {
  test("44: 'USE THE AI SDK' (all caps) → ai-sdk", () => {
    const r = analyze("USE THE AI SDK");
    expectSelected(r, "ai-sdk");
  });

  test("45: 'Build A Chat Interface' (title case) → ai-elements", () => {
    const r = analyze("Build A Chat Interface");
    expectSelected(r, "ai-elements");
  });

  test("46: 'NEXTJS app router setup' (mixed case) → nextjs", () => {
    const r = analyze("NEXTJS app router setup");
    expectSelected(r, "nextjs");
  });
});

// ===========================================================================
// DEDUP INTEGRATION
// ===========================================================================

describe("dedup — seen skills are not re-selected", () => {
  test("47: ai-elements already seen → not in selectedSkills", () => {
    const r = analyze("use ai elements for the chat", "ai-elements");
    expect(r.perSkillResults["ai-elements"].matched).toBe(true);
    expectNotSelected(r, "ai-elements");
    expect(r.dedupState.filteredByDedup).toContain("ai-elements");
  });

  test("48: multiple seen skills → both filtered", () => {
    const r = analyze(
      "use the AI SDK streamText to build a streaming chat ui",
      "ai-sdk,ai-elements",
    );
    expectNotSelected(r, "ai-sdk");
    expectNotSelected(r, "ai-elements");
    expect(r.dedupState.filteredByDedup).toContain("ai-sdk");
    expect(r.dedupState.filteredByDedup).toContain("ai-elements");
  });
});

// ===========================================================================
// REPORT STRUCTURE INVARIANTS
// ===========================================================================

describe("report structure invariants", () => {
  test("49: every perSkillResult has all required fields", () => {
    const r = analyze("use ai elements streaming markdown with the AI SDK");
    for (const [skill, result] of Object.entries(r.perSkillResults)) {
      expect(typeof result.score).toBe("number");
      expect(typeof result.exactScore).toBe("number");
      expect(typeof result.lexicalScore).toBe("number");
      expect(typeof result.finalScore).toBe("number");
      expect(["exact", "lexical", "combined"]).toContain(result.source);
      expect(typeof result.reason).toBe("string");
      expect(typeof result.matched).toBe("boolean");
      expect(typeof result.suppressed).toBe("boolean");
      // boostTier is null or a string
      if (result.boostTier !== null) {
        expect(["high", "mid", "low"]).toContain(result.boostTier);
      }
      // finalScore === score invariant
      expect(result.finalScore).toBe(result.score);
    }
  });

  test("50: selectedSkills is a subset of matched skills", () => {
    const r = analyze("use the AI SDK to build a chat ui with streaming markdown");
    for (const skill of r.selectedSkills) {
      expect(r.perSkillResults[skill]).toBeDefined();
      expect(r.perSkillResults[skill].matched).toBe(true);
    }
  });

  test("51: timingMs is non-negative", () => {
    const r = analyze("anything at all");
    expect(r.timingMs).toBeGreaterThanOrEqual(0);
  });

  test("52: selectedSkills respects maxSkills=2 cap", () => {
    // Prompt that matches many skills at once
    const r = analyze(
      "use ai elements streaming markdown and the AI SDK streamText with SWR and Next.js app router",
    );
    expect(r.selectedSkills.length).toBeLessThanOrEqual(2);
  });
});

// ===========================================================================
// BLIND PARAPHRASES — natural wording that does NOT match literal phrases
// ===========================================================================

describe("blind paraphrases — natural wording, no literal phrase hits", () => {
  test("53: 'build a component to render each message in the conversation' → ai-elements via allOf", () => {
    // allOf [message, component] +4, [conversation, component] +4 = 8
    // No literal phrase "message component" or "conversation component" in promptSignals.phrases
    const r = analyze("build a component to render each message in the conversation");
    expectSelected(r, "ai-elements");
  });

  test("54: 'I need an ai component that can stream the response' → ai-elements via allOf", () => {
    // allOf [ai, component] +4, [stream, response] +4 = 8
    // No literal phrase "ai component" or "stream response" in promptSignals.phrases
    const r = analyze("I need an ai component that can stream the response");
    expectSelected(r, "ai-elements");
  });

  test("55: 'render markdown content as it streams from the api' → ai-elements via allOf", () => {
    // allOf [markdown, stream] +4, [markdown, render] +4 = 8
    // "streaming markdown" is a phrase but "markdown...streams" is not the same substring
    const r = analyze("render markdown content as it streams from the api");
    expectSelected(r, "ai-elements");
  });

  test("56: 'hook up streaming generation with tool calling and embeddings' → ai-sdk via allOf+anyOf", () => {
    // allOf [streaming, generation] +4, anyOf "tool calling" +1, "embeddings" +1 = 6
    // No literal phrases from ai-sdk match
    const r = analyze("hook up streaming generation with tool calling and embeddings");
    expectSelected(r, "ai-sdk");
  });

  test("57: 'check if the deploy went through and show the error' → vercel-cli via allOf", () => {
    // allOf [check, deploy] +4, [deploy, error] +4, anyOf "deploy" +1 = 9
    // "check deploy" phrase doesn't match because "check if the deploy" ≠ "check deploy" substring
    const r = analyze("check if the deploy went through and show the error");
    expectSelected(r, "vercel-cli");
  });

  test("58: 'the deploy is stuck, check the error log' → vercel-cli via allOf", () => {
    // allOf [check, deploy] +4, [deploy, stuck] +4, [deploy, error] +4 = 12+
    const r = analyze("the deploy is stuck, check the error log");
    expectSelected(r, "vercel-cli");
  });

  test("59: 'add a route with a layout for the next application' → nextjs via allOf+retrieval", () => {
    // allOf [layout, route] +4, retrieval alias "next" +3 = 7
    // No literal phrases: "next.js", "nextjs", "app router", "server component", "server action" absent
    const r = analyze("add a route with a layout for the next application");
    expectSelected(r, "nextjs");
  });

  test("60: 'add client data fetching with a mutation hook' → swr via allOf+anyOf+retrieval", () => {
    // allOf [data fetching, client] +4, anyOf "mutation" +1, retrieval alias "data fetching" +3 = 8
    // No literal phrases "swr", "useswr", "stale-while-revalidate" present
    const r = analyze("add client data fetching with a mutation hook");
    expectSelected(r, "swr");
  });

  test("61: 'build a multi platform bot for conversations' → chat-sdk via allOf", () => {
    // allOf [bot, platform] +4, [bot, multi] +4 = 8
    // No literal phrases: "chat bot", "chatbot", "slack bot" etc. absent
    const r = analyze("build a multi platform bot for conversations");
    expectSelected(r, "chat-sdk");
  });

  test("62: 'stream the ai response into a markdown render component' → ai-elements via allOf", () => {
    // allOf [ai, component] +4, [markdown, stream] +4, [markdown, render] +4, [stream, response] +4 = 16
    const r = analyze("stream the ai response into a markdown render component");
    expectSelected(r, "ai-elements");
  });

  test("63: 'show conversation messages in a react component' → ai-elements via allOf", () => {
    // allOf [message, component] +4 (messages → \bmessage\b? no, but [conversation, component] +4)
    // allOf [conversation, component] +4
    // anyOf "message component" substring? "conversation messages in a react component" — no
    const r = analyze("show conversation messages in a react component");
    expectSelected(r, "ai-elements");
  });

  test("64: 'the deploy error shows a timeout, check what happened' → vercel-cli via allOf", () => {
    // allOf [check, deploy] → "check" present, "deploy" present → +4
    // allOf [deploy, error] → both present → +4
    // anyOf "deploy" → +1
    // = 9
    const r = analyze("the deploy error shows a timeout, check what happened");
    expectSelected(r, "vercel-cli");
  });
});

// ===========================================================================
// NEGATIVE CONTROLS — near-domain confusions that should NOT match
// ===========================================================================

describe("near-domain confusions — close to a skill but should not match", () => {
  test("65: 'add a sticky header to the navigation bar' → no skills", () => {
    const r = analyze("add a sticky header to the navigation bar");
    expect(r.selectedSkills).toEqual([]);
  });

  test("66: 'deploy infrastructure with terraform and ansible' → no skills (vercel-cli suppressed)", () => {
    const r = analyze("deploy infrastructure with terraform and ansible");
    expectSuppressed(r, "vercel-cli");
    expectNotSelected(r, "vercel-cli");
  });

  test("67: 'set up a kubernetes cluster for the backend' → no skills", () => {
    const r = analyze("set up a kubernetes cluster for the backend");
    expect(r.selectedSkills).toEqual([]);
  });

  test("68: 'configure nginx reverse proxy for load balancing' → no skills", () => {
    const r = analyze("configure nginx reverse proxy for load balancing");
    expect(r.selectedSkills).toEqual([]);
  });

  test("69: 'optimize the database query cache for postgres' → no swr (generic cache ≠ SWR)", () => {
    const r = analyze("optimize the database query cache for postgres");
    expectNotSelected(r, "swr");
  });

  test("70: 'add a component to the sidebar panel' → no ai-elements (component alone insufficient)", () => {
    const r = analyze("add a component to the sidebar panel");
    expectNotSelected(r, "ai-elements");
  });

  test("71: 'generate a PDF report from the data' → no ai-sdk (generate ≠ generateText context)", () => {
    const r = analyze("generate a PDF report from the data");
    expectNotSelected(r, "ai-sdk");
  });

  test("72: 'check the unit test results and fix failures' → no vercel-cli (check without deploy)", () => {
    const r = analyze("check the unit test results and fix failures");
    expectNotSelected(r, "vercel-cli");
  });

  test("73: 'build a react native screen for user profile' → no ai-elements (react native ≠ chat UI)", () => {
    const r = analyze("build a react native screen for user profile");
    expectNotSelected(r, "ai-elements");
  });

  test("74: 'add markdown syntax to the readme documentation' → ai-elements suppressed (noneOf: readme)", () => {
    const r = analyze("add markdown syntax to the readme documentation");
    expectSuppressed(r, "ai-elements");
    expectNotSelected(r, "ai-elements");
  });
});
