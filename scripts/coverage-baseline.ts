#!/usr/bin/env bun
/**
 * Coverage baseline: compares Vercel's llms.txt product index
 * against the ecosystem graph to find uncovered products.
 *
 * Usage: bun run scripts/coverage-baseline.ts
 * Exits 0 when all products are covered, non-zero otherwise.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LLMS_TXT_URL = "https://vercel.com/llms.txt";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Sections to skip entirely — too granular or organizational, not product areas */
const SKIP_SECTIONS = new Set([
  "CLI", // 40+ individual commands; CLI as a product is checked via graph node
  "Pricing", // Billing info, not a product
  "Platform", // Config/limits docs, covered by Core Platform in graph
  "Multi-tenant", // Vercel for Platforms docs, niche feature
]);

/**
 * Individual entries to skip — meta pages, sub-features, or capabilities
 * already covered by their parent product node in the graph.
 */
const SKIP_ENTRIES = new Set([
  // Generic meta pages that appear in multiple sections
  "Overview",
  "Getting Started",

  // Access — auth/access features covered under Core Platform
  "Account Management",
  "Activity Log",
  "Deployment Protection",
  "Directory Sync",
  "SAML SSO",
  "Two-factor (2FA)",

  // AI — meta page
  "Agent Resources",

  // Build & Deploy — deployment features covered under Core Platform
  "Builds",
  "Deploy Hooks",
  "Deployment Checks",
  "Deployment Retention",
  "Deployments",
  "Environment Variables",
  "Git Integrations",
  "Instant Rollback",
  "Monorepos",
  "Package Managers",
  "Restricting Git Connections to a single Vercel team",
  "Rolling Releases",
  "Skew Protection",
  "Webhooks",

  // CDN — network features covered under Edge Network in Core Platform
  "Regions",
  "Headers",
  "CDN Cache",
  "Encryption",
  "Compression",
  "Incremental Static Regeneration",
  "Redirects",
  "Rewrites",
  "Custom Error Pages",
  "Manage CDN Usage",
  "Request Collapsing",

  // Collaboration — UI features covered under Core Platform
  "Draft Mode",
  "Edit Mode",

  // Compute — sub-features already covered by parent product nodes
  "Fluid Compute",

  // Integrations — docs about building/installing integrations, not products
  "Install an Integration",
  "Create an Integration",
  "CMS Integrations",
  "Commerce and Payments",

  // Observability — individual sub-features covered by Observability node
  "Logs",
  "Tracing",
  "Query",
  "Notebooks",
  "Manage & Optimize",

  // Security — granular access/compliance features, not standalone products
  "Audit Logs",
  "BotID",
  "Connectivity",
  "RBAC",
  "Two-factor Enforcement",
]);

/**
 * Section-specific skips — entries whose names collide with other products
 * but are sub-features within their section context.
 */
const SKIP_SECTION_ENTRIES = new Set([
  "Flags:Marketplace", // Flags marketplace integrations, not Vercel Marketplace
  "Flags:Observability", // Flags observability, not Vercel Observability
]);

/**
 * Aliases: maps an llms.txt product name to additional search terms.
 * If any alias is found in the graph (case-insensitive), the product counts as covered.
 */
const ALIASES: Record<string, string[]> = {
  Functions: ["Serverless Functions", "Edge Functions", "Vercel Functions"],
  MCP: ["MCP Server", "MCP Integration", "MCP Client"],
  Comments: ["Preview Comments"],
  Toolbar: ["Vercel Toolbar"],
  "Image Optimization": ["next/image", "Image Optimization"],
  "Cron Jobs": ["Cron Jobs", "Cron"],
  "Speed Insights": ["Speed Insights"],
  "Web Analytics": ["Web Analytics", "Vercel Analytics"],
  Drains: ["Vercel Drains"],
  Alerts: ["Monitoring"],
  Blob: ["Vercel Blob"],
  "Edge Config": ["Vercel Edge Config", "Edge Config"],
  Firewall: ["Vercel Firewall"],
  "Bot Management": ["Bot Filter"],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Product {
  section: string;
  name: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Extract first-level products from llms.txt under # Vercel Documentation */
function parseLlmsTxt(text: string): Product[] {
  const lines = text.split("\n");
  const products: Product[] = [];
  let inVercelDocs = false;
  let currentSection = "";

  for (const line of lines) {
    // Track top-level # headers
    if (line.startsWith("# ")) {
      inVercelDocs = line.includes("Vercel Documentation");
      currentSection = "";
      continue;
    }

    if (!inVercelDocs) continue;

    // Track ## section headers
    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim();
      continue;
    }

    // First-level entries only: "- [Name](url)" with no leading whitespace
    const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
    if (match && currentSection) {
      products.push({
        section: currentSection,
        name: match[1],
        url: match[2],
      });
    }
  }

  return products;
}

// ---------------------------------------------------------------------------
// Graph matching
// ---------------------------------------------------------------------------

/** Check if a product name (or any of its aliases) appears in the graph */
function isInGraph(graphLower: string, productName: string): boolean {
  const name = productName.toLowerCase();

  // Direct match
  if (graphLower.includes(name)) return true;

  // Check explicit aliases
  const aliases = ALIASES[productName];
  if (aliases) {
    for (const alias of aliases) {
      if (graphLower.includes(alias.toLowerCase())) return true;
    }
  }

  // Try adding "Vercel" prefix (e.g., "Blob" → "Vercel Blob")
  if (!name.startsWith("vercel ") && graphLower.includes(`vercel ${name}`))
    return true;

  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface CoverageResult {
  total: number;
  covered: Product[];
  missing: Product[];
}

/** Run the coverage baseline check. Returns results without exiting. */
export async function checkCoverage(root: string): Promise<CoverageResult> {
  // Fetch llms.txt
  const res = await fetch(LLMS_TXT_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch llms.txt: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  // Parse products
  const all = parseLlmsTxt(text);
  const products = all.filter(
    (p) =>
      !SKIP_SECTIONS.has(p.section) &&
      !SKIP_ENTRIES.has(p.name) &&
      !SKIP_SECTION_ENTRIES.has(`${p.section}:${p.name}`),
  );

  // Load graph
  const candidateGraphPaths = [
    join(root, "vercel.md"),
    join(root, "assets", "vercel-ecosystem-graph.md"),
  ];

  let graph = "";
  let loaded = false;
  let lastError: unknown = null;

  for (const graphPath of candidateGraphPaths) {
    try {
      graph = await readFile(graphPath, "utf-8");
      loaded = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!loaded) {
    throw lastError instanceof Error ? lastError : new Error("Could not load ecosystem graph");
  }

  const graphLower = graph.toLowerCase();

  // Check coverage
  const covered: Product[] = [];
  const missing: Product[] = [];

  for (const p of products) {
    if (isInGraph(graphLower, p.name)) {
      covered.push(p);
    } else {
      missing.push(p);
    }
  }

  return { total: products.length, covered, missing };
}

async function main() {
  console.log(
    "Coverage Baseline — llms.txt vs Ecosystem Graph\n" + "=".repeat(50),
  );

  console.log(`\nFetching ${LLMS_TXT_URL} ...`);

  let result: CoverageResult;
  try {
    result = await checkCoverage(ROOT);
  } catch (e) {
    console.error(`\n${e}`);
    process.exit(1);
  }

  const { total, covered, missing } = result;
  console.log(`Checking ${total} products\n`);

  // Report covered
  for (const p of covered) {
    console.log(`  ✓ [${p.section}] ${p.name}`);
  }

  // Report missing
  if (missing.length > 0) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`MISSING from ecosystem graph (${missing.length}):\n`);

    let lastSection = "";
    for (const m of missing) {
      if (m.section !== lastSection) {
        console.log(`  [${m.section}]`);
        lastSection = m.section;
      }
      console.log(`    ✗ ${m.name}`);
      console.log(`      ${m.url}`);
    }

    console.log(`\n${"=".repeat(50)}`);
    console.log(
      `Covered: ${covered.length}/${total} | Missing: ${missing.length}`,
    );
    console.error(`\nFAILED — ${missing.length} product(s) missing from graph\n`);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`\nPASSED — all ${total} products covered in graph\n`);
}

if (import.meta.main) main();
