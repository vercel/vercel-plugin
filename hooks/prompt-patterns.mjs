const CONTRACTIONS = {
  "it's": "it is",
  "what's": "what is",
  "where's": "where is",
  "that's": "that is",
  "there's": "there is",
  "who's": "who is",
  "how's": "how is",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "doesn't": "does not",
  "don't": "do not",
  "didn't": "did not",
  "won't": "will not",
  "can't": "cannot",
  "couldn't": "could not",
  "wouldn't": "would not",
  "shouldn't": "should not",
  "hasn't": "has not",
  "haven't": "have not"
};
const CONTRACTION_ENTRIES = Object.entries(CONTRACTIONS);
function expandContractions(text) {
  let t = text.replace(/[\u2018\u2019\u2032]/g, "'");
  for (const [contraction, expansion] of CONTRACTION_ENTRIES) {
    if (t.includes(contraction)) {
      t = t.replaceAll(contraction, expansion);
    }
  }
  return t;
}
function normalizePromptText(text) {
  if (typeof text !== "string") return "";
  let t = text.toLowerCase();
  t = expandContractions(t);
  return t.replace(/\s+/g, " ").trim();
}
function compilePromptSignals(signals) {
  const norm = (s) => expandContractions(s.toLowerCase());
  return {
    phrases: (signals.phrases || []).map(norm),
    allOf: (signals.allOf || []).map((group) => group.map(norm)),
    anyOf: (signals.anyOf || []).map(norm),
    noneOf: (signals.noneOf || []).map(norm),
    minScore: typeof signals.minScore === "number" && !Number.isNaN(signals.minScore) ? signals.minScore : 6
  };
}
function matchPromptWithReason(normalizedPrompt, compiled) {
  if (!normalizedPrompt) {
    return { matched: false, score: 0, reason: "empty prompt" };
  }
  for (const term of compiled.noneOf) {
    if (normalizedPrompt.includes(term)) {
      return {
        matched: false,
        score: -Infinity,
        reason: `suppressed by noneOf "${term}"`
      };
    }
  }
  let score = 0;
  const reasons = [];
  for (const phrase of compiled.phrases) {
    if (normalizedPrompt.includes(phrase)) {
      score += 6;
      reasons.push(`phrase "${phrase}" +6`);
    }
  }
  for (const group of compiled.allOf) {
    const allMatch = group.every((term) => normalizedPrompt.includes(term));
    if (allMatch) {
      score += 4;
      reasons.push(`allOf [${group.join(", ")}] +4`);
    }
  }
  let anyOfScore = 0;
  for (const term of compiled.anyOf) {
    if (normalizedPrompt.includes(term)) {
      anyOfScore += 1;
      if (anyOfScore <= 2) {
        reasons.push(`anyOf "${term}" +1`);
      }
    }
  }
  const cappedAnyOf = Math.min(anyOfScore, 2);
  score += cappedAnyOf;
  const matched = score >= compiled.minScore;
  if (!matched) {
    const detail = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
    return {
      matched: false,
      score,
      reason: `below threshold: score ${score} < ${compiled.minScore}${detail}`
    };
  }
  return {
    matched: true,
    score,
    reason: reasons.join("; ")
  };
}
export {
  compilePromptSignals,
  matchPromptWithReason,
  normalizePromptText
};
