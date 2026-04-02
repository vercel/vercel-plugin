// hooks/src/registry-client.mts
import { execFile } from "child_process";
import { promisify } from "util";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
import { readProjectSkillState } from "./project-skill-manifest.mjs";
import {
  ensureProjectStateRoot,
  resolveProjectStatePaths
} from "./project-state-paths.mjs";
import { canonicalizeInstalledSkillNames } from "./registry-skill-metadata.mjs";
var execFileAsync = promisify(execFile);
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function formatCommandWithCwd(command, cwd) {
  if (!command) return null;
  return cwd && cwd.trim() !== "" ? `cd ${shellQuote(cwd)} && ${command}` : command;
}
function listProjectCachedSkills(projectRoot) {
  const state = readProjectSkillState(projectRoot);
  return canonicalizeInstalledSkillNames(state.installedSlugs);
}
function createRegistryClient(options = {}) {
  const execFileImpl = options.execFileImpl ?? execFileAsync;
  const timeoutMs = options.timeoutMs ?? 1e4;
  const agent = options.agent ?? "claude-code";
  const source = options.source;
  return {
    async installSkills(args) {
      const statePaths = ensureProjectStateRoot(
        resolveProjectStatePaths(args.projectRoot)
      );
      const before = new Set(listProjectCachedSkills(args.projectRoot));
      const resolvedSource = typeof args.source === "string" && args.source.trim() !== "" ? args.source : source;
      const requestedEntries = [
        ...new Map(
          (args.installTargets ?? args.skillNames.map((skillName) => ({
            requestedName: skillName,
            installName: skillName
          }))).map((target) => ({
            requestedName: target.requestedName.trim(),
            installName: target.installName.trim()
          })).filter((target) => target.requestedName && target.installName).map((target) => [target.requestedName, target])
        ).values()
      ].sort((left, right) => left.requestedName.localeCompare(right.requestedName));
      const commandSkills = requestedEntries.map((entry) => entry.installName);
      const command = buildSkillsAddCommand(
        resolvedSource,
        commandSkills,
        agent
      );
      if (!command) {
        const requested2 = requestedEntries.map((entry) => entry.requestedName);
        return {
          installed: [],
          reused: [],
          missing: requested2,
          command: null,
          commandCwd: null
        };
      }
      try {
        await execFileImpl(command.file, command.args, {
          cwd: statePaths.stateRoot,
          timeout: timeoutMs,
          env: { ...process.env, CI: "1" },
          maxBuffer: 1024 * 1024
        });
      } catch {
      }
      const after = new Set(listProjectCachedSkills(args.projectRoot));
      const requested = requestedEntries.map((entry) => entry.requestedName);
      return {
        installed: requested.filter(
          (skill) => after.has(skill) && !before.has(skill)
        ),
        reused: requested.filter(
          (skill) => after.has(skill) && before.has(skill)
        ),
        missing: requested.filter((skill) => !after.has(skill)),
        command: command.printable,
        commandCwd: statePaths.stateRoot
      };
    }
  };
}
export {
  createRegistryClient,
  formatCommandWithCwd
};
