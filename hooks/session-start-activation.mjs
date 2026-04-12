// hooks/src/session-start-activation.mts
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { safeReadJson } from "./hook-env.mjs";
var ACTIVATION_MARKER_FILES = [
  "vercel.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.mts"
];
function readPackageJson(projectRoot) {
  return safeReadJson(join(projectRoot, "package.json"));
}
function packageJsonSignalsVercel(projectRoot) {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return false;
  const allDeps = {
    ...pkg.dependencies || {},
    ...pkg.devDependencies || {}
  };
  if (Object.keys(allDeps).some(
    (dep) => dep === "next" || dep === "vercel" || dep.startsWith("@vercel/")
  )) {
    return true;
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  return Object.values(scripts).some(
    (value) => typeof value === "string" && /\bvercel\b/.test(value)
  );
}
function hasSessionStartActivationMarkers(projectRoot) {
  if (ACTIVATION_MARKER_FILES.some((file) => existsSync(join(projectRoot, file)))) {
    return true;
  }
  if (existsSync(join(projectRoot, ".vercel"))) {
    return true;
  }
  return packageJsonSignalsVercel(projectRoot);
}
function isGreenfieldDirectory(projectRoot) {
  let dirents;
  try {
    dirents = readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  const hasNonDotDir = dirents.some((d) => !d.name.startsWith("."));
  const hasDotFile = dirents.some((d) => d.name.startsWith(".") && d.isFile());
  return !hasNonDotDir && !hasDotFile;
}
export {
  hasSessionStartActivationMarkers,
  isGreenfieldDirectory
};
