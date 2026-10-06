import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { buildOpenAI } from "../scripts/build-openai";

const ROOT = resolve(import.meta.dir, "..");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("OpenAI submission build", () => {
  let fixture: string;
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "vercel-openai-test-"));
    for (const entry of ["package.json", ".mcp.json", "vercel.md", "LICENSE", "skills", "agents", "commands", "openai"]) {
      cpSync(join(ROOT, entry), join(fixture, entry), { recursive: true });
    }
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  test("packages runtime files, dotfiles, metadata, and the submission adaptations", () => {
    mkdirSync(join(fixture, "skills", "nextjs"));
    writeFileSync(join(fixture, "skills", "nextjs", "SKILL.md"), "excluded framework skill");
    writeFileSync(join(fixture, ".env"), "local data that must not be packaged");
    const result = buildOpenAI(fixture);
    expect(result.skills).toBe(33);
    expect(result.files).toBe(201);
    const entries = execFileSync("unzip", ["-Z1", result.zip], { encoding: "utf8" }).trim().split("\n");
    expect(entries).toHaveLength(result.files);
    expect(entries).toContain("vercel/.codex-plugin/plugin.json");
    expect(entries).toContain("vercel/.mcp.json");
    expect(entries.every(path => path.startsWith("vercel/"))).toBe(true);
    expect(entries.some(path => /(?:hooks\/|upstream\/|\.tmpl$|overlay\.yaml$|\.vercel\.approvers$|\.app\.json$|skills\/nextjs\/|\.env$)/.test(path))).toBe(false);
    const extracted = join(fixture, "extracted");
    execFileSync("unzip", ["-q", result.zip, "-d", extracted]);
    for (const path of entries) {
      expect(readFileSync(join(extracted, path))).toEqual(readFileSync(join(result.directory, path.slice("vercel/".length))));
    }
    const manifest = JSON.parse(readFileSync(join(result.directory, ".codex-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("vercel");
    expect(manifest).not.toHaveProperty("hooks");
    expect(manifest).not.toHaveProperty("commands");
    expect(manifest).not.toHaveProperty("agents");
    expect(readFileSync(join(result.directory, "skills/eve/SKILL.md"), "utf8")).toContain("part of the user's requested setup");
    expect(readFileSync(join(result.directory, "skills/deployments-cicd/references/deployment-checks.md"), "utf8")).toContain("maxRedirects: 0");
    expect(readFileSync(join(result.directory, "agents/deployment-expert.md"), "utf8")).toContain("../skills/deployments-cicd/references/deployment-checks.md");
    expect(readFileSync(join(result.directory, "skills/ai-sdk/SKILL.md"), "utf8")).toContain("maxSteps was removed in AI SDK 5");
    expect(readFileSync(join(result.directory, "vercel.md"), "utf8")).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  });

  test("includes upstream edits and the source version without changing source files", () => {
    const skill = join(fixture, "skills/auth/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8") + "\nUpstream update must reach the OpenAI package.\n");
    const before = hash(skill);
    const packagePath = join(fixture, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.version = "0.54.2";
    writeFileSync(packagePath, JSON.stringify(pkg));
    const result = buildOpenAI(fixture);
    expect(result.zip.endsWith("vercel-0.54.2.zip")).toBe(true);
    expect(hash(join(result.directory, "skills/auth/SKILL.md"))).toBe(before);
    expect(hash(skill)).toBe(before);
    expect(JSON.parse(readFileSync(join(result.directory, ".codex-plugin/plugin.json"), "utf8")).version).toBe("0.54.2");
    const first = hash(result.zip);
    expect(hash(buildOpenAI(fixture).zip)).toBe(first);
  });

  test("fails on conflicting upstream edits and preserves the last successful artifact", () => {
    const result = buildOpenAI(fixture);
    const before = hash(result.zip);
    const skill = join(fixture, "skills/deployments-cicd/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace("You are an expert in Vercel deployment workflows", "Changed upstream deployment guidance"));
    expect(() => buildOpenAI(fixture)).toThrow("patch does not apply");
    expect(hash(result.zip)).toBe(before);
  });

  test("requires display metadata before including a new upstream skill", () => {
    const skill = join(fixture, "skills/new-product");
    mkdirSync(skill);
    writeFileSync(join(skill, "SKILL.md"), "---\nname: new-product\ndescription: New product\n---\n");
    expect(() => buildOpenAI(fixture)).toThrow("Missing OpenAI display metadata for new-product");
    expect(existsSync(join(fixture, "dist/openai"))).toBe(false);
  });
});
