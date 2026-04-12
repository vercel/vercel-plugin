import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { safeReadJson } from "./hook-env.mjs";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, unknown>;
}

const ACTIVATION_MARKER_FILES: string[] = [
  "vercel.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.mts",
];

function readPackageJson(projectRoot: string): PackageJson | null {
  return safeReadJson<PackageJson>(join(projectRoot, "package.json"));
}

function packageJsonSignalsVercel(projectRoot: string): boolean {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return false;

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  if (Object.keys(allDeps).some((dep: string) =>
    dep === "next" || dep === "vercel" || dep.startsWith("@vercel/"),
  )) {
    return true;
  }

  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  return Object.values(scripts).some((value: unknown) =>
    typeof value === "string" && /\bvercel\b/.test(value),
  );
}

export function hasSessionStartActivationMarkers(projectRoot: string): boolean {
  if (ACTIVATION_MARKER_FILES.some((file: string) => existsSync(join(projectRoot, file)))) {
    return true;
  }

  if (existsSync(join(projectRoot, ".vercel"))) {
    return true;
  }

  return packageJsonSignalsVercel(projectRoot);
}

export function isGreenfieldDirectory(projectRoot: string): boolean {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return false;
  }

  const hasNonDotDir = dirents.some((d: Dirent) => !d.name.startsWith("."));
  const hasDotFile = dirents.some((d: Dirent) => d.name.startsWith(".") && d.isFile());
  return !hasNonDotDir && !hasDotFile;
}
