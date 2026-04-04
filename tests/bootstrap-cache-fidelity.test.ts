import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectStatePaths } from "../hooks/src/project-state-paths.mts";
import {
  resolveSessionStartSkillEntries,
  buildTier3Block,
} from "../hooks/src/session-start-engine-context.mts";
import {
  buildMinimalContext,
  buildStandardContext,
} from "../hooks/src/subagent-start-bootstrap.mts";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, snapshot);
}

describe("bootstrap cache fidelity", () => {
  let tempRoot: string;
  let pluginRoot: string;
  let projectRoot: string;
  let homeRoot: string;
  let envSnapshot: NodeJS.ProcessEnv;
  let cwdSnapshot: string;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    cwdSnapshot = process.cwd();

    tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "vercel-plugin-bootstrap-")));
    pluginRoot = join(tempRoot, "plugin");
    projectRoot = join(tempRoot, "project");
    homeRoot = join(tempRoot, "home");

    mkdirSync(join(pluginRoot, "generated"), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    process.env.VERCEL_PLUGIN_HOME_DIR = homeRoot;
    process.chdir(projectRoot);

    // Write a minimal rules manifest that knows about ai-sdk
    writeJson(join(pluginRoot, "generated", "skill-rules.json"), {
      version: 3,
      generatedAt: "2026-04-04T00:00:00.000Z",
      skills: {
        "ai-sdk": {
          priority: 8,
          summary: "Build AI features with the AI SDK.",
          sessionStartEligible: "body",
          hasRealBody: true,
          pathPatterns: [],
          pathRegexSources: [],
          bashPatterns: [],
          bashRegexSources: [],
          importPatterns: [],
          importRegexSources: [],
        },
      },
    });

    // Write the cached skill body into the hashed project cache
    const statePaths = resolveProjectStatePaths(projectRoot);
    mkdirSync(join(statePaths.skillsDir, "ai-sdk"), { recursive: true });
    // Body must be > 100 chars so the sessionStartEligible heuristic resolves to "body"
    // when the live scan path doesn't carry sessionStartEligible from frontmatter.
    const skillBody = [
      "# AI SDK",
      "",
      "Use streamText() for server responses.",
      "Use generateText() for one-shot completions.",
      "Use streamObject() for structured streaming.",
      "Use embed() for vector embeddings.",
      "",
    ].join("\n");
    writeFileSync(
      join(statePaths.skillsDir, "ai-sdk", "SKILL.md"),
      [
        "---",
        "name: ai-sdk",
        "summary: Build AI features with the AI SDK.",
        "---",
        skillBody,
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    restoreEnv(envSnapshot);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("session-start tier 3 resolves body from the layered cache", () => {
    const entries = resolveSessionStartSkillEntries(projectRoot, ["ai-sdk"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.body).toContain("Use streamText()");
    expect(entries[0]?.bodySource).toBe("project-cache");

    const block = buildTier3Block(["ai-sdk"], [], entries);
    expect(block).toContain("### Loaded Skill(ai-sdk)");
    expect(block).toContain("Use streamText()");
  });

  test("subagent bootstrap only reports skills that were actually included", () => {
    const minimal = buildMinimalContext("Explore", ["ai-sdk"]);
    expect(minimal.includedSkills).toEqual([]);

    const standard = buildStandardContext(
      "GeneralPurpose",
      ["ai-sdk"],
      8_000,
    );
    expect(standard.includedSkills).toEqual(["ai-sdk"]);
    expect(standard.context).toContain("Use streamText()");
  });
});
