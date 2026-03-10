import { describe, test, expect } from "bun:test";
import { stemToken, stemText } from "../hooks/stemmer.mjs";

// ---------------------------------------------------------------------------
// stemToken — suffix stripping
// ---------------------------------------------------------------------------

describe("stemToken", () => {
  // --- -ing ---
  test("strips -ing: deploying → deploy", () => {
    expect(stemToken("deploying")).toBe("deploy");
  });

  test("strips -ing with doubled consonant: running → run", () => {
    expect(stemToken("running")).toBe("run");
  });

  test("strips -ing with doubled consonant: stopping → stop", () => {
    expect(stemToken("stopping")).toBe("stop");
  });

  test("strips -ing with doubled consonant: setting → set", () => {
    expect(stemToken("setting")).toBe("set");
  });

  test("preserves -ing exception: ring → ring", () => {
    expect(stemToken("ring")).toBe("ring");
  });

  test("preserves -ing exception: king → king", () => {
    expect(stemToken("king")).toBe("king");
  });

  test("preserves -ing exception: thing → thing", () => {
    expect(stemToken("thing")).toBe("thing");
  });

  test("preserves -ing exception: string → string", () => {
    expect(stemToken("string")).toBe("string");
  });

  test("preserves -ing exception: bring → bring", () => {
    expect(stemToken("bring")).toBe("bring");
  });

  test("preserves -ing exception: spring → spring", () => {
    expect(stemToken("spring")).toBe("spring");
  });

  test("preserves -ing exception: during → during", () => {
    expect(stemToken("during")).toBe("during");
  });

  test("preserves -ing exception: nothing → nothing", () => {
    expect(stemToken("nothing")).toBe("nothing");
  });

  test("strips -ing: configuring → configure", () => {
    expect(stemToken("configuring")).toBe("configure");
  });

  test("strips -ing: caching → cache", () => {
    expect(stemToken("caching")).toBe("cache");
  });

  test("preserves doubled ll in falling → fall", () => {
    expect(stemToken("falling")).toBe("fall");
  });

  test("preserves doubled ss in missing → miss", () => {
    expect(stemToken("missing")).toBe("miss");
  });

  // --- -ed ---
  test("strips -ed: deployed → deploy", () => {
    expect(stemToken("deployed")).toBe("deploy");
  });

  test("strips -ed: configured → configure", () => {
    expect(stemToken("configured")).toBe("configure");
  });

  test("strips -ed with doubled consonant: stopped → stop", () => {
    expect(stemToken("stopped")).toBe("stop");
  });

  test("preserves -ed exception: need → need", () => {
    expect(stemToken("need")).toBe("need");
  });

  test("preserves -ed exception: speed → speed", () => {
    expect(stemToken("speed")).toBe("speed");
  });

  test("strips -ed: called → call", () => {
    expect(stemToken("called")).toBe("call");
  });

  // --- -tion ---
  test("strips -tion: authentication → authenticate", () => {
    expect(stemToken("authentication")).toBe("authenticate");
  });

  test("strips -tion: configuration → configure", () => {
    expect(stemToken("configuration")).toBe("configure");
  });

  test("strips -tion: optimization → optimize", () => {
    expect(stemToken("optimization")).toBe("optimize");
  });

  test("preserves -tion exception: function → function", () => {
    expect(stemToken("function")).toBe("function");
  });

  test("preserves -tion exception: section → section", () => {
    expect(stemToken("section")).toBe("section");
  });

  test("preserves -tion exception: question → question", () => {
    expect(stemToken("question")).toBe("question");
  });

  // --- -ment ---
  test("strips -ment: deployment → deploy", () => {
    expect(stemToken("deployment")).toBe("deploy");
  });

  test("strips -ment: management → manage", () => {
    expect(stemToken("management")).toBe("manage");
  });

  test("strips -ment: environment → environ", () => {
    expect(stemToken("environment")).toBe("environ");
  });

  test("preserves -ment exception: element → element", () => {
    expect(stemToken("element")).toBe("element");
  });

  test("preserves -ment exception: comment → comment", () => {
    expect(stemToken("comment")).toBe("comment");
  });

  // --- -ly ---
  test("strips -ly: quickly → quick", () => {
    expect(stemToken("quickly")).toBe("quick");
  });

  test("strips -ly: automatically → automatical", () => {
    expect(stemToken("automatically")).toBe("automatical");
  });

  test("preserves -ly exception: only → only", () => {
    expect(stemToken("only")).toBe("only");
  });

  test("preserves -ly exception: early → early", () => {
    expect(stemToken("early")).toBe("early");
  });

  test("preserves -ly exception: apply → apply", () => {
    expect(stemToken("apply")).toBe("apply");
  });

  test("preserves -ly exception: supply → supply", () => {
    expect(stemToken("supply")).toBe("supply");
  });

  // --- -er ---
  test("strips -er: faster → fast", () => {
    expect(stemToken("faster")).toBe("fast");
  });

  test("strips -er: bigger → big", () => {
    expect(stemToken("bigger")).toBe("big");
  });

  test("preserves -er exception: server → server", () => {
    expect(stemToken("server")).toBe("server");
  });

  test("preserves -er exception: render → render", () => {
    expect(stemToken("render")).toBe("render");
  });

  test("preserves -er exception: container → container", () => {
    expect(stemToken("container")).toBe("container");
  });

  test("preserves -er exception: middleware → middleware", () => {
    expect(stemToken("middleware")).toBe("middleware");
  });

  // --- -est ---
  test("strips -est: fastest → fast", () => {
    expect(stemToken("fastest")).toBe("fast");
  });

  test("strips -est: biggest → big", () => {
    expect(stemToken("biggest")).toBe("big");
  });

  test("preserves -est exception: test → test", () => {
    expect(stemToken("test")).toBe("test");
  });

  test("preserves -est exception: request → request", () => {
    expect(stemToken("request")).toBe("request");
  });

  test("preserves -est exception: manifest → manifest", () => {
    expect(stemToken("manifest")).toBe("manifest");
  });

  // --- -ness ---
  test("strips -ness: darkness → dark", () => {
    expect(stemToken("darkness")).toBe("dark");
  });

  test("strips -ness: readiness → readi", () => {
    expect(stemToken("readiness")).toBe("readi");
  });

  test("preserves -ness exception: business → business", () => {
    expect(stemToken("business")).toBe("business");
  });

  // --- ecosystem post-stem normalization ---
  test("post-stem: styling → style", () => {
    expect(stemToken("styling")).toBe("style");
  });

  test("post-stem: routing → route", () => {
    expect(stemToken("routing")).toBe("route");
  });

  test("post-stem: revalidating → revalidate", () => {
    expect(stemToken("revalidating")).toBe("revalidate");
  });

  test("post-stem: scheduling → schedule", () => {
    expect(stemToken("scheduling")).toBe("schedule");
  });

  test("post-stem: initializing → initialize", () => {
    expect(stemToken("initializing")).toBe("initialize");
  });

  test("post-stem: optimizing → optimize", () => {
    expect(stemToken("optimizing")).toBe("optimize");
  });

  // --- short words (no stripping) ---
  test("does not stem words shorter than 4 chars", () => {
    expect(stemToken("the")).toBe("the");
    expect(stemToken("an")).toBe("an");
    expect(stemToken("go")).toBe("go");
    expect(stemToken("red")).toBe("red");
    expect(stemToken("bed")).toBe("bed");
  });

  // --- words with no matching suffix ---
  test("passes through words without target suffixes", () => {
    expect(stemToken("deploy")).toBe("deploy");
    expect(stemToken("config")).toBe("config");
    expect(stemToken("vercel")).toBe("vercel");
    expect(stemToken("nextjs")).toBe("nextjs");
  });
});

// ---------------------------------------------------------------------------
// stemText — full string stemming
// ---------------------------------------------------------------------------

describe("stemText", () => {
  test("stems each word in a sentence", () => {
    expect(stemText("deploying the application")).toBe("deploy the applica");
  });

  test("stems ecosystem terms in a sentence", () => {
    expect(stemText("caching and routing")).toBe("cache and route");
  });

  test("preserves spacing and non-word characters", () => {
    expect(stemText("running tests, quickly")).toBe("run tests, quick");
  });

  test("handles empty string", () => {
    expect(stemText("")).toBe("");
  });

  test("handles string with no stemmable words", () => {
    expect(stemText("the quick brown fox")).toBe("the quick brown fox");
  });

  test("preserves numbers mixed with text", () => {
    expect(stemText("deploying v2 is faster")).toBe("deploy v2 is fast");
  });
});
