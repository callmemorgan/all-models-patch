import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createDashboardApp,
  deleteDashboardPreset,
  loadDashboardState,
  loadLatestBenchmarks,
  parseDashboardOptions,
  readDashboardPresets,
  recommendFromState,
  refreshQuotaCache,
  saveDashboardPreset,
  selectAaVariant,
} from "../src/dashboard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "model-cockpit-"));
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

function aaVariantFixture() {
  const state = fixture();
  const toolRoot = mkdtempSync(join(tmpdir(), "model-cockpit-tool-"));
  const configDirectory = join(toolRoot, "config");
  mkdirSync(configDirectory, { recursive: true });
  const missingRating = () => ({ value: null, confidence: 0, source: "not-rated" });
  const baseRatings = {
    aaCoding: {
      value: 70,
      confidence: 0.9,
      source: "artificial-analysis",
      variant: "model-default",
      indexVersion: "1.0",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    },
    aaAgentic: {
      value: 65,
      confidence: 0.9,
      source: "artificial-analysis",
      variant: "model-default",
      indexVersion: "1.0",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    },
    aaIntelligence: {
      value: 72,
      confidence: 0.9,
      source: "artificial-analysis",
      variant: "model-default",
      indexVersion: "1.0",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    },
    taste: missingRating(),
    coachability: missingRating(),
    efficiency: missingRating(),
  };
  const aaVariants = [
    {
      aaSlug: "model-default",
      aaName: "Default",
      evaluations: {
        artificial_analysis_coding_index: 70,
        artificial_analysis_agentic_index: 65,
        artificial_analysis_intelligence_index: 72,
      },
      performance: {
        median_output_tokens_per_second: 80,
        median_time_to_first_answer_token_seconds: 0.4,
      },
      pricing: { price_1m_blended_3_to_1: 1 },
    },
    {
      aaSlug: "model-high",
      aaName: "High",
      evaluations: {
        artificial_analysis_coding_index: 88,
        artificial_analysis_agentic_index: 84,
        artificial_analysis_intelligence_index: 90,
      },
      performance: {
        median_output_tokens_per_second: 40,
        median_time_to_first_answer_token_seconds: 1.2,
      },
      pricing: { price_1m_blended_3_to_1: 5 },
    },
  ];
  writeFileSync(join(configDirectory, "claude-all-agents.json"), `${JSON.stringify({
    "aa-model": { model: "aa-model", description: "AA-backed profile", prompt: "test" },
    "plain-model": { model: "plain-model", description: "No AA variants", prompt: "test" },
  })}\n`);
  writeFileSync(join(configDirectory, "claude-all-contexts.json"), `${JSON.stringify({
    schemaVersion: 1,
    models: {
      "aa-model": { contextTokens: 200_000, compactAtTokens: 160_000, status: "verified", source: "test" },
      "plain-model": { contextTokens: 100_000, compactAtTokens: 80_000, status: "verified", source: "test" },
    },
  })}\n`);
  writeFileSync(join(configDirectory, "model-recommendations.json"), `${JSON.stringify({
    schemaVersion: 1,
    profiles: {
      "aa-model": {
        providers: ["claude"],
        roles: ["test"],
        ratings: baseRatings,
        caveats: [],
        aaVariants,
        selectedAaVariant: "model-default",
      },
      "plain-model": {
        providers: ["claude"],
        roles: ["test"],
        ratings: {
          aaCoding: missingRating(),
          aaAgentic: missingRating(),
          aaIntelligence: missingRating(),
          taste: missingRating(),
          coachability: missingRating(),
          efficiency: missingRating(),
        },
        caveats: [],
      },
    },
  }, null, 2)}\n`);
  return { ...state, toolRoot, configDirectory, aaVariants };
}

function stubApplyAaVariant(profile, variantSlug) {
  const variant = (profile.aaVariants ?? []).find((entry) => entry.aaSlug === variantSlug);
  if (!variant) throw new Error(`missing variant ${variantSlug}`);
  const rating = (value) => ({
    value,
    confidence: 0.95,
    source: "artificial-analysis",
    variant: variantSlug,
    indexVersion: "2.0",
    fetchedAt: "2026-07-20T12:00:00.000Z",
  });
  return {
    ...profile,
    selectedAaVariant: variantSlug,
    ratings: {
      ...profile.ratings,
      aaCoding: rating(variant.evaluations.artificial_analysis_coding_index),
      aaAgentic: rating(variant.evaluations.artificial_analysis_agentic_index),
      aaIntelligence: rating(variant.evaluations.artificial_analysis_intelligence_index),
    },
    speedMetrics: {
      median_output_tokens_per_second: variant.performance.median_output_tokens_per_second,
      median_time_to_first_answer_token_seconds: variant.performance.median_time_to_first_answer_token_seconds,
    },
  };
}

test("a quota window without usedPercent is unknown, never full headroom", () => {
  const state = fixture();
  const quotaPath = join(state.stateRoot, "agents-statusline", "foreign-usage.json");
  mkdirSync(dirname(quotaPath), { recursive: true });
  writeFileSync(quotaPath, `${JSON.stringify({
    fetchedAt: "2026-07-20T20:00:00Z",
    providers: {
      claude: {
        mode: "authoritative",
        state: "available",
        windows: [
          { id: "5h", label: "Claude 5h", remainingPercent: 5, resetAt: "2026-07-20T22:00:00Z" },
          { id: "weekly", label: "Claude weekly", usagePercent: 90, resetAt: "2026-07-25T22:00:00Z" },
        ],
      },
    },
  })}\n`, { mode: 0o600 });

  const dashboard = loadDashboardState({ toolRoot: repoRoot, paths: state.paths, now: new Date("2026-07-20T20:01:00Z") });
  for (const profile of dashboard.roster) {
    for (const window of profile.quota?.windows ?? []) {
      assert.notEqual(window.remainingPercent, 100, `${profile.id}/${window.id} reported full headroom from missing data`);
    }
  }
});

test("a profile the scorer drops is never presented as eligible", () => {
  const state = fixture();
  const quotaPath = join(state.stateRoot, "agents-statusline", "foreign-usage.json");
  mkdirSync(dirname(quotaPath), { recursive: true });
  writeFileSync(quotaPath, `${JSON.stringify({
    fetchedAt: "2026-07-20T20:00:00Z",
    providers: {
      claude: { mode: "authoritative", state: "unavailable", windows: [] },
    },
  })}\n`, { mode: 0o600 });

  const dashboard = loadDashboardState({ toolRoot: repoRoot, paths: state.paths, now: new Date("2026-07-20T20:01:00Z") });
  const ineligible = dashboard.roster.filter((profile) => !profile.eligible);
  assert(ineligible.length > 0, "expected the unavailable provider to make some route ineligible");
  for (const profile of ineligible) {
    assert(profile.reasons.length > 0, `${profile.id} was marked ineligible with no reason`);
  }
  for (const profile of dashboard.roster) {
    assert.equal(typeof profile.eligible, "boolean");
  }
});

test("dashboard options stay loopback-oriented and validate ports", () => {
  assert.deepEqual(parseDashboardOptions([]), { port: 0, open: true });
  assert.deepEqual(parseDashboardOptions(["--no-open", "--port", "4317"]), { port: 4317, open: false });
  assert.throws(() => parseDashboardOptions(["--port", "65536"]), /0 through 65535/);
  assert.throws(() => parseDashboardOptions(["--host", "0.0.0.0"]), /unknown dashboard option/);
});

test("dashboard state joins roster, context, benchmark, quota, and personal evidence", () => {
  const state = fixture();
  const quotaPath = join(state.stateRoot, "agents-statusline", "foreign-usage.json");
  mkdirSync(dirname(quotaPath), { recursive: true });
  writeFileSync(quotaPath, `${JSON.stringify({
    fetchedAt: "2026-07-20T20:00:00Z",
    providers: {
      claude: {
        mode: "authoritative",
        state: "available",
        windows: [
          { id: "5h", label: "Claude 5h", usedPercent: 20, resetAt: "2026-07-20T22:00:00Z" },
          { id: "weekly", label: "Claude weekly", usedPercent: 40, resetAt: "2026-07-25T22:00:00Z" },
          { id: "model-fable", label: "Fable", usedPercent: 70, resetAt: "2026-07-25T22:00:00Z" },
        ],
      },
    },
  })}\n`, { mode: 0o600 });

  const dashboard = loadDashboardState({ toolRoot: repoRoot, paths: state.paths, now: new Date("2026-07-20T20:01:00Z") });
  assert.equal(dashboard.roster.length, 28);
  const fable = dashboard.roster.find((profile) => profile.id === "fable-5");
  assert.equal(fable.model, "claude-fable-5");
  assert.equal(fable.context.contextTokens, 1_000_000);
  assert.equal(fable.ratings.taste.value, 100);
  assert.equal(fable.quota.windows.length, 3);
  assert.equal(fable.quota.windows.find((window) => window.id === "model-fable").remainingPercent, 30);
  assert.ok(Number.isFinite(fable.defaultScore));
  assert.equal(dashboard.dataSources.find((source) => source.name === "Provider quota").status, "available");
});

test("latest compatible benchmark wins for the active concrete model", () => {
  const state = fixture();
  const root = join(state.paths.stateDirectory, "benchmarks");
  writeSummary(join(root, "older"), summary("2026-07-20T10:00:00Z", "model-a", 100));
  writeSummary(join(root, "newer"), summary("2026-07-20T11:00:00Z", "model-a", 250));
  writeSummary(join(root, "wrong-model"), summary("2026-07-20T12:00:00Z", "model-b", 999));
  const benchmarks = loadLatestBenchmarks(root, { alpha: { model: "model-a" } });
  assert.equal(benchmarks.get("alpha").postFirstTokenTPS.p50, 250);
  assert.equal(benchmarks.get("alpha").artifact, "newer");
});

test("recommendation settings update rankings without mutating state", () => {
  const state = fixture();
  const dashboard = loadDashboardState({ toolRoot: repoRoot, paths: state.paths, now: new Date("2026-07-20T20:01:00Z") });
  const result = recommendFromState(dashboard, {
    weights: {
      aaCoding: 0, aaAgentic: 0, aaIntelligence: 0, taste: 100, speed: 0, reliability: 0,
      quota: 0, context: 0, coachability: 0, efficiency: 0,
    },
  }, new Date("2026-07-20T20:01:00Z"));
  assert.equal(result.recommendations[0].id, "fable-5");
  assert.equal(Array.isArray(result.recommendations[0].dimensions), true);
  assert.equal(Object.hasOwn(result.recommendations[0], "contributions"), false);
  assert.equal(dashboard.defaults.weights.taste > 0, true);
});

test("user presets are private, validated, and removable", () => {
  const state = fixture();
  const preset = saveDashboardPreset(state.paths, {
    name: "My build mix",
    settings: {
      weights: {
        aaCoding: 10, aaAgentic: 10, aaIntelligence: 10, taste: 10, speed: 10,
        reliability: 10, quota: 10, context: 10, coachability: 10, efficiency: 10,
      },
    },
  }, new Date("2026-07-20T20:00:00Z"));
  const path = join(state.paths.configDirectory, "dashboard-presets.json");
  assert.equal(statSync(state.paths.configDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readDashboardPresets(state.paths)[0].id, preset.id);
  assert.deepEqual(Object.keys(preset.settings), ["weights"]);
  deleteDashboardPreset(state.paths, preset.id);
  assert.deepEqual(readDashboardPresets(state.paths), []);
  assert.throws(() => saveDashboardPreset(state.paths, { name: "", settings: {} }), /preset name/);
});

test("recommendations ignore legacy token guesses and keep every context size eligible", () => {
  const state = fixture();
  const dashboard = loadDashboardState({ toolRoot: repoRoot, paths: state.paths, now: new Date("2026-07-20T20:01:00Z") });
  const baseline = recommendFromState(dashboard, {}, new Date("2026-07-20T20:01:00Z"));
  const legacy = recommendFromState(dashboard, {
    expectedOutputTokens: 100_000,
    requiredContextTokens: 2_000_000,
  }, new Date("2026-07-20T20:01:00Z"));
  assert.deepEqual(legacy.settings, { weights: dashboard.defaults.weights });
  assert.deepEqual(legacy.recommendations, baseline.recommendations);
  assert.equal(legacy.recommendations.some((item) => item.id === "gpt-5-3-codex-spark"), true);
});

test("legacy saved presets load without exposing obsolete token fields", () => {
  const state = fixture();
  mkdirSync(state.paths.configDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(state.paths.configDirectory, "dashboard-presets.json"), `${JSON.stringify({
    schemaVersion: 1,
    presets: [{
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "Legacy preset",
      builtin: false,
      settings: {
        weights: { capability: 100 },
        expectedOutputTokens: 9_999,
        requiredContextTokens: 999_999,
      },
    }],
  })}\n`);
  const [preset] = readDashboardPresets(state.paths);
  assert.deepEqual(Object.keys(preset.settings), ["weights"]);
  assert.equal(preset.settings.weights.aaCoding > preset.settings.weights.taste, true);
  assert.equal(Object.hasOwn(preset.settings.weights, "capability"), false);
  assert.equal(Object.hasOwn(preset.settings.weights, "publicRating"), false);
});

test("legacy capability/publicRating preset weights migrate on load", () => {
  const state = fixture();
  mkdirSync(state.paths.configDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(state.paths.configDirectory, "dashboard-presets.json"), `${JSON.stringify({
    schemaVersion: 1,
    presets: [{
      id: "123e4567-e89b-42d3-a456-426614174001",
      name: "Legacy AA migration",
      builtin: false,
      settings: {
        weights: { capability: 22, publicRating: 8, taste: 18 },
      },
    }],
  })}\n`);
  const [preset] = readDashboardPresets(state.paths);
  assert.equal(Object.hasOwn(preset.settings.weights, "aaCoding"), true);
  assert.equal(Object.hasOwn(preset.settings.weights, "capability"), false);
  assert.equal(Object.hasOwn(preset.settings.weights, "publicRating"), false);
  assert.equal(preset.settings.weights.aaCoding > 0, true);
});

test("direct recommend/save paths still reject legacy capability weights", () => {
  const state = fixture();
  const dashboard = loadDashboardState({ toolRoot: repoRoot, paths: state.paths, now: new Date("2026-07-20T20:01:00Z") });
  assert.throws(
    () => recommendFromState(dashboard, { weights: { capability: 100 } }, new Date("2026-07-20T20:01:00Z")),
    (error) => error?.statusCode === 400 && /unknown recommendation weight/.test(error.message),
  );
  assert.throws(
    () => saveDashboardPreset(state.paths, {
      name: "Legacy keys should fail",
      settings: { weights: { capability: 50, publicRating: 10 } },
    }, new Date("2026-07-20T20:00:00Z")),
    (error) => error?.statusCode === 400 && /unknown recommendation weight/.test(error.message),
  );
});

test("quota refresh delegates to the credential-owning statusline helper", async () => {
  const state = fixture();
  const localBin = join(state.home, "bin");
  const executable = join(localBin, "agents-statusline");
  mkdirSync(localBin, { recursive: true });
  writeFileSync(executable, "fixture");
  let invocation = null;
  const result = await refreshQuotaCache({ localBin }, {
    spawnProcess(path, args, options) {
      invocation = { path, args, options };
      const child = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit("close", 0));
      return child;
    },
  });
  assert.equal(result, true);
  assert.deepEqual(invocation, { path: executable, args: ["foreign-usage-refresh"], options: { stdio: "ignore" } });
  assert.equal(await refreshQuotaCache({ localBin: join(state.home, "missing") }), false);
});

test("HTTP app requires its launch token for every data endpoint", async () => {
  const state = fixture();
  const token = "123e4567-e89b-42d3-a456-426614174000";
  const server = createServer(createDashboardApp({ toolRoot: repoRoot, paths: state.paths, token, now: () => new Date("2026-07-20T20:00:00Z") }));
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(`${base}/${token}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Model Cockpit/);

    const denied = await fetch(`${base}/api/state`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/api/state`, { headers: { "X-All-Models-Patch-Token": token } });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).roster.length, 28);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  }
});

test("state payload carries AA variants and rating provenance when present, omits when absent", () => {
  const state = aaVariantFixture();
  const dashboard = loadDashboardState({
    toolRoot: state.toolRoot,
    paths: state.paths,
    now: new Date("2026-07-20T20:01:00Z"),
  });
  const aa = dashboard.roster.find((profile) => profile.id === "aa-model");
  const plain = dashboard.roster.find((profile) => profile.id === "plain-model");
  assert.equal(aa.selectedAaVariant, "model-default");
  assert.equal(aa.aaVariants.length, 2);
  assert.deepEqual(aa.aaVariants[1], {
    aaSlug: "model-high",
    aaName: "High",
    artificial_analysis_coding_index: 88,
    artificial_analysis_agentic_index: 84,
    artificial_analysis_intelligence_index: 90,
    median_output_tokens_per_second: 40,
    median_time_to_first_answer_token_seconds: 1.2,
  });
  assert.equal(Object.hasOwn(aa.aaVariants[1], "pricing"), false);
  assert.equal(aa.ratings.aaCoding.source, "artificial-analysis");
  assert.equal(aa.ratings.aaCoding.variant, "model-default");
  assert.equal(aa.ratings.aaCoding.indexVersion, "1.0");
  assert.equal(aa.ratings.aaCoding.fetchedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(Object.hasOwn(plain, "aaVariants"), false);
  assert.equal(Object.hasOwn(plain, "selectedAaVariant"), false);
});

test("selecting an AA variant persists atomically and recomputes ratings", async () => {
  const state = aaVariantFixture();
  const metadataPath = join(state.configDirectory, "model-recommendations.json");
  const before = readFileSync(metadataPath, "utf8");
  const entry = await selectAaVariant({
    toolRoot: state.toolRoot,
    paths: state.paths,
    profileName: "aa-model",
    variantSlug: "model-high",
    now: new Date("2026-07-20T20:00:00Z"),
    applyVariant: stubApplyAaVariant,
  });
  assert.equal(entry.id, "aa-model");
  assert.equal(entry.selectedAaVariant, "model-high");
  assert.equal(entry.ratings.aaCoding.value, 88);
  assert.equal(entry.ratings.aaCoding.variant, "model-high");
  assert.equal(entry.ratings.aaCoding.indexVersion, "2.0");
  const after = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(after.profiles["aa-model"].selectedAaVariant, "model-high");
  assert.equal(after.profiles["aa-model"].ratings.aaAgentic.value, 84);
  assert.equal(after.profiles["plain-model"].ratings.aaCoding.source, "not-rated");
  assert.notEqual(before, readFileSync(metadataPath, "utf8"));
  assert.equal(statSync(metadataPath).mode & 0o777, 0o600);
});

test("AA variant endpoint validates profile and variant selection", async () => {
  const state = aaVariantFixture();
  const token = "123e4567-e89b-42d3-a456-426614174099";
  const server = createServer(createDashboardApp({
    toolRoot: state.toolRoot,
    paths: state.paths,
    token,
    now: () => new Date("2026-07-20T20:00:00Z"),
    applyVariant: stubApplyAaVariant,
  }));
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    "Content-Type": "application/json",
    "X-All-Models-Patch-Token": token,
  };
  try {
    const happy = await fetch(`${base}/api/aa-variant`, {
      method: "POST",
      headers,
      body: JSON.stringify({ profile: "aa-model", variant: "model-high" }),
    });
    assert.equal(happy.status, 200);
    const body = await happy.json();
    assert.equal(body.selectedAaVariant, "model-high");
    assert.equal(body.ratings.aaIntelligence.value, 90);

    const unknownProfile = await fetch(`${base}/api/aa-variant`, {
      method: "POST",
      headers,
      body: JSON.stringify({ profile: "missing-profile", variant: "model-high" }),
    });
    assert.equal(unknownProfile.status, 400);
    assert.match((await unknownProfile.json()).error, /unknown profile/i);

    const unknownVariant = await fetch(`${base}/api/aa-variant`, {
      method: "POST",
      headers,
      body: JSON.stringify({ profile: "aa-model", variant: "does-not-exist" }),
    });
    assert.equal(unknownVariant.status, 400);
    assert.match((await unknownVariant.json()).error, /unknown Artificial Analysis variant/i);

    const noVariants = await fetch(`${base}/api/aa-variant`, {
      method: "POST",
      headers,
      body: JSON.stringify({ profile: "plain-model", variant: "model-high" }),
    });
    assert.equal(noVariants.status, 400);
    assert.match((await noVariants.json()).error, /no Artificial Analysis variants/i);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  }
});

function writeSummary(directory, payload) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify(payload)}\n`);
}

function summary(completedAt, model, speed) {
  return {
    schemaVersion: 1,
    runID: `run-${speed}`,
    fixture: { id: "raw-v1" },
    completedAt,
    agents: [{
      name: "alpha",
      configuredModel: model,
      routes: [`provider/${model}`],
      measuredSamples: 3,
      validSamples: 3,
      formatPasses: 3,
      retries: 0,
      ttftMS: { count: 3, p50: 500, p90: 600, min: 450, max: 600 },
      latencyMS: { count: 3, p50: 2_000, p90: 2_100, min: 1_900, max: 2_100 },
      postFirstTokenTPS: { count: 3, p50: speed, p90: speed, min: speed, max: speed },
      endToEndTPS: { count: 3, p50: speed / 2, p90: speed / 2, min: speed / 2, max: speed / 2 },
    }],
  };
}
