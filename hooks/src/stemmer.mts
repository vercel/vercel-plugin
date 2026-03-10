/**
 * Lightweight suffix stemmer for skill matching normalization.
 *
 * Strips common English suffixes (-ing, -tion, -ment, -ed, -ly, -er, -est, -ness)
 * with an exception list to avoid false stems. Applied to both prompt text and
 * compiled signal terms so both sides match consistently.
 *
 * This is intentionally conservative — it's better to miss a stem than to
 * produce a wrong one, since wrong stems cause false matches.
 */

// ---------------------------------------------------------------------------
// Exception sets — words that naturally end in a suffix but should NOT be stemmed
// ---------------------------------------------------------------------------

const EXCEPTIONS_ING = new Set([
  "ring", "king", "thing", "string", "bring", "sing", "spring", "swing",
  "sting", "cling", "fling", "sling", "wring", "during", "ceiling", "being",
  "nothing", "something", "anything", "everything", "morning", "evening",
  "ping", "bing", "wing", "ding", "ming",
]);

const EXCEPTIONS_ED = new Set([
  "bed", "red", "fed", "led", "shed", "wed", "sled", "bled", "bred",
  "fled", "shred", "sped", "need", "seed", "feed", "speed", "indeed",
]);

const EXCEPTIONS_TION = new Set([
  "mention", "question", "caution", "portion", "section", "notion",
  "potion", "fashion", "bastion", "function", "junction", "auction",
]);

const EXCEPTIONS_MENT = new Set([
  "element", "comment", "moment", "segment", "fragment", "garment",
  "cement", "ament", "torment", "ferment", "lament",
]);

const EXCEPTIONS_LY = new Set([
  "only", "early", "family", "apply", "reply", "supply", "daily",
  "holy", "rely", "ugly", "ally", "bully", "rally", "tally", "belly",
  "jelly", "folly", "jolly", "lily", "fly", "july", "sly", "ply",
  "italy", "anomaly",
]);

const EXCEPTIONS_ER = new Set([
  "user", "server", "number", "member", "remember", "other", "never",
  "ever", "over", "under", "after", "water", "order", "power", "paper",
  "later", "letter", "center", "computer", "however", "together", "matter",
  "layer", "player", "river", "silver", "finger", "wonder", "cluster",
  "trigger", "docker", "buffer", "folder", "header", "footer", "render",
  "handler", "parser", "router", "worker", "builder", "loader", "adapter",
  "wrapper", "container", "parameter", "character", "manager", "provider",
  "consumer", "producer", "observer", "resolver", "scheduler", "dispatcher",
  "controller", "middleware", "whatever", "whenever", "wherever",
  "either", "neither", "rather", "whether", "another", "enter",
  "offer", "differ", "suffer", "prefer", "refer", "transfer", "master",
  "monster", "register", "consider", "discover", "deliver", "cover",
  "recover", "flutter", "twitter", "inner", "outer", "upper", "lower",
  "proper", "super", "fiber", "timber", "cider", "spider", "cyber",
]);

const EXCEPTIONS_EST = new Set([
  "test", "best", "rest", "request", "nest", "west", "quest", "jest",
  "fest", "zest", "chest", "guest", "forest", "interest", "suggest",
  "manifest", "contest", "protest", "harvest", "invest", "digest",
  "modest", "honest", "earnest", "vitest", "latest",
]);

const EXCEPTIONS_NESS = new Set([
  "business", "less", "ness",
]);

// Doubled consonants that are natural in base words — don't un-double these
const KEEP_DOUBLED = new Set(["ll", "ss", "ff", "zz"]);

// ---------------------------------------------------------------------------
// Post-stem normalization — fix ecosystem terms that suffix-stripping mangles
// ---------------------------------------------------------------------------

/**
 * After mechanical suffix stripping, some stems are wrong for our domain.
 * E.g., "caching" → strip -ing → "cach", but the correct root is "cache".
 * This map corrects those cases so both prompt text and signal terms converge
 * on the same canonical stem.
 */
const POST_STEM_MAP: Record<string, string> = {
  cach: "cache",
  rout: "route",
  styl: "style",
  revalidat: "revalidate",
  configur: "configure",
  configura: "configure",
  optimiz: "optimize",
  optimiza: "optimize",
  authentica: "authenticate",
  schedul: "schedule",
  initializ: "initialize",
  serializ: "serialize",
  deserializ: "deserialize",
  customiz: "customize",
  synchroniz: "synchronize",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If stem ends with a doubled consonant (e.g., "runn" → "run"),
 * remove the duplicate — unless it's a naturally doubled pair (ll, ss, ff, zz).
 */
function undouble(stem: string): string {
  if (stem.length < 3) return stem;
  const last = stem[stem.length - 1];
  const prev = stem[stem.length - 2];
  if (last === prev && /[bcdfghjklmnpqrstvwxyz]/.test(last)) {
    const pair = `${prev}${last}`;
    if (!KEEP_DOUBLED.has(pair)) {
      return stem.slice(0, -1);
    }
  }
  return stem;
}

// Minimum remaining stem length after suffix removal
const MIN_STEM = 3;

// ---------------------------------------------------------------------------
// stemToken
// ---------------------------------------------------------------------------

/**
 * Strip common English suffixes from a single lowercase token.
 * Returns the stemmed form, or the original token if no rule applies
 * or the token is in an exception list.
 *
 * Only one suffix is removed (no recursive stripping).
 */
export function stemToken(word: string): string {
  if (word.length < 4) return word;

  let stem: string | null = null;

  // -tion (try before -ion to be more specific)
  if (word.endsWith("tion") && word.length >= MIN_STEM + 4) {
    if (!EXCEPTIONS_TION.has(word)) stem = word.slice(0, -4);
  }

  // -ment
  if (stem === null && word.endsWith("ment") && word.length >= MIN_STEM + 4) {
    if (!EXCEPTIONS_MENT.has(word)) stem = word.slice(0, -4);
  }

  // -ness
  if (stem === null && word.endsWith("ness") && word.length >= MIN_STEM + 4) {
    if (!EXCEPTIONS_NESS.has(word)) stem = word.slice(0, -4);
  }

  // -ing
  if (stem === null && word.endsWith("ing") && word.length >= MIN_STEM + 3) {
    if (!EXCEPTIONS_ING.has(word)) stem = undouble(word.slice(0, -3));
  }

  // -est (before -ed to avoid "fastest" → strip -ed → "fast" + "est" confusion)
  if (stem === null && word.endsWith("est") && word.length >= MIN_STEM + 3) {
    if (!EXCEPTIONS_EST.has(word)) stem = undouble(word.slice(0, -3));
  }

  // -ed
  if (stem === null && word.endsWith("ed") && word.length >= MIN_STEM + 2) {
    if (!EXCEPTIONS_ED.has(word)) stem = undouble(word.slice(0, -2));
  }

  // -ly (require stem >= 4 to avoid "apply" → "app")
  if (stem === null && word.endsWith("ly") && word.length >= 4 + 2) {
    if (!EXCEPTIONS_LY.has(word)) stem = word.slice(0, -2);
  }

  // -er (require stem >= 4 to avoid short false stems)
  if (stem === null && word.endsWith("er") && word.length >= 4 + 2) {
    if (!EXCEPTIONS_ER.has(word)) stem = undouble(word.slice(0, -2));
  }

  if (stem === null) return word;

  // Apply post-stem normalization for ecosystem terms
  return POST_STEM_MAP[stem] ?? stem;
}

// ---------------------------------------------------------------------------
// stemText
// ---------------------------------------------------------------------------

/**
 * Apply stemToken to every word-like token in a string, preserving spacing.
 * Non-word characters and spacing are kept as-is.
 */
export function stemText(text: string): string {
  return text.replace(/[a-z]+/g, (match) => stemToken(match));
}
