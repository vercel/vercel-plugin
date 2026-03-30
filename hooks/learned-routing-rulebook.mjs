// hooks/src/learned-routing-rulebook.mts
import { createHash, randomUUID } from "crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLogger } from "./logger.mjs";
function rulebookPath(projectRoot) {
  const hash = createHash("sha256").update(projectRoot).digest("hex");
  return `${tmpdir()}/vercel-plugin-routing-policy-${hash}-rulebook.json`;
}
function serializeRulebook(rulebook) {
  const sorted = {
    ...rulebook,
    rules: [...rulebook.rules].sort(
      (a, b) => a.scenario.localeCompare(b.scenario) || a.skill.localeCompare(b.skill) || a.id.localeCompare(b.id)
    )
  };
  return JSON.stringify(sorted, null, 2) + "\n";
}
function validateRulebookSchema(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Rulebook must be a JSON object",
      detail: { receivedType: typeof parsed }
    };
  }
  const obj = parsed;
  if (obj.version !== 1) {
    return {
      code: "RULEBOOK_VERSION_UNSUPPORTED",
      message: `Unsupported rulebook version: ${String(obj.version)}`,
      detail: { version: obj.version, supportedVersions: [1] }
    };
  }
  if (typeof obj.createdAt !== "string") {
    return {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid createdAt field",
      detail: { field: "createdAt", receivedType: typeof obj.createdAt }
    };
  }
  if (typeof obj.sessionId !== "string") {
    return {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid sessionId field",
      detail: { field: "sessionId", receivedType: typeof obj.sessionId }
    };
  }
  if (!Array.isArray(obj.rules)) {
    return {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid rules field",
      detail: { field: "rules", receivedType: typeof obj.rules }
    };
  }
  for (let i = 0; i < obj.rules.length; i++) {
    const rule = obj.rules[i];
    if (typeof rule !== "object" || rule === null) {
      return {
        code: "RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} is not an object`,
        detail: { index: i, receivedType: typeof rule }
      };
    }
    const requiredStrings = ["id", "scenario", "skill", "reason", "sourceSessionId", "promotedAt"];
    for (const field of requiredStrings) {
      if (typeof rule[field] !== "string") {
        return {
          code: "RULEBOOK_SCHEMA_INVALID",
          message: `Rule at index ${i} has invalid ${field}`,
          detail: { index: i, field, receivedType: typeof rule[field] }
        };
      }
    }
    if (rule.action !== "promote" && rule.action !== "demote") {
      return {
        code: "RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} has invalid action: ${String(rule.action)}`,
        detail: { index: i, field: "action", value: rule.action }
      };
    }
    if (typeof rule.boost !== "number" || typeof rule.confidence !== "number") {
      return {
        code: "RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} has invalid boost or confidence`,
        detail: { index: i, boost: rule.boost, confidence: rule.confidence }
      };
    }
    const evidence = rule.evidence;
    if (typeof evidence !== "object" || evidence === null) {
      return {
        code: "RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} has invalid evidence`,
        detail: { index: i, field: "evidence" }
      };
    }
    const evidenceNumbers = [
      "baselineWins",
      "baselineDirectiveWins",
      "learnedWins",
      "learnedDirectiveWins",
      "regressionCount"
    ];
    for (const field of evidenceNumbers) {
      if (typeof evidence[field] !== "number") {
        return {
          code: "RULEBOOK_SCHEMA_INVALID",
          message: `Rule at index ${i} evidence has invalid ${field}`,
          detail: { index: i, field, receivedType: typeof evidence[field] }
        };
      }
    }
  }
  return null;
}
function loadRulebook(projectRoot) {
  const path = rulebookPath(projectRoot);
  const log = createLogger();
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    log.summary("learned-routing-rulebook.load-miss", { path, reason: "file_not_found" });
    return {
      ok: true,
      rulebook: createEmptyRulebook("", "")
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error = {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Rulebook file contains invalid JSON",
      detail: { path, parseError: String(err) }
    };
    log.summary("learned-routing-rulebook.load-error", { code: error.code, path });
    return { ok: false, error };
  }
  const validationError = validateRulebookSchema(parsed);
  if (validationError) {
    log.summary("learned-routing-rulebook.load-error", {
      code: validationError.code,
      path,
      detail: validationError.detail
    });
    return { ok: false, error: validationError };
  }
  log.summary("learned-routing-rulebook.load-ok", {
    path,
    ruleCount: parsed.rules.length,
    version: parsed.version
  });
  return { ok: true, rulebook: parsed };
}
function saveRulebook(projectRoot, rulebook) {
  const dest = rulebookPath(projectRoot);
  const tempPath = join(tmpdir(), `vercel-plugin-rulebook-${randomUUID()}.tmp`);
  const log = createLogger();
  const content = serializeRulebook(rulebook);
  writeFileSync(tempPath, content);
  renameSync(tempPath, dest);
  log.summary("learned-routing-rulebook.save", {
    path: dest,
    ruleCount: rulebook.rules.length,
    sessionId: rulebook.sessionId,
    bytesWritten: Buffer.byteLength(content)
  });
}
function createEmptyRulebook(sessionId, createdAt) {
  return {
    version: 1,
    createdAt,
    sessionId,
    rules: []
  };
}
function createRule(params) {
  const id = `${params.scenario}|${params.skill}`;
  return { id, ...params };
}
export {
  createEmptyRulebook,
  createRule,
  loadRulebook,
  rulebookPath,
  saveRulebook,
  serializeRulebook
};
