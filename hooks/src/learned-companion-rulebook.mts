/**
 * learned-companion-rulebook.mts — Persisted learned companion rulebook artifact.
 *
 * Stores which companion skills improve a candidate skill's verification
 * closure rate within the same scenario. Separate from the single-skill
 * routing-policy ledger to keep causal credit clean.
 *
 * Persistence contract:
 * - Path: `<tmpdir>/vercel-plugin-learned-companions-<sha256(projectRoot)>.json`
 * - Atomic write semantics via write-to-tmp + rename.
 * - Independent of the single-skill routing-policy path.
 *
 * Error codes:
 * - COMPANION_RULEBOOK_VERSION_UNSUPPORTED — unrecognized version
 * - COMPANION_RULEBOOK_SCHEMA_INVALID      — structural validation failure
 * - COMPANION_RULEBOOK_READ_FAILED         — I/O or JSON parse error
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
import type {
  RoutingBoundary,
  RoutingHookName,
  RoutingToolName,
} from "./routing-policy.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompanionConfidence = "candidate" | "promote" | "holdout-fail";

export interface LearnedCompanionRule {
  id: string;
  scenario: string;
  hook: RoutingHookName;
  storyKind: string | null;
  targetBoundary: RoutingBoundary | null;
  toolName: RoutingToolName;
  routeScope: string | null;
  candidateSkill: string;
  companionSkill: string;
  support: number;
  winsWithCompanion: number;
  winsWithoutCompanion: number;
  directiveWinsWithCompanion: number;
  staleMissesWithCompanion: number;
  precisionWithCompanion: number;
  baselinePrecisionWithoutCompanion: number;
  liftVsCandidateAlone: number;
  staleMissDelta: number;
  confidence: CompanionConfidence;
  promotedAt: string | null;
  reason: string;
  sourceExposureGroupIds: string[];
}

export interface CompanionReplay {
  baselineWins: number;
  learnedWins: number;
  deltaWins: number;
  regressions: string[];
}

export interface CompanionPromotion {
  accepted: boolean;
  errorCode: string | null;
  reason: string;
}

export interface LearnedCompanionRulebook {
  version: 1;
  generatedAt: string;
  projectRoot: string;
  rules: LearnedCompanionRule[];
  replay: CompanionReplay;
  promotion: CompanionPromotion;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type CompanionRulebookErrorCode =
  | "COMPANION_RULEBOOK_VERSION_UNSUPPORTED"
  | "COMPANION_RULEBOOK_SCHEMA_INVALID"
  | "COMPANION_RULEBOOK_READ_FAILED";

export interface CompanionRulebookError {
  code: CompanionRulebookErrorCode;
  message: string;
  detail: Record<string, unknown>;
}

export type CompanionRulebookLoadResult =
  | { ok: true; rulebook: LearnedCompanionRulebook }
  | { ok: false; error: CompanionRulebookError };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function companionRulebookPath(projectRoot: string): string {
  const hash = createHash("sha256").update(projectRoot).digest("hex");
  return `${tmpdir()}/vercel-plugin-learned-companions-${hash}.json`;
}

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a companion rulebook to deterministic JSON. Rules are sorted by
 * scenario asc → candidateSkill asc → companionSkill asc.
 */
export function serializeCompanionRulebook(
  rulebook: LearnedCompanionRulebook,
): string {
  const sorted: LearnedCompanionRulebook = {
    ...rulebook,
    rules: [...rulebook.rules].sort(
      (a, b) =>
        a.scenario.localeCompare(b.scenario) ||
        a.candidateSkill.localeCompare(b.candidateSkill) ||
        a.companionSkill.localeCompare(b.companionSkill),
    ),
  };
  return JSON.stringify(sorted, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateCompanionRulebookSchema(
  parsed: unknown,
): CompanionRulebookError | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Companion rulebook must be a JSON object",
      detail: { receivedType: typeof parsed },
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.version !== 1) {
    return {
      code: "COMPANION_RULEBOOK_VERSION_UNSUPPORTED",
      message: `Unsupported companion rulebook version: ${String(obj.version)}`,
      detail: { version: obj.version, supportedVersions: [1] },
    };
  }

  if (typeof obj.generatedAt !== "string") {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid generatedAt field",
      detail: { field: "generatedAt", receivedType: typeof obj.generatedAt },
    };
  }

  if (typeof obj.projectRoot !== "string") {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid projectRoot field",
      detail: { field: "projectRoot", receivedType: typeof obj.projectRoot },
    };
  }

  if (!Array.isArray(obj.rules)) {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid rules field",
      detail: { field: "rules", receivedType: typeof obj.rules },
    };
  }

  for (let i = 0; i < obj.rules.length; i++) {
    const rule = obj.rules[i] as Record<string, unknown>;
    if (typeof rule !== "object" || rule === null) {
      return {
        code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} is not an object`,
        detail: { index: i, receivedType: typeof rule },
      };
    }
    const requiredStrings = [
      "id", "scenario", "candidateSkill", "companionSkill", "reason",
    ] as const;
    for (const field of requiredStrings) {
      if (typeof rule[field] !== "string") {
        return {
          code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
          message: `Rule at index ${i} has invalid ${field}`,
          detail: { index: i, field, receivedType: typeof rule[field] },
        };
      }
    }
    const requiredNumbers = [
      "support", "winsWithCompanion", "winsWithoutCompanion",
      "precisionWithCompanion", "baselinePrecisionWithoutCompanion",
      "liftVsCandidateAlone", "staleMissDelta",
    ] as const;
    for (const field of requiredNumbers) {
      if (typeof rule[field] !== "number") {
        return {
          code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
          message: `Rule at index ${i} has invalid ${field}`,
          detail: { index: i, field, receivedType: typeof rule[field] },
        };
      }
    }
    const validConfidence = ["candidate", "promote", "holdout-fail"];
    if (!validConfidence.includes(rule.confidence as string)) {
      return {
        code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
        message: `Rule at index ${i} has invalid confidence: ${String(rule.confidence)}`,
        detail: { index: i, field: "confidence", value: rule.confidence },
      };
    }
  }

  // Validate replay object
  if (typeof obj.replay !== "object" || obj.replay === null) {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid replay field",
      detail: { field: "replay", receivedType: typeof obj.replay },
    };
  }

  // Validate promotion object
  if (typeof obj.promotion !== "object" || obj.promotion === null) {
    return {
      code: "COMPANION_RULEBOOK_SCHEMA_INVALID",
      message: "Missing or invalid promotion field",
      detail: { field: "promotion", receivedType: typeof obj.promotion },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createEmptyCompanionRulebook(
  projectRoot: string,
  generatedAt: string,
): LearnedCompanionRulebook {
  return {
    version: 1,
    generatedAt,
    projectRoot,
    rules: [],
    replay: {
      baselineWins: 0,
      learnedWins: 0,
      deltaWins: 0,
      regressions: [],
    },
    promotion: {
      accepted: true,
      errorCode: null,
      reason: "empty rulebook",
    },
  };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load a project-scoped companion rulebook from disk. Returns a structured
 * error for version mismatches, schema violations, or I/O failures.
 * Returns an empty version-1 rulebook when the file does not exist.
 */
export function loadCompanionRulebook(
  projectRoot: string,
): CompanionRulebookLoadResult {
  const path = companionRulebookPath(projectRoot);
  const log = createLogger();

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    log.summary("learned-companion-rulebook.load-miss", {
      path,
      reason: "file_not_found",
    });
    return {
      ok: true,
      rulebook: createEmptyCompanionRulebook(
        projectRoot,
        new Date(0).toISOString(),
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error: CompanionRulebookError = {
      code: "COMPANION_RULEBOOK_READ_FAILED",
      message: "Companion rulebook file contains invalid JSON",
      detail: { path, parseError: String(err) },
    };
    log.summary("learned-companion-rulebook.load-error", {
      code: error.code,
      path,
    });
    return { ok: false, error };
  }

  const validationError = validateCompanionRulebookSchema(parsed);
  if (validationError) {
    log.summary("learned-companion-rulebook.load-error", {
      code: validationError.code,
      path,
      detail: validationError.detail,
    });
    return { ok: false, error: validationError };
  }

  const rulebook = parsed as LearnedCompanionRulebook;
  log.summary("learned-companion-rulebook.load-ok", {
    path,
    ruleCount: rulebook.rules.length,
    promotedCount: rulebook.rules.filter((r) => r.confidence === "promote")
      .length,
    version: rulebook.version,
  });

  return { ok: true, rulebook };
}

// ---------------------------------------------------------------------------
// Save (atomic write)
// ---------------------------------------------------------------------------

/**
 * Persist a companion rulebook to disk with atomic write semantics.
 * Writes to a temp file then renames to prevent partial reads.
 */
export function saveCompanionRulebook(
  projectRoot: string,
  rulebook: LearnedCompanionRulebook,
): void {
  const dest = companionRulebookPath(projectRoot);
  const tempPath = join(
    tmpdir(),
    `vercel-plugin-companion-rulebook-${randomUUID()}.tmp`,
  );
  const log = createLogger();

  const content = serializeCompanionRulebook(rulebook);
  writeFileSync(tempPath, content);
  renameSync(tempPath, dest);

  log.summary("learned-companion-rulebook.save", {
    path: dest,
    ruleCount: rulebook.rules.length,
    promotedCount: rulebook.rules.filter((r) => r.confidence === "promote")
      .length,
    bytesWritten: Buffer.byteLength(content),
  });
}
