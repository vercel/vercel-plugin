#!/usr/bin/env bun

import { YAML } from "bun";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileTemplate } from "./build-from-skills";

const ROOT = resolve(import.meta.dir, "..");

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  }).sort();
}

function copyRuntime(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (["upstream", "overlay.yaml", ".DS_Store", ".vercel.approvers"].includes(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyRuntime(from, to);
    else if (entry.isFile() && !entry.name.endsWith(".tmpl")) cpSync(from, to);
  }
}

function run(command: string, args: string[], cwd: string, input?: string): void {
  const result = spawnSync(command, args, {
    cwd, input, encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  }
}

export function buildOpenAI(root = ROOT, output = join(root, "dist", "openai")) {
  const configDir = join(root, "openai");
  const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as {
    excludedSkills: string[];
    skillInterfaces: Record<string, Record<string, string>>;
  };
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error("Expected a package version suitable for the submission filename");
  }
  const staging = mkdtempSync(join(tmpdir(), "vercel-openai-build-"));
  const plugin = join(staging, "vercel");
  try {
    mkdirSync(join(plugin, "skills"), { recursive: true });
    const skills = readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(root, "skills", entry.name, "SKILL.md")))
      .map(entry => entry.name)
      .filter(name => !config.excludedSkills.includes(name)).sort();
    for (const name of skills) {
      if (!config.skillInterfaces[name]) throw new Error(`Missing OpenAI display metadata for ${name}`);
      copyRuntime(join(root, "skills", name), join(plugin, "skills", name));
    }
    for (const directory of ["agents", "commands"]) {
      mkdirSync(join(plugin, directory));
      for (const entry of readdirSync(join(root, directory))) {
        if (entry.endsWith(".md") || entry.endsWith(".md.tmpl")) {
          cpSync(join(root, directory, entry), join(plugin, directory, entry));
        }
      }
    }
    for (const file of ["vercel.md", "LICENSE"]) cpSync(join(root, file), join(plugin, file));

    // Fail when upstream edits conflict with a submission adaptation; never silently drop it.
    const patch = join(configDir, "content.patch");
    run("git", ["apply", "--check", patch], plugin);
    run("git", ["apply", patch], plugin);
    for (const directory of ["agents", "commands"]) {
      for (const entry of readdirSync(join(plugin, directory))) {
        if (!entry.endsWith(".md.tmpl")) continue;
        const template = join(plugin, directory, entry);
        const result = compileTemplate(template, { skillsDir: join(plugin, "skills") });
        if (result.diagnostics.length) {
          throw new Error(`Unresolved template ${entry}: ${result.diagnostics.map(d => d.message).join("; ")}`);
        }
        let content = result.output;
        if (entry === "deployment-expert.md.tmpl") {
          content = content.replaceAll("(references/", "(../skills/deployments-cicd/references/");
        }
        writeFileSync(template.replace(/\.tmpl$/, ""), content);
        rmSync(template);
      }
    }
    for (const name of skills) {
      const directory = join(plugin, "skills", name, "agents");
      mkdirSync(directory, { recursive: true });
      const fields = Object.entries(config.skillInterfaces[name])
        .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join("\n");
      writeFileSync(join(directory, "openai.yaml"), `interface:\n${fields}\n`);
      const content = readFileSync(join(plugin, "skills", name, "SKILL.md"), "utf8");
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const metadata = frontmatter && YAML.parse(frontmatter[1]) as { name: string; description: string };
      if (!metadata || metadata.name !== name || !metadata.description) {
        throw new Error(`Invalid skill frontmatter: ${name}`);
      }
      for (const match of content.matchAll(/⤳ skill: ([a-z0-9-]+)/g)) {
        if (!skills.includes(match[1])) throw new Error(`${name} refers to excluded skill ${match[1]}`);
      }
    }
    const manifest = { ...JSON.parse(readFileSync(join(configDir, "plugin.json"), "utf8")), version };
    mkdirSync(join(plugin, ".codex-plugin"));
    writeFileSync(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    delete mcp.mcpServers.vercel.note;
    writeFileSync(join(plugin, ".mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
    cpSync(join(configDir, "assets"), join(plugin, "assets"), { recursive: true });
    writeFileSync(join(plugin, "README.md"), readFileSync(join(configDir, "README.md"), "utf8")
      .replaceAll("{{version}}", version).replaceAll("{{skills}}", String(skills.length)));
    for (const path of [manifest.skills, manifest.mcpServers, manifest.interface.composerIcon, manifest.interface.logo]) {
      if (!existsSync(join(plugin, path))) throw new Error(`Missing manifest path: ${path}`);
    }
    if (manifest.hooks || manifest.apps || manifest.commands || manifest.agents) {
      throw new Error("OpenAI manifest must not register hooks, apps, commands, or agents");
    }
    const files = filesIn(plugin);
    // Fixed timestamps and sorted entries make identical source produce an identical ZIP.
    for (const file of files) {
      if (!statSync(file).isFile()) throw new Error(`Expected a regular runtime file: ${file}`);
      utimesSync(file, new Date("1980-01-01T00:00:00Z"), new Date("1980-01-01T00:00:00Z"));
    }
    const zipName = `vercel-${version}.zip`;
    run("zip", ["-X", "-q", join(staging, zipName), "-@"], staging,
      files.map(file => file.slice(staging.length + 1)).join("\n") + "\n");
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    cpSync(plugin, join(output, "vercel"), { recursive: true });
    cpSync(join(staging, zipName), join(output, zipName));
    return { directory: join(output, "vercel"), zip: join(output, zipName), skills: skills.length, files: files.length };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = buildOpenAI();
  console.log(`Built ${result.skills} skills, ${result.files} files: ${result.zip}`);
}
