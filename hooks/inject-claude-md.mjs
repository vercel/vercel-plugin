#!/usr/bin/env node
import { join } from "node:path";
import { pluginRoot, safeReadFile } from "./hook-env.mjs";
const content = safeReadFile(join(pluginRoot(), "vercel.md"));
if (content !== null) {
  process.stdout.write(content);
}
