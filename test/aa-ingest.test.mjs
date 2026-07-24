import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyAaIngest,
  applyAaVariant,
  computeEfficiencyRatings,
  parseAaIngestOptions,
  runAaIngest,
  selectAaVariantSlug,
  serializeRecommendations,
  variantCostBasis,
  writeRecommendationsDocument,
} from "../src/aa-ingest.mjs";
import { validateShippedModelConfigs } from "../src/model-configs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function baseProfile(overrides = {}) {
  return {
    providers: ["test"],
    roles: ["implementation"],
    ratings: {
      aaCoding: { value: null, confidence: 0, source: "not-rated" },
      aaAgentic: { value: null, confidence: 0, source: "not-rated" },
      aaIntelligence: { value: null, confidence: 0, source: "not-rated" },
      taste: { value: 70, confidence: 0.5, source: "fixture" },
      coachability: { value: 40, confidence: 0.5, source: "fixture" },
      efficiency: { value: 20, confidence: 0.5, source: "fixture" },
    },
    caveats: [],
    ...overrides,
  };
}

function variant({
  aaSlug,
  coding = 50,
  agentic = 40,
  intelligence = 30,
  totalCost = null,
  input = 2,
  output = 6,
  ttftAnswer = 1.5,
  tps = 80,
} = {}) {
  const entry = {
    aaSlug,
    aaId: `${aaSlug}-id`,
    aaName: aaSlug,
    evaluations: {
      artificial_analysis_intelligence_index: intelligence,
      artificial_analysis_coding_index: coding,
      artificial_analysis_agentic_index: agentic,
    },
    pricing: {
      price_1m_input_tokens: input,
      price_1m_output_tokens: output,
    },
    performance: {
      median_output_tokens_per_second: tps,
      median_time_to_first_token_seconds: ttftAnswer,
      median_time_to_first_answer_token_seconds: ttftAnswer,
      median_end_to_end_response_time_seconds: ttftAnswer + 1,
    },
    intelligenceIndexCost: totalCost == null ? null : { total_cost: totalCost },
  };
  return entry;
}

function extractFor(agents, extras = {}) {
  return {
    generatedAt: "2026-07-23",
    intelligenceIndexVersion: "4.1",
    attribution: "https://artificialanalysis.ai/",
    agents,
    ...extras,
  };
}

function tempToolRoot(seedRecommendations) {
  const root = mkdtempSync(join(tmpdir(), "aa-ingest-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  cpSync(join(repoRoot, "config", "claude-all-agents.json"), join(configDir, "claude-all-agents.json"));
  cpSync(join(repoRoot, "config", "claude-all-contexts.json"), join(configDir, "claude-all-contexts.json"));
  writeFileSync(
    join(configDir, "model-recommendations.json"),
    serializeRecommendations(seedRecommendations),
  );
  return root;
}

function shippedRecommendations() {
  return JSON.parse(readFileSync(join(repoRoot, "config", "model-recommendations.json"), "utf8"));
}

test("parseAaIngestOptions requires --input and accepts --write", () => {
  assert.deepEqual(parseAaIngestOptions(["--input", "x.json"]), { inputPath: "x.json", write: false });
  assert.deepEqual(parseAaIngestOptions(["--write", "--input", "x.json"]), { inputPath: "x.json", write: true });
  assert.throws(() => parseAaIngestOptions([]), /usage: all-models-patch aa-ingest/);
  assert.throws(() => parseAaIngestOptions(["--input"]), /--input requires a path/);
  assert.throws(() => parseAaIngestOptions(["--input", "x.json", "--nope"]), /unknown aa-ingest option/);
});

test("selectAaVariantSlug prefers highest coding index; nulls rank last; ties keep first", () => {
  const variants = [
    variant({ aaSlug: "a", coding: 70 }),
    variant({ aaSlug: "b", coding: 80 }),
    variant({ aaSlug: "c", coding: 80 }),
    variant({ aaSlug: "d", coding: null }),
  ];
  assert.equal(selectAaVariantSlug(variants), "b");
  assert.equal(selectAaVariantSlug([
    variant({ aaSlug: "null-first", coding: null }),
    variant({ aaSlug: "scored", coding: 10 }),
  ]), "scored");
  assert.equal(selectAaVariantSlug([
    variant({ aaSlug: "only-null", coding: null }),
  ]), "only-null");
});

test("existing still-valid selection is preserved; vanished selection falls back to highest", () => {
  const variants = [
    variant({ aaSlug: "low", coding: 10 }),
    variant({ aaSlug: "high", coding: 90 }),
    variant({ aaSlug: "mid", coding: 50 }),
  ];
  assert.equal(selectAaVariantSlug(variants, "mid"), "mid");
  assert.equal(selectAaVariantSlug(variants, "gone"), "high");
});

test("applyAaVariant returns a new object, recomputes AA ratings + speedMetrics, leaves efficiency/taste alone", () => {
  const profile = baseProfile({
    aaVariants: [
      variant({
        aaSlug: "v1",
        coding: 76.5,
        agentic: 52.8,
        intelligence: 59.9,
        ttftAnswer: 1.25,
        tps: 73.09,
      }),
    ],
    efficiency: { value: 12, confidence: 0.4, source: "keep-me" },
  });
  // Stash efficiency under ratings for the real shape used in production.
  profile.ratings.efficiency = { value: 12, confidence: 0.4, source: "keep-me" };
  profile.ratings.taste = { value: 88, confidence: 0.9, source: "keep-taste" };
  profile.ratings.coachability = { value: 33, confidence: 0.2, source: "keep-coach" };

  const meta = { indexVersion: "4.1", fetchedAt: "2026-07-23" };
  const next = applyAaVariant(profile, "v1", meta);

  assert.notEqual(next, profile);
  assert.equal(profile.selectedAaVariant, undefined);
  assert.equal(next.selectedAaVariant, "v1");
  assert.deepEqual(next.ratings.aaCoding, {
    value: 76.5,
    confidence: 1,
    source: "artificialanalysis",
    variant: "v1",
    indexVersion: "4.1",
    fetchedAt: "2026-07-23",
  });
  assert.deepEqual(next.ratings.aaAgentic, {
    value: 52.8,
    confidence: 1,
    source: "artificialanalysis",
    variant: "v1",
    indexVersion: "4.1",
    fetchedAt: "2026-07-23",
  });
  assert.deepEqual(next.ratings.aaIntelligence, {
    value: 59.9,
    confidence: 1,
    source: "artificialanalysis",
    variant: "v1",
    indexVersion: "4.1",
    fetchedAt: "2026-07-23",
  });
  assert.deepEqual(next.speedMetrics, {
    ttftMS: 1250,
    postFirstTokenTPS: 73.09,
    source: "artificialanalysis",
  });
  assert.deepEqual(next.ratings.efficiency, { value: 12, confidence: 0.4, source: "keep-me" });
  assert.deepEqual(next.ratings.taste, { value: 88, confidence: 0.9, source: "keep-taste" });
  assert.deepEqual(next.ratings.coachability, { value: 33, confidence: 0.2, source: "keep-coach" });
});

test("null coding index variant produces the unscored rating shape", () => {
  const profile = baseProfile({
    aaVariants: [variant({ aaSlug: "unscored", coding: null, agentic: null, intelligence: null })],
  });
  const next = applyAaVariant(profile, "unscored", { indexVersion: "4.1", fetchedAt: "2026-07-23" });
  assert.deepEqual(next.ratings.aaCoding, {
    value: null,
    confidence: 0,
    source: "artificialanalysis-unscored",
    variant: "unscored",
  });
  assert.equal(next.ratings.aaAgentic.source, "artificialanalysis-unscored");
  assert.equal(next.ratings.aaIntelligence.source, "artificialanalysis-unscored");
});

test("efficiency: 3-profile fixture matches hand-computed log-scale values", () => {
  // costs 10, 100, 1000 → scores 100.0, 50.0, 0.0
  const selected = {
    cheap: variant({ aaSlug: "cheap", totalCost: 10 }),
    mid: variant({ aaSlug: "mid", totalCost: 100 }),
    expensive: variant({ aaSlug: "expensive", totalCost: 1000 }),
  };
  const ratings = computeEfficiencyRatings(selected);
  assert.equal(ratings.cheap.value, 100);
  assert.equal(ratings.mid.value, 50);
  assert.equal(ratings.expensive.value, 0);
  assert.equal(ratings.cheap.confidence, 0.7);
  assert.equal(ratings.cheap.source, "artificialanalysis-cost");
  assert.equal(ratings.cheap.basis, "index-run-cost");
  assert.match(ratings.cheap.explanation, /log scale 10 \(100\) to 1000 \(0\)/);
});

test("efficiency: blended-price fallback and single-profile degenerate case", () => {
  const blended = variant({ aaSlug: "blend", totalCost: null, input: 2, output: 6 });
  assert.deepEqual(variantCostBasis(blended), { cost: 3, basis: "blended-price" });

  const solo = computeEfficiencyRatings({ only: blended });
  assert.equal(solo.only.value, 50);
  assert.equal(solo.only.basis, "blended-price");

  const twoBlended = computeEfficiencyRatings({
    a: variant({ aaSlug: "a", totalCost: null, input: 1, output: 1 }), // (3+1)/4 = 1
    b: variant({ aaSlug: "b", totalCost: null, input: 4, output: 4 }), // (12+4)/4 = 4
  });
  assert.equal(twoBlended.a.basis, "blended-price");
  assert.equal(twoBlended.b.basis, "blended-price");
  assert.equal(twoBlended.a.value, 100);
  assert.equal(twoBlended.b.value, 0);
});

test("dry-run does not modify the config file", () => {
  const seed = shippedRecommendations();
  const toolRoot = tempToolRoot(seed);
  const recommendationsPath = join(toolRoot, "config", "model-recommendations.json");
  const before = readFileSync(recommendationsPath, "utf8");

  const inputPath = join(toolRoot, "extract.json");
  writeFileSync(inputPath, JSON.stringify(extractFor({
    "fable-5": { variants: [variant({ aaSlug: "claude-fable-5", coding: 76.5, totalCost: 100 })] },
  })));

  const result = runAaIngest({ toolRoot, inputPath, write: false });
  assert.equal(result.wrote, false);
  assert.equal(result.summaries.length, 1);
  assert.equal(readFileSync(recommendationsPath, "utf8"), before);
});

test("--write produces valid JSON that still passes validateShippedModelConfigs", () => {
  const seed = shippedRecommendations();
  const toolRoot = tempToolRoot(seed);
  const inputPath = join(toolRoot, "extract.json");
  writeFileSync(inputPath, JSON.stringify(extractFor({
    "fable-5": {
      variants: [
        variant({ aaSlug: "claude-fable-5", coding: 76.5, agentic: 52.8, intelligence: 59.9, totalCost: 5630.52 }),
      ],
    },
    "sonnet-5": {
      variants: [
        variant({ aaSlug: "claude-sonnet-5", coding: 71.5, totalCost: 1000 }),
        variant({ aaSlug: "claude-sonnet-5-non-reasoning", coding: 66.4, totalCost: 500 }),
      ],
    },
  })));

  const result = runAaIngest({ toolRoot, inputPath, write: true });
  assert.equal(result.wrote, true);
  assert.doesNotThrow(() => validateShippedModelConfigs(toolRoot));

  const written = JSON.parse(readFileSync(join(toolRoot, "config", "model-recommendations.json"), "utf8"));
  assert.equal(written.profiles["fable-5"].selectedAaVariant, "claude-fable-5");
  assert.equal(written.profiles["sonnet-5"].selectedAaVariant, "claude-sonnet-5");
  assert.equal(written.profiles["fable-5"].aaVariants.length, 1);
  assert.equal(written.profiles["sonnet-5"].aaVariants.length, 2);
  assert.equal(written.aaMeta.intelligenceIndexVersion, "4.1");
  assert.equal(written.aaMeta.fetchedAt, "2026-07-23");
  assert.equal(written.aaMeta.extractPath, inputPath);
  assert.equal(written.aaMeta.attribution, "https://artificialanalysis.ai/");
});

test("re-ingest with the same extract is idempotent (byte-identical second write)", () => {
  const seed = shippedRecommendations();
  const toolRoot = tempToolRoot(seed);
  const inputPath = join(toolRoot, "extract.json");
  writeFileSync(inputPath, JSON.stringify(extractFor({
    "haiku-4-5": { variants: [variant({ aaSlug: "claude-haiku-4-5", coding: 40, totalCost: 50 })] },
  })));

  runAaIngest({ toolRoot, inputPath, write: true });
  const first = readFileSync(join(toolRoot, "config", "model-recommendations.json"));
  runAaIngest({ toolRoot, inputPath, write: true });
  const second = readFileSync(join(toolRoot, "config", "model-recommendations.json"));
  assert.equal(Buffer.compare(first, second), 0);
});

test("profiles absent from extract (or empty variants) stay byte-identical after write", () => {
  const seed = shippedRecommendations();
  const absentName = "grok-composer-2-5-fast";
  assert.ok(seed.profiles[absentName], "fixture assumes shipped roster includes grok-composer-2-5-fast");
  const beforeAbsent = serializeRecommendations({ [absentName]: seed.profiles[absentName] });

  const toolRoot = tempToolRoot(seed);
  const inputPath = join(toolRoot, "extract.json");
  writeFileSync(inputPath, JSON.stringify(extractFor({
    "fable-5": { variants: [variant({ aaSlug: "claude-fable-5", coding: 70, totalCost: 10 })] },
    [absentName]: { variants: [], unbenched: true },
  })));

  runAaIngest({ toolRoot, inputPath, write: true });
  const written = JSON.parse(readFileSync(join(toolRoot, "config", "model-recommendations.json"), "utf8"));
  const afterAbsent = serializeRecommendations({ [absentName]: written.profiles[absentName] });
  assert.equal(afterAbsent, beforeAbsent);
  assert.equal(Object.hasOwn(written.profiles[absentName], "aaVariants"), false);
  assert.equal(Object.hasOwn(written.profiles[absentName], "selectedAaVariant"), false);
});

test("selection preservation and highest-coding fallback through applyAaIngest", () => {
  const config = {
    schemaVersion: 1,
    profiles: {
      multi: baseProfile({ selectedAaVariant: "mid" }),
      fresh: baseProfile(),
      stale: baseProfile({ selectedAaVariant: "vanished" }),
    },
  };
  const extract = extractFor({
    multi: {
      variants: [
        variant({ aaSlug: "low", coding: 10, totalCost: 100 }),
        variant({ aaSlug: "high", coding: 90, totalCost: 100 }),
        variant({ aaSlug: "mid", coding: 50, totalCost: 100 }),
      ],
    },
    fresh: {
      variants: [
        variant({ aaSlug: "a", coding: 20, totalCost: 100 }),
        variant({ aaSlug: "b", coding: 60, totalCost: 100 }),
      ],
    },
    stale: {
      variants: [
        variant({ aaSlug: "x", coding: 11, totalCost: 100 }),
        variant({ aaSlug: "y", coding: 22, totalCost: 100 }),
      ],
    },
  });

  const { document } = applyAaIngest(config, extract, { inputPath: "fixture.json" });
  assert.equal(document.profiles.multi.selectedAaVariant, "mid");
  assert.equal(document.profiles.fresh.selectedAaVariant, "b");
  assert.equal(document.profiles.stale.selectedAaVariant, "y");
});

test("missing or invalid input yields a clear error", () => {
  const seed = shippedRecommendations();
  const toolRoot = tempToolRoot(seed);
  assert.throws(
    () => runAaIngest({ toolRoot, inputPath: join(toolRoot, "missing.json"), write: false }),
    /AA extract not found/,
  );

  const badPath = join(toolRoot, "bad.json");
  writeFileSync(badPath, "{not-json");
  assert.throws(
    () => runAaIngest({ toolRoot, inputPath: badPath, write: false }),
    /not valid JSON/,
  );

  const emptyAgents = join(toolRoot, "empty-agents.json");
  writeFileSync(emptyAgents, JSON.stringify({ generatedAt: "x" }));
  assert.throws(
    () => runAaIngest({ toolRoot, inputPath: emptyAgents, write: false }),
    /expected top-level agents object/,
  );
});

test("writeRecommendationsDocument is atomic (temp + rename)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-write-"));
  const path = join(dir, "model-recommendations.json");
  writeRecommendationsDocument(path, { schemaVersion: 1, profiles: {} });
  assert.equal(readFileSync(path, "utf8"), serializeRecommendations({ schemaVersion: 1, profiles: {} }));
});
