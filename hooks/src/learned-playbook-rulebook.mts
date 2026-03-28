/**
 * learned-playbook-rulebook.mts — Learned playbook artifact persistence.
 *
 * A playbook is a verified ordered multi-skill sequence (e.g. A → B → C) scoped
 * to a (hook, storyKind, targetBoundary, toolName, routeScope) scenario. Unlike
 * single-skill routing rules or pairwise companion rules, playbooks capture
 * proven procedural strategies that repeatedly close a verification gap.
 *
 * The rulebook is written to `generated/learned-playbooks.json` beside the
 * existing routing and companion rulebooks. It is safe to round-trip: the file
 * is deterministic JSON sorted by scenario/anchor/sequence.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "./logger.mjs";
import type {
  RoutingBoundary,
  RoutingHookName,
  RoutingToolName,
} from "./routing-policy.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LearnedPlaybookRule {
  id: string;
  scenario: string;
  hook: RoutingHookName;
  storyKind: string | null;
  targetBoundary: RoutingBoundary | null;
  toolName: RoutingToolName;
  routeScope: string | null;
  anchorSkill: string;
  orderedSkills: string[];
  support: number;
  wins: number;
  directiveWins: number;
  staleMisses: number;
  precision: number;
  baselinePrecisionWithoutPlaybook: number;
  liftVsAnchorBaseline: number;
  staleMissDelta: number;
  confidence: "promote" | "holdout-fail";
  promotedAt: string | null;
  reason: string;
  sourceExposureGroupIds: string[];
}

export interface LearnedPlaybookRulebook {
  version: 1;
  generatedAt: string;
  projectRoot: string;
  rules: LearnedPlaybookRule[];
  replay: {
    baselineWins: number;
    learnedWins: number;
    deltaWins: number;
    regressions: string[];
  };
  promotion: {
    accepted: boolean;
    errorCode: string | null;
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export function playbookRulebookPath(projectRoot: string): string {
  return join(projectRoot, "generated", "learned-playbooks.json");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmptyPlaybookRulebook(
  projectRoot: string,
  generatedAt = new Date().toISOString(),
): LearnedPlaybookRulebook {
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
      reason: "No promoted playbooks",
    },
  };
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export function savePlaybookRulebook(
  projectRoot: string,
  rulebook: LearnedPlaybookRulebook,
): void {
  const path = playbookRulebookPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rulebook, null, 2) + "\n");
  createLogger().summary("learned-playbook-rulebook.save", {
    path,
    ruleCount: rulebook.rules.length,
    promotedCount: rulebook.rules.filter((r) => r.confidence === "promote")
      .length,
  });
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export type LoadPlaybookRulebookResult =
  | { ok: true; rulebook: LearnedPlaybookRulebook }
  | {
      ok: false;
      error: {
        code: "ENOENT" | "EINVALID";
        message: string;
      };
    };

export function loadPlaybookRulebook(
  projectRoot: string,
): LoadPlaybookRulebookResult {
  const path = playbookRulebookPath(projectRoot);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LearnedPlaybookRulebook>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.generatedAt !== "string" ||
      typeof parsed.projectRoot !== "string" ||
      !Array.isArray(parsed.rules) ||
      typeof parsed.replay !== "object" ||
      typeof parsed.promotion !== "object"
    ) {
      return {
        ok: false,
        error: {
          code: "EINVALID",
          message: `Invalid learned playbook rulebook at ${path}`,
        },
      };
    }
    return { ok: true, rulebook: parsed as LearnedPlaybookRulebook };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        ok: false,
        error: {
          code: "ENOENT",
          message: `No learned playbook rulebook found at ${path}`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "EINVALID",
        message: `Failed to read learned playbook rulebook at ${path}`,
      },
    };
  }
}
