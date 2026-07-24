import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = join(repoRoot, "bin", "all-models-patch");

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "all-models-manager-cli-"));
  const configHome = join(home, "config");
  return {
    home,
    configHome,
    featurePath: join(configHome, "all-models-patch", "features.json"),
    agentTeamsPath: join(configHome, "all-models-patch", "agent-teams.json"),
    statePath: join(home, "state", "all-models-patch", "stable-update.json"),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(home, "state"),
      ALL_MODELS_PATCH_HOME: repoRoot,
    },
  };
}

function run(fixtureState, args, extraEnv = {}) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: { ...fixtureState.env, ...extraEnv },
  });
}

function runWithFetchFixture(fixtureState, args, source) {
  const preload = join(fixtureState.home, "fetch-fixture.mjs");
  writeFileSync(preload, source);
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, executable, ...args], {
    encoding: "utf8",
    env: fixtureState.env,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("noninteractive configure defaults agent teams to disabled", () => {
  const state = fixture();
  const result = run(state, ["configure", "--if-unset", "--no-update", "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(state.agentTeamsPath).enabled, false);
  assert.ok(existsSync(state.featurePath));
});

test("noninteractive configure preserves an existing agent teams choice", () => {
  const state = fixture();
  mkdirSync(dirname(state.agentTeamsPath), { recursive: true });
  writeFileSync(state.agentTeamsPath, `${JSON.stringify({ schemaVersion: 1, enabled: true }, null, 2)}\n`);
  const result = run(state, ["configure", "--no-update", "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(state.agentTeamsPath).enabled, true);
});

test("installer-style explicit agent choice still configures an unset patch profile", () => {
  const state = fixture();
  const result = run(state, ["configure", "--if-unset", "--agent-teams", "--no-update", "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(state.agentTeamsPath).enabled, true);
  assert.ok(existsSync(state.featurePath));
});

test("explicit agent teams choices do not change patch features or reconcile Stable", () => {
  const state = fixture();
  mkdirSync(dirname(state.featurePath), { recursive: true });
  writeFileSync(state.featurePath, `${JSON.stringify({ schemaVersion: 1, enabled: ["context"] }, null, 2)}\n`);

  const enabled = run(state, ["configure", "--agent-teams", "--quiet"]);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(readJson(state.agentTeamsPath).enabled, true);
  assert.deepEqual(readJson(state.featurePath).enabled, ["context"]);

  const disabled = run(state, ["configure", "--if-unset", "--no-agent-teams", "--no-update", "--quiet"]);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(readJson(state.agentTeamsPath).enabled, false);
  assert.deepEqual(readJson(state.featurePath).enabled, ["context"]);
});

test("first feature configuration reconciles even when it selects the default profile", () => {
  const state = fixture();
  mkdirSync(dirname(state.statePath), { recursive: true });
  writeFileSync(state.statePath, `${JSON.stringify({
    schemaVersion: 1,
    stableVersion: "9.9.9",
    result: { status: "unsupported" },
    highestAcceptedReleaseSequence: 0,
    consecutiveFailures: 0,
  }, null, 2)}\n`);
  const result = runWithFetchFixture(state, ["configure", "--all", "--quiet"], `
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/stable")) return new Response("9.9.9\\n");
      if (String(url).endsWith("/manifest.json")) return new Response(JSON.stringify({
        platforms: { "darwin-arm64": { size: 1, checksum: "${"a".repeat(64)}" } },
      }));
      throw new Error(\`unexpected fetch: \${url}\`);
    };
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readJson(state.statePath).checkedAt);
});

test("equivalent feature selections in different orders do not reconcile", () => {
  const state = fixture();
  mkdirSync(dirname(state.featurePath), { recursive: true });
  writeFileSync(state.featurePath, `${JSON.stringify({ schemaVersion: 1, enabled: ["discovery", "context"] }, null, 2)}\n`);
  const result = runWithFetchFixture(state, ["configure", "--only", "context,discovery", "--quiet"], `
    globalThis.fetch = async () => { throw new Error("reconcile should not run"); };
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJson(state.featurePath).enabled, ["discovery", "context"]);
  assert.equal(existsSync(state.statePath), false);
});

test("if-unset preserves an existing agent teams choice", () => {
  const state = fixture();
  mkdirSync(dirname(state.agentTeamsPath), { recursive: true });
  writeFileSync(state.agentTeamsPath, `${JSON.stringify({ schemaVersion: 1, enabled: true }, null, 2)}\n`);
  const before = readFileSync(state.agentTeamsPath, "utf8");

  const result = run(state, ["configure", "--if-unset", "--no-update", "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(state.agentTeamsPath, "utf8"), before);
});

test("an explicit agent teams choice repairs malformed preference data", () => {
  const state = fixture();
  mkdirSync(dirname(state.agentTeamsPath), { recursive: true });
  writeFileSync(state.agentTeamsPath, "malformed");
  const result = run(state, ["configure", "--agent-teams", "--no-update", "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(state.agentTeamsPath).enabled, true);
});

test("conflicting agent teams flags fail before writing configuration", () => {
  const state = fixture();
  const result = run(state, ["configure", "--agent-teams", "--no-agent-teams", "--no-update"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mutually exclusive/);
  assert.equal(existsSync(state.agentTeamsPath), false);
  assert.equal(existsSync(state.featurePath), false);
});

test("agent-teams-env reports enabled, disabled, unset, and invalid states", () => {
  const state = fixture();
  let result = run(state, ["agent-teams-env"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");

  mkdirSync(dirname(state.agentTeamsPath), { recursive: true });
  writeFileSync(state.agentTeamsPath, `${JSON.stringify({ schemaVersion: 1, enabled: true }, null, 2)}\n`);
  result = run(state, ["agent-teams-env"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\n");

  writeFileSync(state.agentTeamsPath, `${JSON.stringify({ schemaVersion: 1, enabled: false }, null, 2)}\n`);
  result = run(state, ["agent-teams-env"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");

  writeFileSync(state.agentTeamsPath, "invalid");
  result = run(state, ["agent-teams-env"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /all-models-patch:/);
});

test("recommend --json returns a scored recommendations payload", () => {
  const state = fixture();
  const result = run(state, ["recommend", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.recommendations));
  assert.ok(payload.recommendations.length > 0);
  assert.equal(typeof payload.recommendations[0].score, "number");
  assert.ok(payload.presets.some((preset) => preset.id === "balanced"));
});
