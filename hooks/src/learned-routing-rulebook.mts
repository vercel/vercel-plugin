/**
 * learned-routing-rulebook.mts — Canonical learned routing rulebook artifact.
 *
 * Surfaces the routing-policy compiler's promotion decisions as a versioned,
 * machine-readable, project-scoped artifact with per-rule evidence and
 * deterministic serialization.
 *
 * Persistence contract:
 * - Rulebook path: `<tmpdir>/vercel-plugin-routing-policy-<sha256(projectRoot)>-rulebook.json`
 * - Sits next to the project routing policy file.
 * - Atomic write semantics via write-to-tmp + rename.
 *
 * Error codes:
 * - RULEBOOK_VERSION_UNSUPPORTED — loaded file has an unrecognized version
 * - RULEBOOK_SCHEMA_INVALID      — loaded file fails structural validation
 */

import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LearnedRuleAction = "promote" | "demote";

export interface LearnedRoutingRuleEvidence {
  baselineWins: number;
  baselineDirectiveWins: number;
  learnedWins: number;
  learnedDirectiveWins: number;
  regressionCount: number;
}

export interface LearnedRoutingRule {
  id: string;
  scenario: string;
  skill: string;
  action: LearnedRuleAction;
  boost: number;
  confidence: number;
  reason: string;
  sourceSessionId: string;
  promotedAt: string;
  evidence: LearnedRoutingRuleEvidence;
}

export interface LearnedRoutingRulebook {
  version: 1;
  createdAt: string;
  sessionId: string;
  rules: LearnedRoutingRule[];
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type RulebookErrorCode =
  | "RULEBOOK_VERSION_UNSUPPORTED"
  | "RULEBOOK_SCHEMA_INVALID"
  | "RULEBOOK_PROMOTION_REJECTED_REGRESSION";

export interface RulebookError {
  code: RulebookErrorCode;
  message: string;
  detail: Record<string, unknown>;
}

export type RulebookLoadResult =
  | { ok: true; rulebook: LearnedRoutingRulebook }
  | { ok: false; error: RulebookError };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function rulebookPath(projectRoot: string): string {
  const hash = createHash("sha256").update(projectRoot).digest("hex");
  return `${tmpdir()}/vercel-plugin-routing-policy-${hash}-rulebook.json`;
}

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a rulebook to deterministic JSON. Rules are sorted by
 * scenario asc → skill asc → id asc to guarantee byte-identical output
 * for the same logical content.
 */
export function serializeRulebook(rulebook: LearnedRoutingRulebook): string {
  const sorted: LearnedRoutingRulebook = {
    ...rulebook,
    rules: [...rulebook.rules].sort(
      (a, b) =>
        a.scenario.localeCompare(b.scenario) ||
        a.skill.localeCompare(b.skill) ||
        a.id.localeCompare(b.id),
    ),
  };
  return JSON.stringify(sorted, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateRulebookSchema(parsed: unknown): RulebookError | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Rulebook must be a JSON object",
      detail: { receivedType: typeof parsed },
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.version !== 1) {
    return {
      code: "RULEBOOK_VERSION_UNSUPPORTED",
      message: `Unsupported rulebook version: ${String(obj.version)}`,
      detail: { version: obj.version, supportedVersions: [1] },
    };
  }

  if (typeof obj.createdAt !== "string") {
    return {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid createdAt field",
      detail: { field: "createdAt", receivedType: typeof obj.createdAt },
    };
  }

  if (typeof obj.sessionId !== "string") {
    return {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid sessionId field",
      detail: { field: "sessionId", receivedType: typeof obj.sessionId },
    };
  }

  if (!Array.isArray(obj.rules)) {
    return {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid rules field",
      detail: { field: "rules", receivedType: typeof obj.rules },
    };
  }

  for (let i = 0; i < obj.rules.length; i++) {
    const rule = obj.rules[i] as Record<string, unknown>;
    if (typeof rule !== "object" || rule === null) {
      return {
        code: "RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} is not an object`,
        detail: { index: i, receivedType: typeof rule },
      };
    }
    const requiredStrings = ["id", "scenario", "skill", "reason", "sourceSessionId", "promotedAt"] as const;
    for (const field of requiredStrings) {
      if (typeof rule[field] !== "string") {
        return {
          code: "RULEBOOK_SCHEMA_INVALID",
          message: `Rule at index ${i} has invalid ${field}`,
          detail: { index: i, field, receivedType: typeof rule[field] },
        };
      }
    }
    if (rule.action !== "promote" && rule.action !== "demote") {
      return {
        code: "RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} has invalid action: ${String(rule.action)}`,
        detail: { index: i, field: "action", value: rule.action },
      };
    }
    if (typeof rule.boost !== "number" || typeof rule.confidence !== "number") {
      return {
        code: "RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} has invalid boost or confidence`,
        detail: { index: i, boost: rule.boost, confidence: rule.confidence },
      };
    }
    const evidence = rule.evidence as Record<string, unknown> | undefined;
    if (typeof evidence !== "object" || evidence === null) {
      return {
        code: "RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} has invalid evidence`,
        detail: { index: i, field: "evidence" },
      };
    }
    const evidenceNumbers = [
      "baselineWins", "baselineDirectiveWins",
      "learnedWins", "learnedDirectiveWins", "regressionCount",
    ] as const;
    for (const field of evidenceNumbers) {
      if (typeof evidence[field] !== "number") {
        return {
          code: "RULEBOOK_SCHEMA_INVALID",
          message: `Rule at index ${i} evidence has invalid ${field}`,
          detail: { index: i, field, receivedType: typeof evidence[field] },
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load a project-scoped rulebook from disk. Returns structured errors
 * for version mismatches or schema violations.
 */
export function loadRulebook(projectRoot: string): RulebookLoadResult {
  const path = rulebookPath(projectRoot);
  const log = createLogger();

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    log.summary("learned-routing-rulebook.load-miss", { path, reason: "file_not_found" });
    return {
      ok: true,
      rulebook: createEmptyRulebook("", ""),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error: RulebookError = {
      code: "RULEBOOK_SCHEMA_INVALID",
      message: "Rulebook file contains invalid JSON",
      detail: { path, parseError: String(err) },
    };
    log.summary("learned-routing-rulebook.load-error", { code: error.code, path });
    return { ok: false, error };
  }

  const validationError = validateRulebookSchema(parsed);
  if (validationError) {
    log.summary("learned-routing-rulebook.load-error", {
      code: validationError.code,
      path,
      detail: validationError.detail,
    });
    return { ok: false, error: validationError };
  }

  log.summary("learned-routing-rulebook.load-ok", {
    path,
    ruleCount: (parsed as LearnedRoutingRulebook).rules.length,
    version: (parsed as LearnedRoutingRulebook).version,
  });

  return { ok: true, rulebook: parsed as LearnedRoutingRulebook };
}

// ---------------------------------------------------------------------------
// Save (atomic write)
// ---------------------------------------------------------------------------

/**
 * Persist a rulebook to disk with atomic write semantics.
 * Writes to a temp file then renames to prevent partial reads.
 */
export function saveRulebook(
  projectRoot: string,
  rulebook: LearnedRoutingRulebook,
): void {
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
    bytesWritten: Buffer.byteLength(content),
  });
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createEmptyRulebook(
  sessionId: string,
  createdAt: string,
): LearnedRoutingRulebook {
  return {
    version: 1,
    createdAt,
    sessionId,
    rules: [],
  };
}

export function createRule(params: {
  scenario: string;
  skill: string;
  action: LearnedRuleAction;
  boost: number;
  confidence: number;
  reason: string;
  sourceSessionId: string;
  promotedAt: string;
  evidence: LearnedRoutingRuleEvidence;
}): LearnedRoutingRule {
  const id = `${params.scenario}|${params.skill}`;
  return { id, ...params };
}
