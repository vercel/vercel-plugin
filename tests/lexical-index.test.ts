import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CONTRACTIONS,
  SYNONYM_MAP,
  expandText,
  initializeLexicalIndex,
  searchSkills,
} from "../hooks/src/lexical-index.mts";
import { CONTRACTIONS as SHARED_CONTRACTIONS } from "../hooks/src/shared-contractions.mts";

describe("lexical-index CONTRACTIONS", () => {
  test("re-exports the shared contraction map", () => {
    expect(CONTRACTIONS).toBe(SHARED_CONTRACTIONS);
  });

  test("includes apostrophe-free variants", () => {
    expect(CONTRACTIONS["dont"]).toBe("do not");
    expect(CONTRACTIONS["cant"]).toBe("cannot");
    expect(CONTRACTIONS["im"]).toBe("i am");
  });

  test("includes apostrophe forms", () => {
    expect(CONTRACTIONS["don't"]).toBe("do not");
    expect(CONTRACTIONS["can't"]).toBe("cannot");
    expect(CONTRACTIONS["it's"]).toBe("it is");
    expect(CONTRACTIONS["what's"]).toBe("what is");
  });
});

describe("SYNONYM_MAP structure", () => {
  test("has at least 35 synonym groups", () => {
    expect(Object.keys(SYNONYM_MAP).length).toBeGreaterThanOrEqual(35);
  });

  test("every group has at least 2 synonyms", () => {
    for (const [root, aliases] of Object.entries(SYNONYM_MAP)) {
      expect(aliases.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("SYNONYM_MAP bidirectional expansion", () => {
  // Helper: build the expansion lookup the same way the module does
  function buildExpansionLookup(): Record<string, string[]> {
    const lookup: Record<string, string[]> = {};
    for (const [root, aliases] of Object.entries(SYNONYM_MAP)) {
      const terms = [...new Set([root, ...aliases])];
      for (const term of terms) lookup[term] = terms;
    }
    return lookup;
  }

  const lookup = buildExpansionLookup();

  function assertBidirectional(root: string, member: string) {
    // root expands to include member
    expect(lookup[root]).toContain(member);
    // member expands to include root
    expect(lookup[member]).toContain(root);
  }

  // Original groups
  test("deploy <-> ship", () => assertBidirectional("deploy", "ship"));
  test("env <-> secret", () => assertBidirectional("env", "secret"));
  test("auth <-> login", () => assertBidirectional("auth", "login"));
  test("database <-> postgres", () => assertBidirectional("database", "postgres"));
  test("api <-> endpoint", () => assertBidirectional("api", "endpoint"));

  // New groups: cache/cdn/edge
  test("cache <-> cdn", () => assertBidirectional("cache", "cdn"));
  test("cache <-> revalidate", () => assertBidirectional("cache", "revalidate"));
  test("cache <-> isr", () => assertBidirectional("cache", "isr"));

  // ssr/server-rendering
  test("ssr <-> server-rendering", () => assertBidirectional("ssr", "server-rendering"));
  test("ssr <-> server-component", () => assertBidirectional("ssr", "server-component"));

  // cron/scheduled/jobs
  test("cron <-> scheduled", () => assertBidirectional("cron", "scheduled"));
  test("cron <-> jobs", () => assertBidirectional("cron", "jobs"));
  test("cron <-> recurring", () => assertBidirectional("cron", "recurring"));

  // blob/storage/upload
  test("blob <-> storage", () => assertBidirectional("blob", "storage"));
  test("blob <-> upload", () => assertBidirectional("blob", "upload"));
  test("blob <-> s3", () => assertBidirectional("blob", "s3"));

  // analytics/tracking/metrics
  test("analytics <-> tracking", () => assertBidirectional("analytics", "tracking"));
  test("analytics <-> metrics", () => assertBidirectional("analytics", "metrics"));
  test("analytics <-> observability", () => assertBidirectional("analytics", "observability"));

  // middleware/interceptor
  test("middleware <-> interceptor", () => assertBidirectional("middleware", "interceptor"));
  test("middleware <-> edge-middleware", () => assertBidirectional("middleware", "edge-middleware"));

  // queue/background-jobs
  test("queue <-> background-jobs", () => assertBidirectional("queue", "background-jobs"));
  test("queue <-> worker", () => assertBidirectional("queue", "worker"));

  // image/og
  test("image <-> og", () => assertBidirectional("image", "og"));
  test("image <-> opengraph", () => assertBidirectional("image", "opengraph"));

  // monorepo/turborepo
  test("monorepo <-> turborepo", () => assertBidirectional("monorepo", "turborepo"));
  test("monorepo <-> workspace", () => assertBidirectional("monorepo", "workspace"));

  // domain/dns
  test("domain <-> dns", () => assertBidirectional("domain", "dns"));
  test("domain <-> subdomain", () => assertBidirectional("domain", "subdomain"));

  // redirect/rewrite
  test("redirect <-> rewrite", () => assertBidirectional("redirect", "rewrite"));
  test("redirect <-> url-rewrite", () => assertBidirectional("redirect", "url-rewrite"));

  // log/logging
  test("log <-> logging", () => assertBidirectional("log", "logging"));
  test("log <-> debug", () => assertBidirectional("log", "debug"));

  // error/exception
  test("error <-> exception", () => assertBidirectional("error", "exception"));
  test("error <-> error-handling", () => assertBidirectional("error", "error-handling"));

  // webhook/callback
  test("webhook <-> callback", () => assertBidirectional("webhook", "callback"));
  test("webhook <-> event-hook", () => assertBidirectional("webhook", "event-hook"));

  // migration/schema-change
  test("migration <-> schema-change", () => assertBidirectional("migration", "schema-change"));
  test("migration <-> database-migration", () => assertBidirectional("migration", "database-migration"));

  // preview/staging
  test("preview <-> staging", () => assertBidirectional("preview", "staging"));
  test("preview <-> branch-deploy", () => assertBidirectional("preview", "branch-deploy"));

  // serverless/lambda
  test("serverless <-> lambda", () => assertBidirectional("serverless", "lambda"));
  test("serverless <-> edge-function", () => assertBidirectional("serverless", "edge-function"));

  // rate-limit/throttle
  test("rate-limit <-> throttle", () => assertBidirectional("rate-limit", "throttle"));
  test("rate-limit <-> quota", () => assertBidirectional("rate-limit", "quota"));

  // feature-flag/toggle
  test("feature-flag <-> toggle", () => assertBidirectional("feature-flag", "toggle"));
  test("feature-flag <-> experiment", () => assertBidirectional("feature-flag", "experiment"));
  test("feature-flag <-> flags", () => assertBidirectional("feature-flag", "flags"));

  // seo/sitemap
  test("seo <-> sitemap", () => assertBidirectional("seo", "sitemap"));
  test("seo <-> meta-tags", () => assertBidirectional("seo", "meta-tags"));
  test("seo <-> structured-data", () => assertBidirectional("seo", "structured-data"));

  // perf/performance
  test("perf <-> performance", () => assertBidirectional("perf", "performance"));
  test("perf <-> optimize", () => assertBidirectional("perf", "optimize"));
  test("perf <-> latency", () => assertBidirectional("perf", "latency"));
  test("perf <-> slow", () => assertBidirectional("perf", "slow"));

  // build/bundler
  test("build <-> bundler", () => assertBidirectional("build", "bundler"));
  test("build <-> webpack", () => assertBidirectional("build", "webpack"));
  test("build <-> esbuild", () => assertBidirectional("build", "esbuild"));
  test("build <-> vite", () => assertBidirectional("build", "vite"));

  // routing/pages
  test("routing <-> pages", () => assertBidirectional("routing", "pages"));
  test("routing <-> navigation", () => assertBidirectional("routing", "navigation"));
  test("routing <-> router", () => assertBidirectional("routing", "router"));

  // realtime/websocket
  test("realtime <-> websocket", () => assertBidirectional("realtime", "websocket"));
  test("realtime <-> socket", () => assertBidirectional("realtime", "socket"));
  test("realtime <-> sse", () => assertBidirectional("realtime", "sse"));
  test("realtime <-> streaming", () => assertBidirectional("realtime", "streaming"));

  // state/store
  test("state <-> store", () => assertBidirectional("state", "store"));
  test("state <-> redux", () => assertBidirectional("state", "redux"));
  test("state <-> zustand", () => assertBidirectional("state", "zustand"));
  test("state <-> context", () => assertBidirectional("state", "context"));

  // search/indexing
  test("search <-> indexing", () => assertBidirectional("search", "indexing"));
  test("search <-> filter", () => assertBidirectional("search", "filter"));
  test("search <-> fulltext", () => assertBidirectional("search", "fulltext"));

  // email/smtp
  test("email <-> smtp", () => assertBidirectional("email", "smtp"));
  test("email <-> notification", () => assertBidirectional("email", "notification"));
  test("email <-> resend", () => assertBidirectional("email", "resend"));

  // payment/stripe
  test("payment <-> stripe", () => assertBidirectional("payment", "stripe"));
  test("payment <-> billing", () => assertBidirectional("payment", "billing"));
  test("payment <-> subscription", () => assertBidirectional("payment", "subscription"));

  // ci/pipeline
  test("ci <-> pipeline", () => assertBidirectional("ci", "pipeline"));
  test("ci <-> github-actions", () => assertBidirectional("ci", "github-actions"));
  test("ci <-> automation", () => assertBidirectional("ci", "automation"));
});

describe("multi-token synonym expansion", () => {
  test("'go live' (spaced) expands same as 'go-live' (hyphenated)", () => {
    const spaced = expandText("go live");
    const hyphenated = expandText("go-live");
    expect(spaced).toBe(hyphenated);
    // Both should contain deploy synonyms
    expect(spaced).toContain("deploy");
    expect(spaced).toContain("ship");
    expect(spaced).toContain("release");
  });

  test("'server side' expands same as 'server-side'", () => {
    const spaced = expandText("server side");
    const hyphenated = expandText("server-side");
    expect(spaced).toBe(hyphenated);
    expect(spaced).toContain("ssr");
    expect(spaced).toContain("server-rendering");
  });

  test("'feature flag' expands same as 'feature-flag'", () => {
    const spaced = expandText("feature flag");
    const hyphenated = expandText("feature-flag");
    expect(spaced).toBe(hyphenated);
    expect(spaced).toContain("toggle");
    expect(spaced).toContain("experiment");
    expect(spaced).toContain("flags");
  });

  test("'rate limit' expands same as 'rate-limit'", () => {
    const spaced = expandText("rate limit");
    const hyphenated = expandText("rate-limit");
    expect(spaced).toBe(hyphenated);
    expect(spaced).toContain("throttle");
    expect(spaced).toContain("quota");
  });

  test("'edge cache' expands same as 'edge-cache'", () => {
    const spaced = expandText("edge cache");
    const hyphenated = expandText("edge-cache");
    expect(spaced).toBe(hyphenated);
    expect(spaced).toContain("cache");
    expect(spaced).toContain("cdn");
  });

  test("non-synonym bigrams do not trigger expansion", () => {
    // "the app" is not a synonym key — each word should be treated independently
    const result = expandText("the app");
    expect(result).toBe("the app");
  });

  test("multi-token expansion in a longer sentence", () => {
    const result = expandText("I want to go live with my feature flag");
    // "go live" → deploy group, "feature flag" → toggle group
    expect(result).toContain("deploy");
    expect(result).toContain("toggle");
  });
});

describe("lexical fallback no-overfire", () => {
  let previousMinScore: string | undefined;

  beforeEach(() => {
    previousMinScore = process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
    delete process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
  });

  afterEach(() => {
    if (previousMinScore === undefined) {
      delete process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
    } else {
      process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE = previousMinScore;
    }
    initializeLexicalIndex(new Map());
  });

  test("unrelated query returns no results", () => {
    initializeLexicalIndex(
      new Map([
        [
          "vercel-functions",
          {
            retrieval: {
              aliases: ["serverless", "lambda"],
              intents: ["deploy function"],
              entities: ["vercel-function"],
              examples: ["create a serverless function"],
            },
          },
        ],
        [
          "observability",
          {
            retrieval: {
              aliases: ["log", "debug", "trace"],
              intents: ["check logs"],
              entities: ["logging"],
              examples: ["view application logs"],
            },
          },
        ],
      ]),
    );

    // A completely unrelated query should return nothing
    const results = searchSkills("how to make pizza");
    expect(results).toEqual([]);
  });

  test("default min score filters out weak matches (raised from 4.5 to 5.0)", () => {
    // With the default min score at 5.0, marginal hits are filtered
    initializeLexicalIndex(
      new Map([
        [
          "test-skill",
          {
            retrieval: {
              aliases: ["niche-term"],
              intents: ["niche intent"],
              entities: [],
              examples: [],
            },
          },
        ],
      ]),
    );

    const results = searchSkills("vaguely related stuff");
    // Should return empty or only results >= 5.0
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(5.0);
    }
  });

  test("raised min score can be overridden via env var", () => {
    process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE = "100";
    initializeLexicalIndex(
      new Map([
        [
          "vercel-functions",
          {
            retrieval: {
              aliases: ["serverless", "lambda", "function"],
              intents: ["deploy function"],
              entities: [],
              examples: [],
            },
          },
        ],
      ]),
    );

    // With a very high min score, even direct matches should be filtered
    const results = searchSkills("serverless");
    expect(results).toEqual([]);
  });
});
