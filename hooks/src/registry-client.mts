/**
 * Registry Client — delegate skill installation to `npx skills add`.
 *
 * Instead of fetching SKILL.md files over HTTP, this module shells out
 * to the real `npx skills` CLI. Install results are derived from the
 * canonical project skill state (`skills-lock.json` → directory scan)
 * before and after execution, matching the injection read path.
 *
 * No test performs a real subprocess call — the execFile implementation
 * is injectable and mockable via the `execFileImpl` option.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
import { readProjectSkillState } from "./project-skill-manifest.mjs";
import {
  ensureProjectStateRoot,
  resolveProjectStatePaths,
} from "./project-state-paths.mjs";
import { canonicalizeInstalledSkillNames } from "./registry-skill-metadata.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallSkillsArgs {
  projectRoot: string;
  skillNames: string[];
  source?: string;
  installTargets?: Array<{
    requestedName: string;
    installName: string;
  }>;
}

export interface InstallSkillsResult {
  installed: string[];
  reused: string[];
  missing: string[];
  command: string | null;
  commandCwd: string | null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatCommandWithCwd(
  command: string | null,
  cwd: string | null,
): string | null {
  if (!command) return null;
  return cwd && cwd.trim() !== ""
    ? `cd ${shellQuote(cwd)} && ${command}`
    : command;
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

/**
 * Derive installed skill slugs from the canonical project skill state.
 *
 * Uses `readProjectSkillState()` which prefers `skills-lock.json` over
 * directory scanning — so install accounting stays consistent with the
 * injection read path even when the CLI writes a lockfile before all
 * `.skills/<slug>/SKILL.md` directories are fully materialised.
 */
function listProjectCachedSkills(projectRoot: string): string[] {
  const state = readProjectSkillState(projectRoot);
  return canonicalizeInstalledSkillNames(state.installedSlugs);
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
      const statePaths = ensureProjectStateRoot(
        resolveProjectStatePaths(args.projectRoot),
      );
      const before = new Set(listProjectCachedSkills(args.projectRoot));
      const resolvedSource =
        typeof args.source === "string" && args.source.trim() !== ""
          ? args.source
          : source;
      const requestedEntries = [
        ...new Map(
          (args.installTargets ?? args.skillNames.map((skillName) => ({
            requestedName: skillName,
            installName: skillName,
          })))
            .map((target) => ({
              requestedName: target.requestedName.trim(),
              installName: target.installName.trim(),
            }))
            .filter((target) => target.requestedName && target.installName)
            .map((target) => [target.requestedName, target] as const),
        ).values(),
      ].sort((left, right) => left.requestedName.localeCompare(right.requestedName));
      const commandSkills = requestedEntries.map((entry) => entry.installName);
      const command = buildSkillsAddCommand(
        resolvedSource,
        commandSkills,
        agent,
      );

      if (!command) {
        const requested = requestedEntries.map((entry) => entry.requestedName);
        return {
          installed: [],
          reused: [],
          missing: requested,
          command: null,
          commandCwd: null,
        };
      }

      // Run from the project root so `npx skills add --copy` installs into
      // <projectRoot>/.claude/skills/ where the Skill() tool can find them.
      const installCwd = resolve(args.projectRoot);

      try {
        await execFileImpl(command.file, command.args, {
          cwd: installCwd,
          timeout: timeoutMs,
          env: { ...process.env, CI: "1" },
          maxBuffer: 1024 * 1024,
        });
      } catch {
        // Infer result from post-run filesystem state instead of parsing CLI text.
      }

      const after = new Set(listProjectCachedSkills(args.projectRoot));
      const requested = requestedEntries.map((entry) => entry.requestedName);

      return {
        installed: requested.filter(
          (skill) => after.has(skill) && !before.has(skill),
        ),
        reused: requested.filter(
          (skill) => after.has(skill) && before.has(skill),
        ),
        missing: requested.filter((skill) => !after.has(skill)),
        command: command.printable,
        commandCwd: installCwd,
      };
    },
  };
}
