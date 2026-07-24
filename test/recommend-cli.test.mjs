import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatRecommendSummary,
  parseRecommendOptions,
  resolveProviderName,
  runRecommend,
} from "../src/recommend-cli.mjs";
import { loadDashboardState, resolvePresetId } from "../src/dashboard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "recommend-cli-"));
  const stateRoot = join(home, "state");
  return {
    home,
    stateRoot,
    paths: {
      home,
      stateDirectory: join(stateRoot, "all-models-patch"),
      configDirectory: join(home, "config", "all-models-patch"),
    },
  };
}

function providerFixture() {
  const state = fixture();
  const toolRoot = mkdtempSync(join(tmpdir(), "recommend-tool-"));
  const configDirectory = join(toolRoot, "config");
  mkdirSync(configDirectory, { recursive: true });

  function rating(value, source = "fixture") {
    return { value, confidence: 0.8, source };
  }

  function profile(provider, ratings = {}) {
    return {
      providers: [provider],
      roles: ["test"],
      ratings: {
        aaCoding: rating(ratings.aaCoding ?? 50),
        aaAgentic: rating(ratings.aaAgentic ?? 50),
        aaIntelligence: rating(ratings.aaIntelligence ?? 50),
        taste: rating(ratings.taste ?? 50),
        coachability: rating(ratings.coachability ?? 50),
        efficiency: rating(ratings.efficiency ?? 50),
      },
      caveats: [],
    };
  }

  writeFileSync(join(configDirectory, "claude-all-agents.json"), `${JSON.stringify({
    "alpha-claude": { model: "model-a", description: "Claude profile", prompt: "test" },
    "beta-codex": { model: "model-b", description: "Codex profile", prompt: "test" },
    "gamma-grok": { model: "model-c", description: "Grok profile", prompt: "test" },
    "delta-kimi": { model: "model-d", description: "Kimi profile", prompt: "test" },
  })}\n`);

  writeFileSync(join(configDirectory, "claude-all-contexts.json"), `${JSON.stringify({
    schemaVersion: 1,
    models: {
      "model-a": { contextTokens: 200_000, compactAtTokens: 160_000, status: "verified", source: "test" },
      "model-b": { contextTokens: 200_000, compactAtTokens: 160_000, status: "verified", source: "test" },
      "model-c": { contextTokens: 200_000, compactAtTokens: 160_000, status: "verified", source: "test" },
      "model-d": { contextTokens: 200_000, compactAtTokens: 160_000, status: "verified", source: "test" },
    },
  })}\n`);

  writeFileSync(join(configDirectory, "model-recommendations.json"), `${JSON.stringify({
    schemaVersion: 1,
    profiles: {
      "alpha-claude": profile("claude", { aaCoding: 80, taste: 70 }),
      "beta-codex": profile("codex", { aaCoding: 75, speed: 90 }),
      "gamma-grok": profile("grok", { aaCoding: 70, speed: 85 }),
      "delta-kimi": profile("kimi", { aaCoding: 65, efficiency: 95 }),
    },
  }, null, 2)}\n`);

  return { ...state, toolRoot, configDirectory };
}

test("parseRecommendOptions: defaults, bare detection, alias pass-through, mutual exclusion", () => {
  assert.deepEqual(parseRecommendOptions([]), {
    preset: null,
    weights: null,
    providers: null,
    excludeProviders: null,
    preferProviders: null,
    all: false,
    json: false,
    bare: true,
  });

  const withPreset = parseRecommendOptions(["--preset", "fast"]);
  assert.equal(withPreset.preset, "fast");
  assert.equal(withPreset.bare, false);

  const withWeights = parseRecommendOptions(["--weights", '{"speed":100}']);
  assert.equal(withWeights.weights, '{"speed":100}');
  assert.equal(withWeights.bare, false);

  assert.throws(
    () => parseRecommendOptions(["--preset", "fast", "--weights", '{"speed":100}']),
    /--preset and --weights are mutually exclusive/,
  );
});

test("parseRecommendOptions: provider flags parsing and composition", () => {
  assert.deepEqual(parseRecommendOptions(["--provider", "claude,codex"]).providers, ["claude", "codex"]);
  assert.deepEqual(parseRecommendOptions(["--exclude-provider", "anthropic"]).excludeProviders, ["anthropic"]);
  assert.deepEqual(parseRecommendOptions(["--prefer-provider", "agy"]).preferProviders, ["agy"]);

  const composed = parseRecommendOptions(["--preset", "deep", "--exclude-provider", "claude", "--prefer-provider", "grok"]);
  assert.equal(composed.preset, "deep");
  assert.deepEqual(composed.excludeProviders, ["claude"]);
  assert.deepEqual(composed.preferProviders, ["grok"]);

  assert.throws(() => parseRecommendOptions(["--provider", "claude", "--prefer-provider", "grok"]), /meaningless/);
  assert.throws(() => parseRecommendOptions(["--provider"]), /--provider requires/);
  assert.throws(() => parseRecommendOptions(["--exclude-provider", "--json"]), /--exclude-provider requires/);
});

test("parseRecommendOptions: malformed weights JSON error", () => {
  assert.throws(
    () => parseRecommendOptions(["--weights", "not-json"]),
    /--weights must be valid JSON/,
  );
});

test("resolvePresetId: id, name, aliases, case-insensitivity, unknown", () => {
  const presets = [
    { id: "balanced", name: "Balanced" },
    { id: "fast-recon", name: "Fast recon" },
    { id: "taste-polish", name: "Taste & polish" },
  ];
  assert.equal(resolvePresetId("balanced", presets)?.id, "balanced");
  assert.equal(resolvePresetId("Fast Recon", presets)?.id, "fast-recon");
  assert.equal(resolvePresetId("fast", presets)?.id, "fast-recon");
  assert.equal(resolvePresetId("tasteful", presets)?.id, "taste-polish");
  assert.equal(resolvePresetId("TASTE", presets)?.id, "taste-polish");
  assert.equal(resolvePresetId("unknown", presets), null);
  assert.equal(resolvePresetId("", presets), null);
  assert.equal(resolvePresetId(null, presets), null);
});

test("resolveProviderName aliases", () => {
  assert.equal(resolveProviderName("agy"), "antigravity");
  assert.equal(resolveProviderName("Anthropic"), "claude");
  assert.equal(resolveProviderName("xai"), "grok");
  assert.equal(resolveProviderName("OpenAI"), "codex");
  assert.equal(resolveProviderName("moonshot"), "kimi");
  assert.equal(resolveProviderName("claude"), "claude");
  assert.equal(resolveProviderName(""), null);
  assert.equal(resolveProviderName(null), null);
});

test("runRecommend: rankings, preset resolution, custom weights, unknown preset", () => {
  const state = providerFixture();
  const now = new Date("2026-07-20T20:00:00Z");

  const fast = runRecommend({ toolRoot: state.toolRoot, paths: state.paths, now, options: { ...parseRecommendOptions(["--preset", "fast"]) } });
  assert.equal(fast.presetId, "fast-recon");
  assert.ok(fast.recommendations.length > 0);
  assert.equal(fast.recommendations[0].rank, 1);

  const custom = runRecommend({
    toolRoot: state.toolRoot,
    paths: state.paths,
    now,
    options: { ...parseRecommendOptions(["--weights", JSON.stringify({ efficiency: 100 })]), bare: false },
  });
  assert.equal(custom.presetId, "custom-weights");
  assert.equal(custom.recommendations[0].id, "delta-kimi");

  assert.throws(
    () => runRecommend({ toolRoot: state.toolRoot, paths: state.paths, now, options: parseRecommendOptions(["--preset", "no-such"]) }),
    /unknown preset: no-such\. Available:/,
  );

  const menu = fast.presets;
  assert.ok(menu.some((preset) => preset.id === "balanced" && preset.whenToUse));
  assert.deepEqual(menu.find((preset) => preset.id === "balanced").cues, ["do a balanced job", "just route sensibly"]);
});

test("runRecommend: provider hard filter", () => {
  const state = providerFixture();
  const now = new Date("2026-07-20T20:00:00Z");
  const result = runRecommend({
    toolRoot: state.toolRoot,
    paths: state.paths,
    now,
    options: parseRecommendOptions(["--provider", "codex,grok"]),
  });
  assert.deepEqual(result.providerFilter, ["codex", "grok"]);
  const ids = result.recommendations.map((r) => r.id);
  assert.ok(ids.includes("beta-codex"));
  assert.ok(ids.includes("gamma-grok"));
  assert.ok(!ids.includes("alpha-claude"));
  assert.equal(result.recommendations[0].rank, 1);
});

test("runRecommend: exclude-provider drops matching profiles", () => {
  const state = providerFixture();
  const now = new Date("2026-07-20T20:00:00Z");
  const result = runRecommend({
    toolRoot: state.toolRoot,
    paths: state.paths,
    now,
    options: parseRecommendOptions(["--exclude-provider", "claude,anthropic"]),
  });
  assert.deepEqual(result.providerExclusions, ["claude"]);
  const ids = result.recommendations.map((r) => r.id);
  assert.ok(!ids.includes("alpha-claude"));
  assert.ok(ids.includes("beta-codex"));
});

test("runRecommend: exclude-provider zero-remaining error lists providers", () => {
  const state = providerFixture();
  const now = new Date("2026-07-20T20:00:00Z");
  assert.throws(
    () => runRecommend({
      toolRoot: state.toolRoot,
      paths: state.paths,
      now,
      options: parseRecommendOptions(["--exclude-provider", "claude,codex,grok,kimi"]),
    }),
    /--exclude-provider removed all profiles\. Remaining providers:/,
  );
});

test("runRecommend: prefer-provider bias flips near-ties without mutating score", () => {
  const state = providerFixture();
  const now = new Date("2026-07-20T20:00:00Z");

  const baseline = runRecommend({
    toolRoot: state.toolRoot,
    paths: state.paths,
    now,
    options: parseRecommendOptions(["--preset", "balanced"]),
  });

  const preferGrok = runRecommend({
    toolRoot: state.toolRoot,
    paths: state.paths,
    now,
    options: parseRecommendOptions(["--preset", "balanced", "--prefer-provider", "grok"]),
  });

  const baselineGrok = baseline.recommendations.find((r) => r.id === "gamma-grok");
  const grokEntry = preferGrok.recommendations.find((r) => r.id === "gamma-grok");
  assert.equal(grokEntry.preferenceBonus, 8);
  assert.ok(typeof grokEntry.score === "number");
  // True weighted score is preserved; only the sort key receives the visible bonus.
  assert.equal(grokEntry.score, baselineGrok.score);

  const baselineRank = baseline.recommendations.findIndex((r) => r.id === "gamma-grok") + 1;
  const preferRank = preferGrok.recommendations.findIndex((r) => r.id === "gamma-grok") + 1;
  assert.ok(preferRank <= baselineRank, "preferred provider should rank at least as high");
  assert.equal(preferGrok.recommendations[0].rank, 1);
});

test("runRecommend: provider filter zero-match error lists available providers", () => {
  const state = providerFixture();
  const now = new Date("2026-07-20T20:00:00Z");
  assert.throws(
    () => runRecommend({
      toolRoot: state.toolRoot,
      paths: state.paths,
      now,
      options: parseRecommendOptions(["--provider", "ollama"]),
    }),
    /no profiles match providers: ollama\. Available providers:/,
  );
});

test("formatRecommendSummary: bare presets block, header, dimensions, trailer", () => {
  const state = providerFixture();
  const now = new Date("2026-07-20T20:00:00Z");
  const result = runRecommend({
    toolRoot: state.toolRoot,
    paths: state.paths,
    now,
    options: parseRecommendOptions([]),
  });
  const text = formatRecommendSummary(result, { bare: true });
  assert.match(text, /^Presets:/m);
  assert.match(text, /balanced — Default blend when no mode is stated\. \(cues: "do a balanced job", "just route sensibly"\)/);
  assert.match(text, /Preset: balanced · generated /);
  assert.match(text, /#1 /);
});

test("loadDashboardState includes preset metadata", () => {
  const state = providerFixture();
  const now = new Date("2026-07-20T20:00:00Z");
  const dashboard = loadDashboardState({ toolRoot: state.toolRoot, paths: state.paths, now });
  const balanced = dashboard.presets.find((preset) => preset.id === "balanced");
  assert.equal(balanced.whenToUse, "Default blend when no mode is stated.");
  assert.deepEqual(balanced.cues, ["do a balanced job", "just route sensibly"]);
});
