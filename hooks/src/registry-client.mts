/**
 * Registry Client — delegate skill installation to `npx skills add`.
 *
 * Instead of fetching SKILL.md files over HTTP, this module shells out
 * to the real `npx skills` CLI. Install results are inferred from
 * filesystem state (`.skills/<slug>/SKILL.md`) before and after execution.
 *
 * No test performs a real subprocess call — the execFile implementation
 * is injectable and mockable via the `execFileImpl` option.
 */

import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallSkillsArgs {
  projectRoot: string;
  skillNames: string[];
}

export interface InstallSkillsResult {
  installed: string[];
  reused: string[];
  missing: string[];
  command: string | null;
}

export interface RegistryClientOptions {
  source?: string;
  agent?: string;
  timeoutMs?: number;
  /** Injectable execFile for testing — no real CLI execution in tests. */
  execFileImpl?: (
    file: string,
    args: string[],
    options: {
      cwd?: string;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
      maxBuffer?: number;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface RegistryClient {
  installSkills(args: InstallSkillsArgs): Promise<InstallSkillsResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listProjectCachedSkills(projectRoot: string): string[] {
  const skillsRoot = join(projectRoot, ".skills");
  try {
    return readdirSync(skillsRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(skillsRoot, entry.name, "SKILL.md")),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistryClient(
  options: RegistryClientOptions = {},
): RegistryClient {
  const execFileImpl = options.execFileImpl ?? execFileAsync;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const agent = options.agent ?? "claude-code";
  const source = options.source;

  return {
    async installSkills(
      args: InstallSkillsArgs,
    ): Promise<InstallSkillsResult> {
      const before = new Set(listProjectCachedSkills(args.projectRoot));
      const command = buildSkillsAddCommand(
        source,
        args.skillNames,
        agent,
      );

      if (!command) {
        const requested = [
          ...new Set(args.skillNames.map((s) => s.trim()).filter(Boolean)),
        ].sort();
        return {
          installed: [],
          reused: [],
          missing: requested,
          command: null,
        };
      }

      try {
        await execFileImpl(command.file, command.args, {
          cwd: args.projectRoot,
          timeout: timeoutMs,
          env: { ...process.env, CI: "1" },
          maxBuffer: 1024 * 1024,
        });
      } catch {
        // Infer result from post-run filesystem state instead of parsing CLI text.
      }

      const after = new Set(listProjectCachedSkills(args.projectRoot));
      const requested = [
        ...new Set(args.skillNames.map((s) => s.trim()).filter(Boolean)),
      ].sort();

      return {
        installed: requested.filter(
          (skill) => after.has(skill) && !before.has(skill),
        ),
        reused: requested.filter(
          (skill) => after.has(skill) && before.has(skill),
        ),
        missing: requested.filter((skill) => !after.has(skill)),
        command: command.printable,
      };
    },
  };
}
