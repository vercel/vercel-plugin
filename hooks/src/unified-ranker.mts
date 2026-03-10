import { createLogger, type Logger } from "./logger.mjs";

const log: Logger = createLogger();
const MATCH_POINTS = 10;
const LEXICAL_MULTIPLIER = 1.35;

export interface RankedCandidate {
  skill: string;
  pathMatch?: boolean;
  commandMatch?: boolean;
  importMatch?: boolean;
  profilerBoost?: number;
  promptScore?: number;
  lexicalScore?: number;
  basePriority?: number;
}

export interface RankedSkill {
  skill: string;
  finalScore: number;
  breakdown: {
    pathPoints: number;
    commandPoints: number;
    importPoints: number;
    profilerPoints: number;
    promptPoints: number;
    lexicalPoints: number;
    priorityPoints: number;
  };
}

export function rankSkills(candidates: RankedCandidate[]): RankedSkill[] {
  const ranked = candidates
    .map(({ skill, pathMatch = false, commandMatch = false, importMatch = false, profilerBoost = 0, promptScore = 0, lexicalScore = 0, basePriority = 5 }) => {
      const breakdown = {
        pathPoints: pathMatch ? MATCH_POINTS : 0,
        commandPoints: commandMatch ? MATCH_POINTS : 0,
        importPoints: importMatch ? MATCH_POINTS : 0,
        profilerPoints: profilerBoost,
        promptPoints: promptScore,
        lexicalPoints: lexicalScore * LEXICAL_MULTIPLIER,
        priorityPoints: basePriority,
      };
      return {
        skill,
        finalScore: Object.values(breakdown).reduce((sum, points) => sum + points, 0),
        breakdown,
      };
    })
    .sort((a, b) => (b.finalScore - a.finalScore) || a.skill.localeCompare(b.skill));

  log.debug("unified-ranker-ranked", {
    candidateCount: candidates.length,
    rankedSkills: ranked.map(({ skill, finalScore }) => ({ skill, finalScore })),
  });

  return ranked;
}
