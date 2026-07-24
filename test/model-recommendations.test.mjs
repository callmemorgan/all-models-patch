import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_RUNWAY_BASELINE_TOKENS,
  DEFAULT_WEIGHTS,
  DIMENSION_LABELS,
  SPEED_COMPARISON_OUTPUT_TOKENS,
  contextUtility,
  migrateLegacyWeights,
  normalizeWeights,
  quotaUtility,
  scoreRecommendations,
  speedUtility,
} from "../src/model-recommendations.mjs";

test("default weights cover every labeled dimension and sum to 100", () => {
  assert.deepEqual(Object.keys(DEFAULT_WEIGHTS), Object.keys(DIMENSION_LABELS));
  assert.equal(Object.values(DEFAULT_WEIGHTS).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(Object.isFrozen(DEFAULT_WEIGHTS), true);
  assert.equal(Object.isFrozen(DIMENSION_LABELS), true);
});

test("normalizes defaults and merges partial saved presets", () => {
  const defaults = normalizeWeights();
  assert.equal(Object.values(defaults).reduce((sum, value) => sum + value, 0), 1);
  assert.equal(defaults.aaCoding, 0.16);

  const partial = normalizeWeights({ speed: 100 });
  assert.equal(partial.speed, 100 / 186);
  assert.equal(partial.aaCoding, 16 / 186);
});

test("migrateLegacyWeights renames capability, drops publicRating, and preserves others", () => {
  assert.equal(migrateLegacyWeights(null), null);
  assert.equal(migrateLegacyWeights(undefined), undefined);
  assert.equal(migrateLegacyWeights(42), 42);
  assert.deepEqual(migrateLegacyWeights(["x"]), ["x"]);

  const input = { capability: 20, publicRating: 8, taste: 18, speed: 14 };
  const migrated = migrateLegacyWeights(input);
  assert.deepEqual(migrated, { aaCoding: 20, taste: 18, speed: 14 });
  assert.deepEqual(input, { capability: 20, publicRating: 8, taste: 18, speed: 14 });
  assert.equal(Object.hasOwn(migrated, "capability"), false);
  assert.equal(Object.hasOwn(migrated, "publicRating"), false);

  assert.deepEqual(
    migrateLegacyWeights({ capability: 20, aaCoding: 30, publicRating: 5, taste: 10 }),
    { aaCoding: 50, taste: 10 },
  );
  assert.deepEqual(
    migrateLegacyWeights({ capability: 80, aaCoding: 40 }),
    { aaCoding: 100 },
  );
  assert.deepEqual(migrateLegacyWeights({ taste: 12, efficiency: 5 }), { taste: 12, efficiency: 5 });
});

test("rejects invalid, unknown, and all-zero weights", () => {
  assert.throws(() => normalizeWeights(null), /weights must be an object/);
  assert.throws(() => normalizeWeights({ speed: Number.NaN }), /finite number/);
  assert.throws(() => normalizeWeights({ speed: -1 }), /finite number/);
  assert.throws(() => normalizeWeights({ speed: 101 }), /finite number/);
  assert.throws(() => normalizeWeights({ vibes: 10 }), /unknown recommendation weight/);
  assert.throws(
    () => normalizeWeights(Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0]))),
    /at least one/,
  );
});

test("weight validation failures are client errors, not server faults", () => {
  const invalid = [
    null,
    { speed: Number.NaN },
    { vibes: 10 },
    Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0])),
  ];
  for (const weights of invalid) {
    assert.throws(() => normalizeWeights(weights), (error) => {
      assert.equal(error.statusCode, 400, `${JSON.stringify(weights)} did not map to HTTP 400`);
      return true;
    });
  }
});

test("speed utility estimates latency and applies logarithmic diminishing returns", () => {
  const utility = speedUtility({ ttftMS: 1_000, postFirstTokenTPS: 100 });
  assert.equal(utility.effectiveLatencyMS, 6_000);
  assert.equal(utility.comparisonOutputTokens, SPEED_COMPARISON_OUTPUT_TOKENS);
  assert.equal(utility.expectedOutputTokens, SPEED_COMPARISON_OUTPUT_TOKENS);
  assert.ok(utility.value > 50 && utility.value < 60);
  assert.equal(utility.confidence, 1);
  assert.match(utility.explanation, /Fixed 500-token comparison workload/);

  const twiceAsFast = speedUtility({ ttftMS: 0, postFirstTokenTPS: 100 });
  const fourTimesAsFast = speedUtility({ ttftMS: 0, postFirstTokenTPS: 200 });
  const slow = speedUtility({ ttftMS: 0, postFirstTokenTPS: 50 });
  const firstDoubling = fourTimesAsFast.value - twiceAsFast.value;
  const secondDoubling = twiceAsFast.value - slow.value;
  assert.ok(Math.abs(firstDoubling - secondDoubling) < 0.00001);
});

test("speed utility ignores legacy human output estimates", () => {
  const tiny = speedUtility({ ttftMS: 1_000, postFirstTokenTPS: 100, expectedOutputTokens: 1 });
  const huge = speedUtility({ ttftMS: 1_000, postFirstTokenTPS: 100, expectedOutputTokens: 1_000_000 });
  assert.deepEqual(tiny, huge);
  assert.equal(tiny.effectiveLatencyMS, 6_000);
});

test("speed utility saturates and safely neutralizes invalid measurements", () => {
  assert.equal(speedUtility({ ttftMS: 10, postFirstTokenTPS: 10_000 }).value, 100);
  assert.equal(speedUtility({ ttftMS: 60_000, postFirstTokenTPS: 1 }).value, 0);
  for (const input of [undefined, null, {}, { ttftMS: 1, postFirstTokenTPS: 0 }, { ttftMS: -1, postFirstTokenTPS: 10 }]) {
    assert.deepEqual(
      { value: speedUtility(input).value, confidence: speedUtility(input).confidence },
      { value: 50, confidence: 0 },
    );
  }
});

test("quota utility uses the bottleneck window and gives deterministic reset relief", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const utility = quotaUtility({
    now,
    providers: {
      claude: {
        state: "available",
        windows: [
          { id: "5h", label: "Claude 5h", usedPercent: 90, resetAt: "2026-07-20T18:00:00Z" },
          { id: "7d", label: "Claude 7d", usedPercent: 20, resetAt: "2026-07-25T12:00:00Z" },
        ],
      },
    },
  });

  // 10% remaining with a reset 6h into a 24h horizon: 10 + 90 * .75.
  assert.equal(utility.value, 77.5);
  assert.equal(utility.selectedProvider, "claude");
  assert.equal(utility.providers[0].bottleneckWindow, "5h");
  assert.match(utility.explanation, /best applicable route/);
});

test("quota utility chooses the best alternative provider", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const utility = quotaUtility({
    now,
    providers: {
      claude: { windows: [{ id: "weekly", remainingPercent: 20 }] },
      antigravity: { windows: [{ id: "weekly", remainingPercent: 70 }] },
    },
  });
  assert.equal(utility.value, 70);
  assert.equal(utility.selectedProvider, "antigravity");
  assert.equal(utility.confidence, 0.8);
});

test("quota utility supports usage aliases, unix reset seconds, and unknown data", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const resetSeconds = (now + 24 * 60 * 60 * 1_000) / 1_000;
  const result = quotaUtility({
    now: new Date(now),
    providers: [{ id: "grok", windows: [{ usagePercent: 35, resetsAt: resetSeconds }] }],
  });
  assert.equal(result.value, 65);
  assert.equal(result.providers[0].windows[0].remainingPercent, 65);
  assert.deepEqual(
    { value: quotaUtility({ providers: {} }).value, confidence: quotaUtility({ providers: {} }).confidence },
    { value: 50, confidence: 0 },
  );
  assert.deepEqual(
    { value: quotaUtility({ providers: { bad: { windows: [{}] } } }).value, confidence: quotaUtility({ providers: { bad: { windows: [{}] } } }).confidence },
    { value: 50, confidence: 0 },
  );
});

test("context utility rewards pre-compaction runway with diminishing returns", () => {
  assert.equal(CONTEXT_RUNWAY_BASELINE_TOKENS, 100_000);
  assert.equal(contextUtility({ compactAtTokens: 100_000 }).value, 40);
  assert.equal(contextUtility({ compactAtTokens: 200_000 }).value, 55);
  assert.equal(contextUtility({ compactAtTokens: 400_000 }).value, 70);
  assert.equal(contextUtility({ compactAtTokens: 800_000 }).value, 85);
  assert.equal(contextUtility({ compactAtTokens: 1_600_000 }).value, 100);
  assert.equal(contextUtility({ compactAtTokens: 3_200_000 }).value, 100);
  assert.match(contextUtility({ compactAtTokens: 400_000 }).explanation, /soft logarithmic curve/);
});

test("context utility prefers compaction runway, falls back to capacity, and never guesses eligibility", () => {
  const preferred = contextUtility({ compactAtTokens: 200_000, contextTokens: 1_600_000 });
  assert.equal(preferred.runwayTokens, 200_000);
  assert.equal(preferred.value, 55);
  assert.equal(preferred.eligible, true);

  const fallback = contextUtility({ contextTokens: 400_000 });
  assert.equal(fallback.runwayTokens, 400_000);
  assert.equal(fallback.value, 70);

  // Legacy callers may still pass a guessed requirement; it has no effect.
  const legacy = contextUtility({ contextTokens: 100_000, requiredContextTokens: 10_000_000 });
  assert.equal(legacy.value, 40);
  assert.equal(legacy.eligible, true);
  assert.equal("hardEligible" in legacy, false);
});

test("context utility makes missing inputs neutral rather than zero", () => {
  assert.deepEqual(
    (({ value, confidence, eligible }) => ({ value, confidence, eligible }))(contextUtility({})),
    { value: 50, confidence: 0, eligible: true },
  );
});

test("scores confidence-shrunk dimensions and reports each contribution", () => {
  const weights = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0]));
  weights.taste = 50;
  weights.speed = 50;
  const [result] = scoreRecommendations([{
    id: "balanced",
    reasons: ["good fit"],
    dimensions: {
      taste: { value: 100, confidence: 0.5, source: "personal" },
      speed: { value: 0, confidence: 1, source: "benchmark" },
    },
  }], { weights });

  // Taste shrinks to 75; speed remains 0, producing (75 + 0) / 2.
  assert.equal(result.score, 37.5);
  assert.equal(result.overallScore, 37.5);
  assert.equal(result.rank, 1);
  assert.deepEqual(result.reasons, ["good fit"]);
  assert.equal(result.contributions.length, Object.keys(DEFAULT_WEIGHTS).length);
  const taste = result.contributions.find((item) => item.dimensionId === "taste");
  assert.deepEqual(taste, {
    dimensionId: "taste",
    label: "Personal taste",
    value: 100,
    confidence: 0.5,
    adjustedValue: 75,
    weight: 50,
    contribution: 37.5,
    deltaFromNeutral: 12.5,
    source: "personal",
    missing: false,
  });
});

test("missing and malformed dimensions remain neutral", () => {
  const weights = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0]));
  weights.taste = 100;
  const results = scoreRecommendations([
    { id: "missing", dimensions: {} },
    { id: "malformed", dimensions: { taste: { value: 500, confidence: 1 } } },
    { id: "numeric", dimensions: { taste: 80 } },
  ], { weights });
  assert.deepEqual(results.map((item) => item.score), [80, 50, 50]);
  assert.equal(results[1].contributions.find((item) => item.dimensionId === "taste").missing, true);
});

test("returns profile- and dimension-level hard failures unranked, never as eligible", () => {
  const results = scoreRecommendations([
    { id: "available", dimensions: { taste: 50 } },
    { id: "route-down", eligible: false, reasons: ["route unavailable"], dimensions: { taste: 100 } },
    { id: "privacy-mismatch", dimensions: { aaCoding: { value: 100, confidence: 1, eligible: false } } },
  ]);
  assert.deepEqual(results.map((item) => item.id), ["available", "route-down", "privacy-mismatch"]);

  const ranked = results.filter((item) => item.eligible);
  assert.deepEqual(ranked.map((item) => item.id), ["available"]);
  assert.equal(ranked[0].rank, 1);

  for (const item of results.filter((item) => !item.eligible)) {
    assert.equal(item.score, null, `${item.id} kept a score`);
    assert.equal(item.rank, null, `${item.id} kept a rank`);
    assert(item.reasons.length > 0, `${item.id} carried no reason`);
  }
  assert.deepEqual(results.find((item) => item.id === "route-down").reasons, ["route unavailable"]);
  assert.match(results.find((item) => item.id === "privacy-mismatch").reasons[0], /ineligible/);
});

test("ranks by score, keeps stable tie order, and does not mutate profiles", () => {
  const profiles = [
    { id: "middle", dimensions: { aaCoding: 50 } },
    { id: "high", dimensions: { aaCoding: 90 } },
    { id: "middle-two", dimensions: { aaCoding: 50 } },
  ];
  const snapshot = structuredClone(profiles);
  const weights = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0]));
  weights.aaCoding = 100;
  const results = scoreRecommendations(profiles, { weights });
  assert.deepEqual(results.map((item) => item.id), ["high", "middle", "middle-two"]);
  assert.deepEqual(results.map((item) => item.rank), [1, 2, 3]);
  assert.deepEqual(profiles, snapshot);
});

test("can derive speed, quota, and context dimensions from profile evidence", () => {
  const weights = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0]));
  weights.speed = 34;
  weights.quota = 33;
  weights.context = 33;
  const now = Date.parse("2026-07-20T12:00:00Z");
  const [result] = scoreRecommendations([{
    id: "derived",
    benchmark: { ttftMS: 1_000, postFirstTokenTPS: 100 },
    quotaProviders: { grok: { windows: [{ remainingPercent: 80 }] } },
    compactAtTokens: 400_000,
    contextTokens: 1_000_000,
  }], {
    weights,
    // Legacy knobs are deliberately ignored, but accepting them keeps older
    // callers source-compatible.
    expectedOutputTokens: 1,
    requiredContextTokens: 10_000_000,
    now,
  });

  assert.equal(result.contributions.find((item) => item.dimensionId === "speed").missing, false);
  assert.equal(result.contributions.find((item) => item.dimensionId === "quota").value, 80);
  assert.equal(result.contributions.find((item) => item.dimensionId === "context").value, 70);
});

test("rejects malformed profile collections", () => {
  assert.throws(() => scoreRecommendations({}), /profiles must be an array/);
  assert.throws(() => scoreRecommendations([null]), /profile at index 0/);
});
