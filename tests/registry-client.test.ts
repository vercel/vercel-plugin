import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRegistryClient,
  type RegistryManifest,
} from "../hooks/src/registry-client.mts";

const TMP = join(tmpdir(), `vercel-plugin-registry-client-${Date.now()}`);
const CACHE_DIR = join(TMP, "cache");
const DEST_DIR = join(TMP, "dest");

function makeManifest(skills: Record<string, { downloadUrl: string; version?: string }>): RegistryManifest {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    skills,
  };
}

function mockFetch(responses: Map<string, { ok: boolean; body: string; status?: number }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = responses.get(url);
    if (!entry) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
    }
    return {
      ok: entry.ok,
      status: entry.status ?? (entry.ok ? 200 : 500),
      json: async () => JSON.parse(entry.body),
      text: async () => entry.body,
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(DEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

describe("loadManifest", () => {
  test("fetches from URL when no cache exists", async () => {
    const manifest = makeManifest({ "nextjs": { downloadUrl: "https://r.test/nextjs" } });
    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      fetchImpl: mockFetch(new Map([
        ["https://r.test/manifest.json", { ok: true, body: JSON.stringify(manifest) }],
      ])),
    });

    const result = await client.loadManifest();
    expect(result.schemaVersion).toBe(1);
    expect(result.skills.nextjs.downloadUrl).toBe("https://r.test/nextjs");

    // Verify it was persisted to cache
    const cached = JSON.parse(readFileSync(join(CACHE_DIR, "manifest.json"), "utf-8"));
    expect(cached.skills.nextjs.downloadUrl).toBe("https://r.test/nextjs");
  });

  test("returns fresh cache without fetching", async () => {
    const manifest = makeManifest({ "ai-sdk": { downloadUrl: "https://r.test/ai-sdk" } });
    // Pre-seed cache as "just generated"
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, "manifest.json"), JSON.stringify(manifest), "utf-8");

    let fetchCalled = false;
    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      cacheTtlMs: 60_000,
      now: () => Date.parse(manifest.generatedAt) + 1_000, // 1s after generation
      fetchImpl: (async () => {
        fetchCalled = true;
        return { ok: false, status: 500 } as Response;
      }) as typeof fetch,
    });

    const result = await client.loadManifest("prefer-cache");
    expect(fetchCalled).toBe(false);
    expect(result.skills["ai-sdk"].downloadUrl).toBe("https://r.test/ai-sdk");
  });

  test("falls back to stale cache when fetch fails", async () => {
    const staleManifest = makeManifest({ "stale": { downloadUrl: "https://r.test/stale" } });
    staleManifest.generatedAt = new Date(Date.now() - 3_600_000).toISOString(); // 1hr ago

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, "manifest.json"), JSON.stringify(staleManifest), "utf-8");

    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      cacheTtlMs: 60_000, // 1min TTL — cache is stale
      fetchImpl: (async () => {
        return { ok: false, status: 503 } as Response;
      }) as typeof fetch,
    });

    const result = await client.loadManifest();
    expect(result.skills.stale.downloadUrl).toBe("https://r.test/stale");
  });

  test("throws when no cache and no URL configured", async () => {
    const client = createRegistryClient({
      registryManifestUrl: "",
      cacheDir: join(TMP, "empty-cache"),
    });

    await expect(client.loadManifest()).rejects.toThrow(
      /Missing VERCEL_PLUGIN_SKILL_REGISTRY_URL/,
    );
  });

  test("returns stale cache when no URL configured", async () => {
    const stale = makeManifest({ "cached": { downloadUrl: "https://r.test/cached" } });
    stale.generatedAt = new Date(0).toISOString(); // very stale

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, "manifest.json"), JSON.stringify(stale), "utf-8");

    const client = createRegistryClient({
      registryManifestUrl: "",
      cacheDir: CACHE_DIR,
    });

    const result = await client.loadManifest();
    expect(result.skills.cached.downloadUrl).toBe("https://r.test/cached");
  });

  test("refresh mode bypasses fresh cache", async () => {
    const oldManifest = makeManifest({ "old": { downloadUrl: "https://r.test/old" } });
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, "manifest.json"), JSON.stringify(oldManifest), "utf-8");

    const newManifest = makeManifest({ "new": { downloadUrl: "https://r.test/new" } });
    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      cacheTtlMs: 999_999,
      now: () => Date.parse(oldManifest.generatedAt) + 1_000,
      fetchImpl: mockFetch(new Map([
        ["https://r.test/manifest.json", { ok: true, body: JSON.stringify(newManifest) }],
      ])),
    });

    const result = await client.loadManifest("refresh");
    expect(result.skills.new).toBeDefined();
    expect(result.skills.old).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// installSkills
// ---------------------------------------------------------------------------

describe("installSkills", () => {
  test("installs SKILL.md files into destination", async () => {
    const manifest = makeManifest({
      "nextjs": { downloadUrl: "https://r.test/skills/nextjs/SKILL.md" },
      "ai-sdk": { downloadUrl: "https://r.test/skills/ai-sdk/SKILL.md" },
    });

    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      fetchImpl: mockFetch(new Map([
        ["https://r.test/manifest.json", { ok: true, body: JSON.stringify(manifest) }],
        ["https://r.test/skills/nextjs/SKILL.md", { ok: true, body: "---\nname: nextjs\n---\n# Next.js" }],
        ["https://r.test/skills/ai-sdk/SKILL.md", { ok: true, body: "---\nname: ai-sdk\n---\n# AI SDK" }],
      ])),
    });

    const result = await client.installSkills(["nextjs", "ai-sdk"], DEST_DIR);
    expect(result.installed).toEqual(["ai-sdk", "nextjs"]);
    expect(result.reused).toEqual([]);
    expect(result.missing).toEqual([]);

    expect(readFileSync(join(DEST_DIR, "nextjs", "SKILL.md"), "utf-8")).toContain("# Next.js");
    expect(readFileSync(join(DEST_DIR, "ai-sdk", "SKILL.md"), "utf-8")).toContain("# AI SDK");
  });

  test("reuses existing identical SKILL.md", async () => {
    const skillContent = "---\nname: nextjs\n---\n# Next.js";
    // Pre-seed destination
    mkdirSync(join(DEST_DIR, "nextjs"), { recursive: true });
    writeFileSync(join(DEST_DIR, "nextjs", "SKILL.md"), skillContent, "utf-8");

    const manifest = makeManifest({
      "nextjs": { downloadUrl: "https://r.test/skills/nextjs/SKILL.md" },
    });

    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      fetchImpl: mockFetch(new Map([
        ["https://r.test/manifest.json", { ok: true, body: JSON.stringify(manifest) }],
        ["https://r.test/skills/nextjs/SKILL.md", { ok: true, body: skillContent }],
      ])),
    });

    const result = await client.installSkills(["nextjs"], DEST_DIR);
    expect(result.installed).toEqual([]);
    expect(result.reused).toEqual(["nextjs"]);
    expect(result.missing).toEqual([]);
  });

  test("reports missing skills not in manifest", async () => {
    const manifest = makeManifest({
      "nextjs": { downloadUrl: "https://r.test/skills/nextjs/SKILL.md" },
    });

    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      fetchImpl: mockFetch(new Map([
        ["https://r.test/manifest.json", { ok: true, body: JSON.stringify(manifest) }],
        ["https://r.test/skills/nextjs/SKILL.md", { ok: true, body: "# Next.js" }],
      ])),
    });

    const result = await client.installSkills(["nextjs", "nonexistent"], DEST_DIR);
    expect(result.installed).toEqual(["nextjs"]);
    expect(result.missing).toEqual(["nonexistent"]);
  });

  test("reports missing when download fails", async () => {
    const manifest = makeManifest({
      "broken": { downloadUrl: "https://r.test/skills/broken/SKILL.md" },
    });

    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      fetchImpl: mockFetch(new Map([
        ["https://r.test/manifest.json", { ok: true, body: JSON.stringify(manifest) }],
        ["https://r.test/skills/broken/SKILL.md", { ok: false, body: "", status: 404 }],
      ])),
    });

    const result = await client.installSkills(["broken"], DEST_DIR);
    expect(result.installed).toEqual([]);
    expect(result.missing).toEqual(["broken"]);
  });

  test("deduplicates skill names", async () => {
    const manifest = makeManifest({
      "nextjs": { downloadUrl: "https://r.test/skills/nextjs/SKILL.md" },
    });

    let fetchCount = 0;
    const client = createRegistryClient({
      registryManifestUrl: "https://r.test/manifest.json",
      cacheDir: CACHE_DIR,
      fetchImpl: (async (input: RequestInfo | URL) => {
        fetchCount++;
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("manifest")) {
          return { ok: true, status: 200, json: async () => manifest, text: async () => JSON.stringify(manifest) } as Response;
        }
        return { ok: true, status: 200, text: async () => "# Next.js" } as Response;
      }) as typeof fetch,
    });

    const result = await client.installSkills(["nextjs", "nextjs", "nextjs"], DEST_DIR);
    expect(result.installed).toEqual(["nextjs"]);
    // 1 manifest fetch + 1 skill fetch (not 3)
    expect(fetchCount).toBe(2);
  });
});
