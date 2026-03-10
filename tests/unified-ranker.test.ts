import { describe, test, expect } from "bun:test";
import { rankSkills } from "../hooks/src/unified-ranker.mts";

describe("rankSkills", () => {
  test("rankSkills computes weighted breakdown and sorts by finalScore when candidates mix signals", () => {
    const ranked = rankSkills([
      { skill: "lexical-heavy", lexicalScore: 10, basePriority: 4 },
      {
        skill: "all-signals",
        pathMatch: true,
        commandMatch: true,
        importMatch: true,
        profilerBoost: 3,
        promptScore: 6,
        lexicalScore: 2,
        basePriority: 8,
      },
      { skill: "command-only", commandMatch: true },
    ]);

    expect(ranked.map(({ skill }) => skill)).toEqual([
      "all-signals",
      "lexical-heavy",
      "command-only",
    ]);
    expect(ranked[0].finalScore).toBeCloseTo(49.7);
    expect(ranked[0].breakdown).toEqual({
      pathPoints: 10,
      commandPoints: 10,
      importPoints: 10,
      profilerPoints: 3,
      promptPoints: 6,
      lexicalPoints: 2.7,
      priorityPoints: 8,
    });
  });

  test("rankSkills applies default signal values when optional fields are omitted", () => {
    const [ranked] = rankSkills([{ skill: "baseline" }]);

    expect(ranked).toEqual({
      skill: "baseline",
      finalScore: 5,
      breakdown: {
        pathPoints: 0,
        commandPoints: 0,
        importPoints: 0,
        profilerPoints: 0,
        promptPoints: 0,
        lexicalPoints: 0,
        priorityPoints: 5,
      },
    });
  });
});
