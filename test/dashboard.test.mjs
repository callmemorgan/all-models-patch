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
