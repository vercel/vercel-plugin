import { describe, expect, test } from "bun:test";
import {
  buildVercelCliCommand,
  vercelSubcommands,
  type VercelSubcommand,
} from "../hooks/src/vercel-cli-command.mts";

// ---------------------------------------------------------------------------
// buildVercelCliCommand
// ---------------------------------------------------------------------------

describe("buildVercelCliCommand", () => {
  test("env-pull produces vercel env pull --yes", () => {
    const cmd = buildVercelCliCommand("env-pull");
    expect(cmd.args).toEqual(["env", "pull", "--yes"]);
    expect(cmd.printable).toBe("vercel env pull --yes");
    expect(cmd.file).toBe(process.platform === "win32" ? "vercel.cmd" : "vercel");
  });

  test("link produces vercel link --yes", () => {
    const cmd = buildVercelCliCommand("link");
    expect(cmd.args).toEqual(["link", "--yes"]);
    expect(cmd.printable).toBe("vercel link --yes");
  });

  test("deploy produces vercel deploy (no --yes)", () => {
    const cmd = buildVercelCliCommand("deploy");
    expect(cmd.args).toEqual(["deploy"]);
    expect(cmd.printable).toBe("vercel deploy");
  });

  test("extra flags are appended after default flags", () => {
    const cmd = buildVercelCliCommand("env-pull", {
      flags: ["--environment", "production"],
    });
    expect(cmd.args).toEqual(["env", "pull", "--yes", "--environment", "production"]);
    expect(cmd.printable).toBe("vercel env pull --yes --environment production");
  });

  test("custom binary overrides file but printable always uses vercel", () => {
    const cmd = buildVercelCliCommand("link", { binary: "/usr/local/bin/vercel" });
    expect(cmd.file).toBe("/usr/local/bin/vercel");
    expect(cmd.printable).toBe("vercel link --yes");
  });

  test("all subcommands produce non-empty args", () => {
    for (const sub of vercelSubcommands()) {
      const cmd = buildVercelCliCommand(sub);
      expect(cmd.args.length).toBeGreaterThan(0);
      expect(cmd.printable.startsWith("vercel ")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// vercelSubcommands
// ---------------------------------------------------------------------------

describe("vercelSubcommands", () => {
  test("returns env-pull, link, deploy", () => {
    const subs = vercelSubcommands();
    expect(subs).toContain("env-pull");
    expect(subs).toContain("link");
    expect(subs).toContain("deploy");
    expect(subs.length).toBe(3);
  });
});
