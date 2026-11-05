import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { buildOpenAI } from "../scripts/build-openai";

const ROOT = resolve(import.meta.dir, "..");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// Source files the package must ship: everything except authoring-only copies and approver lists.
function runtimeFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (["upstream", "overlay.yaml", ".vercel.approvers", ".DS_Store"].includes(entry.name) || entry.name.endsWith(".tmpl")) return [];
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? runtimeFiles(join(directory, entry.name), path) : [path];
  });
}

describe("OpenAI submission build", () => {
  let fixture: string;
  type Config = { excludedSkills: string[]; skillInterfaces: Record<string, Record<string, string>> };
  const updateConfig = (change: (config: Config) => void) => {
    const path = join(fixture, "openai/config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as Config;
    change(config);
    writeFileSync(path, JSON.stringify(config));
  };
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "vercel-openai-test-"));
    for (const entry of ["package.json", ".mcp.json", "vercel.md", "LICENSE", "skills", "agents", "commands", "openai"]) {
      cpSync(join(ROOT, entry), join(fixture, entry), { recursive: true });
    }
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  test("packages runtime files, dotfiles, metadata, and the submission adaptations", () => {
    mkdirSync(join(fixture, "skills", "excluded-skill"));
    writeFileSync(join(fixture, "skills", "excluded-skill", "SKILL.md"), "---\nname: excluded-skill\ndescription: Excluded skill\n---\n");
    updateConfig(config => { config.excludedSkills = ["excluded-skill"]; });
    writeFileSync(join(fixture, ".env"), "local data that must not be packaged");
    const sourceSkills = ["deployments-cicd", "vercel-cli", "knowledge-update"];
    const sourceHashes = sourceSkills.map(name => hash(join(fixture, "skills", name, "SKILL.md")));
    const result = buildOpenAI(fixture);
    const repositorySkills = readdirSync(join(ROOT, "skills"))
      .filter(name => existsSync(join(ROOT, "skills", name, "SKILL.md"))).sort();
    expect(repositorySkills).toEqual(expect.arrayContaining(["daemons", "vercel-flags"]));
    const entries = execFileSync("unzip", ["-Z1", result.zip], { encoding: "utf8" }).trim().split("\n");
    const packagedSkills = entries.flatMap(path => path.match(/^vercel\/skills\/([^/]+)\/SKILL\.md$/)?.[1] ?? []).sort();
    expect(packagedSkills).toEqual(repositorySkills);
    expect(result.skills).toBe(repositorySkills.length);
    expect(entries).toHaveLength(result.files);
    for (const name of repositorySkills) {
      expect(entries).toContain(`vercel/skills/${name}/agents/openai.yaml`);
      for (const file of runtimeFiles(join(ROOT, "skills", name))) expect(entries).toContain(`vercel/skills/${name}/${file}`);
    }
    expect(readFileSync(join(result.directory, "skills/daemons/agents/openai.yaml"), "utf8")).toBe(
      'interface:\n  display_name: "Vercel Daemons"\n  short_description: "Run long-running background workers on Vercel"\n',
    );
    expect(entries).toContain("vercel/.codex-plugin/plugin.json");
    expect(entries).toContain("vercel/.mcp.json");
    expect(entries.every(path => path.startsWith("vercel/"))).toBe(true);
    expect(entries.some(path => /(?:hooks\/|upstream\/|\.tmpl$|overlay\.yaml$|\.vercel\.approvers$|\.app\.json$|skills\/excluded-skill\/|\.env$)/.test(path))).toBe(false);
    const extracted = join(fixture, "extracted");
    execFileSync("unzip", ["-q", result.zip, "-d", extracted]);
    for (const path of entries) {
      expect(readFileSync(join(extracted, path))).toEqual(readFileSync(join(result.directory, path.slice("vercel/".length))));
    }
    const manifest = JSON.parse(readFileSync(join(result.directory, ".codex-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("vercel");
    expect(manifest.author.name).toBe("Vercel");
    expect(manifest.interface.developerName).toBe("Vercel");
    expect(manifest).not.toHaveProperty("hooks");
    expect(manifest).not.toHaveProperty("commands");
    expect(manifest).not.toHaveProperty("agents");
    expect(readFileSync(join(result.directory, "skills/eve/SKILL.md"), "utf8")).toContain("part of the user's requested setup");
    expect(readFileSync(join(result.directory, "skills/deployments-cicd/references/deployment-checks.md"), "utf8")).toContain("maxRedirects: 0");
    expect(readFileSync(join(result.directory, "agents/deployment-expert.md"), "utf8")).toContain("../skills/deployments-cicd/references/deployment-checks.md");
    expect(readFileSync(join(result.directory, "skills/ai-sdk/SKILL.md"), "utf8")).toContain("maxSteps was removed in AI SDK 5");
    expect(readFileSync(join(result.directory, "vercel.md"), "utf8")).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    const deploymentSkill = readFileSync(join(result.directory, "skills/deployments-cicd/SKILL.md"), "utf8");
    const metadata = YAML.parse(deploymentSkill.match(/^---\n([\s\S]*?)\n---/)![1]);
    expect(metadata.description).toContain("show the build");
    expect(metadata.retrieval.intents).toContain("show build logs inline");
    const liveGuide = readFileSync(join(result.directory, "skills/deployments-cicd/references/live-status.md"), "utf8");
    expect(liveGuide).toContain("`open_deployments` for the live inline card");
    expect(liveGuide).toContain("different authentication and team grants");
    expect(liveGuide).toContain("Runtime logs or grouped runtime errors");
    for (const name of ["vercel-cli", "knowledge-update"]) {
      expect(readFileSync(join(result.directory, "skills", name, "SKILL.md"), "utf8")).toContain("open_deployments");
    }
    expect(sourceSkills.map(name => hash(join(fixture, "skills", name, "SKILL.md")))).toEqual(sourceHashes);
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

  test("rejects skill descriptions that Codex would not show in full instead of truncating them", () => {
    const tooLong = "Authentication integration guidance for Clerk, Descope, and Auth0 setup";
    updateConfig(config => { config.skillInterfaces.auth.short_description = tooLong; });
    expect(() => buildOpenAI(fixture)).toThrow("Invalid OpenAI display metadata for auth: short_description must be 25-64 characters (got 71)");
    updateConfig(config => { config.skillInterfaces.auth.short_description = "Authentication integration guidance for Next...."; });
    expect(() => buildOpenAI(fixture)).toThrow("Invalid OpenAI display metadata for auth: short_description looks truncated");
    expect(existsSync(join(fixture, "dist/openai"))).toBe(false);
  });

  test("accepts metadata for a skill before the skill itself lands", () => {
    updateConfig(config => {
      config.skillInterfaces["future-skill"] = { display_name: "Future Skill", short_description: "Metadata that lands before its skill" };
    });
    const result = buildOpenAI(fixture);
    const entries = execFileSync("unzip", ["-Z1", result.zip], { encoding: "utf8" }).trim().split("\n");
    expect(entries.some(path => path.startsWith("vercel/skills/future-skill/"))).toBe(false);
  });
});
