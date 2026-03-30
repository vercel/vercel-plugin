// hooks/src/learned-companion-rulebook.mts
import { createHash, randomUUID } from "crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLogger } from "./logger.mjs";
function companionRulebookPath(projectRoot) {
  const hash = createHash("sha256").update(projectRoot).digest("hex");
  return `${tmpdir()}/vercel-plugin-learned-companions-${hash}.json`;
}
function serializeCompanionRulebook(rulebook) {
  const sorted = {
    ...rulebook,
    rules: [...rulebook.rules].sort(
      (a, b) => a.scenario.localeCompare(b.scenario) || a.candidateSkill.localeCompare(b.candidateSkill) || a.companionSkill.localeCompare(b.companionSkill)
    )
  };
  return JSON.stringify(sorted, null, 2) + "\n";
}
function validateCompanionRulebookSchema(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Companion rulebook must be a JSON object",
      detail: { receivedType: typeof parsed }
    };
  }
  const obj = parsed;
  if (obj.version !== 1) {
    return {
      code: "COMPANION_RULEBOOK_VERSION_UNSUPPORTED",
      message: `Unsupported companion rulebook version: ${String(obj.version)}`,
      detail: { version: obj.version, supportedVersions: [1] }
    };
  }
  if (typeof obj.generatedAt !== "string") {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid generatedAt field",
      detail: { field: "generatedAt", receivedType: typeof obj.generatedAt }
    };
  }
  if (typeof obj.projectRoot !== "string") {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid projectRoot field",
      detail: { field: "projectRoot", receivedType: typeof obj.projectRoot }
    };
  }
  if (!Array.isArray(obj.rules)) {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid rules field",
      detail: { field: "rules", receivedType: typeof obj.rules }
    };
  }
  for (let i = 0; i < obj.rules.length; i++) {
    const rule = obj.rules[i];
    if (typeof rule !== "object" || rule === null) {
      return {
        code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} is not an object`,
        detail: { index: i, receivedType: typeof rule }
      };
    }
    const requiredStrings = [
      "id",
      "scenario",
      "candidateSkill",
      "companionSkill",
      "reason"
    ];
    for (const field of requiredStrings) {
      if (typeof rule[field] !== "string") {
        return {
          code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
          message: `Rule at index ${i} has invalid ${field}`,
          detail: { index: i, field, receivedType: typeof rule[field] }
        };
      }
    }
    const requiredNumbers = [
      "support",
      "winsWithCompanion",
      "winsWithoutCompanion",
      "precisionWithCompanion",
      "baselinePrecisionWithoutCompanion",
      "liftVsCandidateAlone",
      "staleMissDelta"
    ];
    for (const field of requiredNumbers) {
      if (typeof rule[field] !== "number") {
        return {
          code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
          message: `Rule at index ${i} has invalid ${field}`,
          detail: { index: i, field, receivedType: typeof rule[field] }
        };
      }
    }
    const validConfidence = ["candidate", "promote", "holdout-fail"];
    if (!validConfidence.includes(rule.confidence)) {
      return {
        code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} has invalid confidence: ${String(rule.confidence)}`,
        detail: { index: i, field: "confidence", value: rule.confidence }
      };
    }
  }
  if (typeof obj.replay !== "object" || obj.replay === null) {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid replay field",
      detail: { field: "replay", receivedType: typeof obj.replay }
    };
  }
  if (typeof obj.promotion !== "object" || obj.promotion === null) {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid promotion field",
      detail: { field: "promotion", receivedType: typeof obj.promotion }
    };
  }
  return null;
}
function createEmptyCompanionRulebook(projectRoot, generatedAt) {
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
      reason: "empty rulebook"
    }
  };
}
function loadCompanionRulebook(projectRoot) {
  const path = companionRulebookPath(projectRoot);
  const log = createLogger();
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    log.summary("learned-companion-rulebook.load-miss", {
      path,
      reason: "file_not_found"
    });
    return {
      ok: true,
      rulebook: createEmptyCompanionRulebook(
        projectRoot,
        (/* @__PURE__ */ new Date(0)).toISOString()
      )
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error = {
      code: "COMPANION_RULEBOOK_READ_FAILED",
      message: "Companion rulebook file contains invalid JSON",
      detail: { path, parseError: String(err) }
    };
    log.summary("learned-companion-rulebook.load-error", {
      code: error.code,
      path
    });
    return { ok: false, error };
  }
  const validationError = validateCompanionRulebookSchema(parsed);
  if (validationError) {
    log.summary("learned-companion-rulebook.load-error", {
      code: validationError.code,
      path,
      detail: validationError.detail
    });
    return { ok: false, error: validationError };
  }
  const rulebook = parsed;
  log.summary("learned-companion-rulebook.load-ok", {
    path,
    ruleCount: rulebook.rules.length,
    promotedCount: rulebook.rules.filter((r) => r.confidence === "promote").length,
    version: rulebook.version
  });
  return { ok: true, rulebook };
}
function saveCompanionRulebook(projectRoot, rulebook) {
  const dest = companionRulebookPath(projectRoot);
  const tempPath = join(
    tmpdir(),
    `vercel-plugin-companion-rulebook-${randomUUID()}.tmp`
  );
  const log = createLogger();
  const content = serializeCompanionRulebook(rulebook);
  writeFileSync(tempPath, content);
  renameSync(tempPath, dest);
  log.summary("learned-companion-rulebook.save", {
    path: dest,
    ruleCount: rulebook.rules.length,
    promotedCount: rulebook.rules.filter((r) => r.confidence === "promote").length,
    bytesWritten: Buffer.byteLength(content)
  });
}
export {
  companionRulebookPath,
  createEmptyCompanionRulebook,
  loadCompanionRulebook,
  saveCompanionRulebook,
  serializeCompanionRulebook
};
