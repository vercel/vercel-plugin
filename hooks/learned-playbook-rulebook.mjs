// hooks/src/learned-playbook-rulebook.mts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createLogger } from "./logger.mjs";
function playbookRulebookPath(projectRoot) {
  return join(projectRoot, "generated", "learned-playbooks.json");
}
function createEmptyPlaybookRulebook(projectRoot, generatedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    version: 1,
    generatedAt,
    projectRoot,
    rules: [],
    replay: {
      baselineWins: 0,
      learnedWins: 0,
      deltaWins: 0,
      regressions: []
    },
    promotion: {
      accepted: true,
      errorCode: null,
      reason: "No promoted playbooks"
    }
  };
}
function savePlaybookRulebook(projectRoot, rulebook) {
  const path = playbookRulebookPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rulebook, null, 2) + "\n");
  createLogger().summary("learned-playbook-rulebook.save", {
    path,
    ruleCount: rulebook.rules.length,
    promotedCount: rulebook.rules.filter((r) => r.confidence === "promote").length
  });
}
function loadPlaybookRulebook(projectRoot) {
  const path = playbookRulebookPath(projectRoot);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || typeof parsed.generatedAt !== "string" || typeof parsed.projectRoot !== "string" || !Array.isArray(parsed.rules) || typeof parsed.replay !== "object" || typeof parsed.promotion !== "object") {
      return {
        ok: false,
        error: {
          code: "EINVALID",
          message: `Invalid learned playbook rulebook at ${path}`
        }
      };
    }
    return { ok: true, rulebook: parsed };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        ok: false,
        error: {
          code: "ENOENT",
          message: `No learned playbook rulebook found at ${path}`
        }
      };
    }
    return {
      ok: false,
      error: {
        code: "EINVALID",
        message: `Failed to read learned playbook rulebook at ${path}`
      }
    };
  }
}
export {
  createEmptyPlaybookRulebook,
  loadPlaybookRulebook,
  playbookRulebookPath,
  savePlaybookRulebook
};
