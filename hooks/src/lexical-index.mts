import MiniSearch from "minisearch";
import * as hookEnv from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import { CONTRACTIONS } from "./shared-contractions.mjs";

export { CONTRACTIONS };

type RetrievalField = "aliases" | "intents" | "entities" | "examples";
type RetrievalBlock = Partial<Record<RetrievalField, unknown>>;
type LexicalDocument = Record<RetrievalField, string> & { id: string };
type NumberEnv = (name: string, fallback: number) => number;

export const SYNONYM_MAP = {
  // --- original 8 ---
  deploy: ["ship", "release", "go-live", "publish", "push"],
  env: ["environment", "secret", "config", "variable"],
  auth: ["login", "signin", "session", "authentication", "credentials"],
  chat: ["conversation", "messaging", "bot", "chatbot"],
  database: ["db", "sql", "postgres", "prisma", "drizzle"],
  style: ["css", "styling", "theme", "tailwind"],
  test: ["testing", "spec", "jest", "vitest"],
  api: ["endpoint", "route", "handler", "rest", "graphql"],
  // --- Vercel platform groups (20) ---
  cache: ["cdn", "revalidate", "isr", "edge-cache", "stale-while-revalidate"],
  ssr: ["server-rendering", "server-component", "server-side", "rsc"],
  cron: ["scheduled", "jobs", "recurring", "timer"],
  blob: ["storage", "upload", "s3", "file-upload"],
  analytics: ["tracking", "metrics", "observability", "telemetry"],
  middleware: ["interceptor", "edge-middleware", "request-handler"],
  queue: ["background-jobs", "worker", "async-task"],
  image: ["og", "opengraph", "social-card", "satori"],
  monorepo: ["turborepo", "workspace", "multi-package"],
  domain: ["dns", "subdomain", "custom-domain"],
  redirect: ["rewrite", "url-rewrite", "next-rewrite"],
  log: ["logging", "debug", "trace", "stdout"],
  error: ["exception", "error-handling", "bug", "crash", "stacktrace"],
  webhook: ["callback", "event-hook", "http-callback"],
  migration: ["schema-change", "database-migration", "migrate"],
  preview: ["staging", "branch-deploy", "preview-deployment"],
  serverless: ["lambda", "edge-function", "cloud-function"],
  "rate-limit": ["throttle", "quota", "rate-limiting"],
  "feature-flag": ["toggle", "experiment", "flags", "ab-test"],
  seo: ["sitemap", "meta-tags", "structured-data", "robots"],
  // --- new expansion groups (9) ---
  perf: ["performance", "speed", "optimize", "latency", "slow"],
  build: ["bundler", "compile", "webpack", "esbuild", "vite"],
  routing: ["pages", "navigation", "router", "url", "path"],
  realtime: ["websocket", "socket", "sse", "streaming", "live"],
  state: ["store", "redux", "zustand", "context", "signal"],
  search: ["indexing", "filter", "fulltext", "algolia", "elasticsearch"],
  email: ["smtp", "notification", "inbox", "sendgrid", "resend"],
  payment: ["stripe", "billing", "checkout", "subscription", "invoice"],
  ci: ["continuous-integration", "pipeline", "github-actions", "automation", "workflow"],
} as const;

const FIELDS: RetrievalField[] = ["aliases", "intents", "entities", "examples"];
const SEARCH_OPTIONS = {
  prefix: true,
  fuzzy: 0.2,
  boost: { intents: 3, aliases: 2, entities: 1.5, examples: 1 },
} as const;
const logger = createLogger();
const numberEnv: NumberEnv =
  (hookEnv as { numberEnv?: NumberEnv }).numberEnv ?? ((name, fallback) => {
    const raw = process.env[name];
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
  });

const expansionLookup = buildExpansionLookup();
let lexicalIndex: MiniSearch<LexicalDocument> | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildExpansionLookup(): Record<string, string[]> {
  const lookup: Record<string, string[]> = {};
  for (const [root, aliases] of Object.entries(SYNONYM_MAP)) {
    const terms = [...new Set([root, ...aliases])];
    for (const term of terms) lookup[term] = terms;
  }
  return lookup;
}

function expandContractions(text: string): string {
  return Object.entries(CONTRACTIONS).reduce(
    (result, [from, to]) => result.replaceAll(new RegExp(`\\b${from}\\b`, "g"), to),
    text.toLowerCase().replaceAll("’", "'"),
  );
}

export function expandText(text: string, includeContractions = false): string {
  const source = includeContractions ? expandContractions(text) : text.toLowerCase();
  const tokens = source.match(/[a-z0-9-]+/g) ?? [];
  const seen = new Set<string>();
  const expanded: string[] = [];

  function add(term: string) {
    if (!seen.has(term)) {
      seen.add(term);
      expanded.push(term);
    }
  }

  let i = 0;
  while (i < tokens.length) {
    // Try joining adjacent tokens with a hyphen to match compound synonyms
    if (i + 1 < tokens.length) {
      const bigram = `${tokens[i]}-${tokens[i + 1]}`;
      if (expansionLookup[bigram]) {
        for (const term of expansionLookup[bigram]) add(term);
        i += 2;
        continue;
      }
    }
    for (const term of expansionLookup[tokens[i]] ?? [tokens[i]]) add(term);
    i++;
  }

  return expanded.join(" ");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function resolveRetrievalBlock(skill: any): RetrievalBlock | null {
  const entry = asRecord(skill);
  const frontmatter = asRecord(entry?.frontmatter);
  const metadata = asRecord(entry?.metadata);
  const frontmatterMetadata = asRecord(frontmatter?.metadata);
  return (
    asRecord(entry?.retrieval) ||
    asRecord(metadata?.retrieval) ||
    asRecord(frontmatter?.retrieval) ||
    asRecord(frontmatterMetadata?.retrieval)
  );
}

function buildDocument(id: string, retrieval: RetrievalBlock): LexicalDocument | null {
  const document = {
    id,
    aliases: expandText(stringList(retrieval.aliases).join(" ")),
    intents: expandText(stringList(retrieval.intents).join(" ")),
    entities: expandText(stringList(retrieval.entities).join(" ")),
    examples: expandText(stringList(retrieval.examples).join(" ")),
  };
  return FIELDS.some((field) => document[field] !== "") ? document : null;
}

export function initializeLexicalIndex(skillMap: Map<string, any>): void {
  const documents: LexicalDocument[] = [];

  for (const [skill, entry] of skillMap) {
    const retrieval = resolveRetrievalBlock(entry);
    const document = retrieval ? buildDocument(skill, retrieval) : null;
    if (document) documents.push(document);
  }

  try {
    lexicalIndex = new MiniSearch<LexicalDocument>({
      fields: FIELDS,
      storeFields: ["id"],
      searchOptions: SEARCH_OPTIONS,
    });
    lexicalIndex.addAll(documents);
    logger.debug("lexical-index:initialized", {
      indexedSkillCount: documents.length,
      totalSkillCount: skillMap.size,
    });
  } catch (error) {
    lexicalIndex = null;
    logCaughtError(logger, "lexical-index:initialize-failed", error, {
      indexedSkillCount: documents.length,
      totalSkillCount: skillMap.size,
    });
  }
}

export function searchSkills(query: string): { skill: string; score: number }[] {
  if (!lexicalIndex) return [];

  const expandedQuery = expandText(query, true);
  if (expandedQuery === "") return [];

  try {
    const minScore = numberEnv("VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE", 4.0);
    return lexicalIndex
      .search(expandedQuery)
      .map((result) => ({ skill: String(result.id), score: result.score }))
      .filter((result) => result.score >= minScore)
      .sort((left, right) => right.score - left.score);
  } catch (error) {
    logCaughtError(logger, "lexical-index:search-failed", error, { query });
    return [];
  }
}
