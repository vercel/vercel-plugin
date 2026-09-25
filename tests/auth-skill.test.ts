import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileSkillPatterns,
  matchBashWithReason,
  matchPathWithReason,
  type CompiledSkillEntry,
} from "../hooks/src/patterns.mts";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

// The auth skill's Next.js examples must use the Next.js 16 proxy.ts
// convention (the routing-middleware skill tells users to migrate off
// middleware.ts), and the skill must activate for proxy.ts files.

const ROOT = resolve(import.meta.dirname, "..");
const AUTH_SKILL = resolve(ROOT, "skills/auth/SKILL.md");
const ENV_SKILL = resolve(ROOT, "skills/env-vars/SKILL.md");
const BOOTSTRAP_SKILL = resolve(ROOT, "skills/bootstrap/SKILL.md");

let compiledAuth: CompiledSkillEntry;
let auth: string;
let envVars: string;
let bootstrap: string;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  expect(skills["auth"]).toBeDefined();
  compiledAuth = compileSkillPatterns({ auth: skills["auth"] })[0];
  auth = readFileSync(AUTH_SKILL, "utf8");
  envVars = readFileSync(ENV_SKILL, "utf8");
  bootstrap = readFileSync(BOOTSTRAP_SKILL, "utf8");
});

describe("auth skill activation", () => {
  test.each(["proxy.ts", "src/proxy.ts", "middleware.ts", "auth.ts"])(
    "matches %s",
    (path) => {
      expect(matchPathWithReason(path, compiledAuth.compiledPaths)).not.toBeNull();
    },
  );

  test.each(["npm install @vercel/kms", "pnpm add @vercel/kms jose", "bun add @vercel/kms"])(
    "matches KMS install: %s",
    (command) => {
      expect(matchBashWithReason(command, compiledAuth.compiledBash)).not.toBeNull();
    },
  );
});

describe("auth skill guidance", () => {
  test("Next.js interception examples use proxy.ts with a proxy export", () => {
    expect(auth).not.toMatch(/^\/\/ middleware\.ts/m);
    expect(auth).not.toMatch(/export (default )?(async )?function middleware\b/);
    expect(auth).toContain("export async function proxy(request: NextRequest)");
    expect(auth).toMatch(/^\/\/ proxy\.ts/m);
  });

  test("covers Vercel's own identity primitives", () => {
    expect(auth).toContain("### Sign in with Vercel");
    expect(auth).toContain("### Vercel Passport");
    expect(auth).toContain("### Vercel KMS");
    expect(auth).toContain("https://kms.vercel.com/<issuerId>/jwks.json");
    expect(auth).toContain("code_challenge_method: 'S256'");
  });
});

describe("env-vars skill guidance", () => {
  test("does not combine development with production/preview in one vercel env add", () => {
    const commandLines = [envVars, bootstrap]
      .flatMap((text) => text.split("\n"))
      // command lines only (optionally piped), not prose
      .filter((line) => /^\s*(\S.*\| )?vercel env add\b/.test(line));
    expect(commandLines.length).toBeGreaterThanOrEqual(5);
    for (const line of commandLines) {
      const command = line.replace(/\s#.*$/, ""); // ignore trailing shell comments
      const targets = command.match(/\b(production|preview|development)\b/g) ?? [];
      const mixesDev = targets.includes("development") && targets.length > 1;
      expect(mixesDev).toBe(false);
    }
  });

  test("never pipes a secret value through echo", () => {
    // echo puts the value in shell history and process arguments; the skill
    // must read secrets from a file (or a variable via printf) instead.
    expect(envVars).not.toMatch(/echo "[^"]*secret[^"]*" \| vercel env (add|update)/i);
    expect(envVars).toContain("vercel env add MY_SECRET production < ./secret.txt");
  });

  test("documents Secret and Config types, their flags, and the update command", () => {
    expect(envVars).toContain("--type secret");
    expect(envVars).toContain("--type config");
    expect(envVars).toContain("--no-sensitive");
    expect(envVars).toContain("Separate Production Secret Values");
    expect(envVars).toMatch(/stored as Secret/);
    expect(envVars).toContain("vercel env update MY_SECRET production");
  });
});
