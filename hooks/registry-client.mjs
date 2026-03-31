// hooks/src/registry-client.mts
import { existsSync, readdirSync } from "fs";
import { execFile } from "child_process";
import { join } from "path";
import { promisify } from "util";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
var execFileAsync = promisify(execFile);
function listProjectCachedSkills(projectRoot) {
  const skillsRoot = join(projectRoot, ".skills");
  try {
    return readdirSync(skillsRoot, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md"))
    ).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
function createRegistryClient(options = {}) {
  const execFileImpl = options.execFileImpl ?? execFileAsync;
  const timeoutMs = options.timeoutMs ?? 1e4;
  const agent = options.agent ?? "claude-code";
  const source = options.source;
  return {
    async installSkills(args) {
      const before = new Set(listProjectCachedSkills(args.projectRoot));
      const command = buildSkillsAddCommand(
        source,
        args.skillNames,
        agent
      );
      if (!command) {
        const requested2 = [
          ...new Set(args.skillNames.map((s) => s.trim()).filter(Boolean))
        ].sort();
        return {
          installed: [],
          reused: [],
          missing: requested2,
          command: null
        };
      }
      try {
        await execFileImpl(command.file, command.args, {
          cwd: args.projectRoot,
          timeout: timeoutMs,
          env: { ...process.env, CI: "1" },
          maxBuffer: 1024 * 1024
        });
      } catch {
      }
      const after = new Set(listProjectCachedSkills(args.projectRoot));
      const requested = [
        ...new Set(args.skillNames.map((s) => s.trim()).filter(Boolean))
      ].sort();
      return {
        installed: requested.filter(
          (skill) => after.has(skill) && !before.has(skill)
        ),
        reused: requested.filter(
          (skill) => after.has(skill) && before.has(skill)
        ),
        missing: requested.filter((skill) => !after.has(skill)),
        command: command.printable
      };
    }
  };
}
export {
  createRegistryClient
};
