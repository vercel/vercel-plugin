import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

// Content-contract guards for the vercel-storage skill's Blob guidance. The
// private-read API is easy to get wrong (it takes a pathname plus a required
// `access` option and returns a result object, not a stream), and the product
// status matters because agents copy it verbatim.

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_PATH = resolve(ROOT, "skills/vercel-storage/SKILL.md");

let skill: string;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  expect(skills["vercel-storage"]).toBeDefined();
  skill = readFileSync(SKILL_PATH, "utf8");
});

describe("vercel-storage Blob guidance", () => {
  test("reads private blobs by pathname with a required access option", () => {
    expect(skill).toContain("await get('docs/secret.pdf', { access: 'private' })");
    expect(skill).toContain("privateFile?.statusCode === 200");
    expect(skill).not.toMatch(/get\(privateBlob\.url\)/);
    // Every Blob get() call passes the required `access` option, including
    // brace-less calls like `get(blob.url)` that the old text used. Scope to
    // the @vercel/blob code block so Global Config's get(key) is not counted.
    const blobBlock = skill.match(/```ts\nimport \{ put, del, list, get \} from '@vercel\/blob'[\s\S]*?\n```/)?.[0];
    expect(blobBlock).toBeDefined();
    const getCalls = blobBlock!.match(/await get\([\s\S]*?\)\n/g) ?? [];
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of getCalls) {
      expect(call).toMatch(/access:\s*'(private|public)'/);
    }
  });

  test("describes Private Storage as generally available with OIDC by default", () => {
    expect(skill).toContain("**Private Storage** (generally available)");
    expect(skill).not.toContain("**Private Storage** (public beta)");
    expect(skill).toContain("vercel blob create-store <name> --access private");
    expect(skill).toContain("BLOB_STORE_ID");
    expect(skill).toContain("presignUrl()");
  });
});
