import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { provisionModelConfigs, validateShippedModelConfigs } from "../src/model-configs.mjs";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("shipped agent and context configs form a valid current roster", () => {
  assert.doesNotThrow(() => validateShippedModelConfigs(toolRoot));
});

test("ships structured recommendation metadata for every agent profile", () => {
  const agents = JSON.parse(readFileSync(join(toolRoot, "config", "claude-all-agents.json"), "utf8"));
  const recommendations = JSON.parse(readFileSync(join(toolRoot, "config", "model-recommendations.json"), "utf8"));
  assert.deepEqual(Object.keys(recommendations.profiles).sort(), Object.keys(agents).sort());
  assert.deepEqual(recommendations.profiles["fable-5"].ratings.taste, {
    value: 100,
    confidence: 0.9,
    source: "personal-agent-guidance",
  });
  assert.deepEqual(recommendations.profiles["gpt-5-3-codex-spark"].ratings.publicRating, {
    value: null,
    confidence: 0,
    source: "not-rated",
  });
});

test("ships the expanded benchmark comparison routes", () => {
  const agents = JSON.parse(readFileSync(join(toolRoot, "config", "claude-all-agents.json"), "utf8"));
  const contexts = JSON.parse(readFileSync(join(toolRoot, "config", "claude-all-contexts.json"), "utf8"));

  const expectedAgents = {
    "gpt-5-5": "gpt-5.5",
    "gpt-5-4": "gpt-5.4",
    "gpt-5-4-mini": "gpt-5.4-mini",
    "gpt-5-3-codex-spark": "gpt-5.3-codex-spark",
    "opus-4-7": "claude-opus-4-7",
    "sonnet-4-6": "claude-sonnet-4-6",
    "haiku-4-5": "claude-haiku-4-5-20251001",
    "grok-4-3": "grok-4.3",
    "grok-4-20-reasoning": "grok-4.20-0309-reasoning",
    "grok-4-20-non-reasoning": "grok-4.20-0309-non-reasoning",
    "kimi-k2-6": "kimi-k2.6",
    "kimi-k2-7-code": "kimi-k2.7-code",
    "kimi-k2-7-code-fast": "kimi-k2.7-code-highspeed",
    "opus-4-6-thinking": "claude-opus-4-6-thinking",
    "gpt-oss-120b": "gpt-oss-120b-medium",
    "gemini-3-6-flash": "gemini-3.6-flash-high",
    "grok-build-0-1": "grok-build-0.1",
  };
  for (const [name, model] of Object.entries(expectedAgents)) {
    assert.equal(agents[name].model, model);
    assert.ok(contexts.models[model]);
  }
  assert.equal(contexts.models["gemini-3.6-flash-high"].contextTokens, 1_048_576);
  for (const name of ["gemini-3-5-flash", "gemini-3-5-flash-low", "gemini-3-5-flash-extra-low"]) {
    assert.equal(Object.hasOwn(agents, name), false);
  }
  for (const model of ["gemini-3-flash-agent", "gemini-3.5-flash-low", "gemini-3.5-flash-extra-low"]) {
    assert.equal(Object.hasOwn(contexts.models, model), false);
  }
  assert.deepEqual(contexts.models["kimi-k2.7-code-highspeed"], contexts.models["kimi-k2.7-code"]);
  assert.equal(contexts.models["claude-opus-4-6-thinking"].contextTokens, 200_000);
});

test("provisions missing model configs with private permissions", () => {
  const home = mkdtempSync(join(tmpdir(), "all-models-patch-configs-"));
  const result = provisionModelConfigs({ toolRoot, home });
  assert.equal(result.installed.length, 2);
  assert.equal(result.preserved.length, 0);
  for (const path of result.installed) {
    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("preserves existing user configs on a repeated provision", () => {
  const home = mkdtempSync(join(tmpdir(), "all-models-patch-configs-"));
  const agentsPath = join(home, ".cli-proxy-api", "claude-all-agents.json");
  provisionModelConfigs({ toolRoot, home });
  writeFileSync(agentsPath, "{\"custom\":true}\n");
  const contextsPath = join(home, ".cli-proxy-api", "claude-all-contexts.json");
  const originalContexts = readFileSync(contextsPath, "utf8");

  const result = provisionModelConfigs({ toolRoot, home });
  assert.equal(result.installed.length, 0);
  assert.equal(result.preserved.length, 2);
  assert.equal(readFileSync(agentsPath, "utf8"), "{\"custom\":true}\n");
  assert.equal(readFileSync(contextsPath, "utf8"), originalContexts);
});

test("does not follow or replace an existing config symlink", () => {
  const home = mkdtempSync(join(tmpdir(), "all-models-patch-configs-"));
  const configDirectory = join(home, ".cli-proxy-api");
  const agentsPath = join(configDirectory, "claude-all-agents.json");
  mkdirSync(configDirectory, { recursive: true });
  symlinkSync(join(home, "user-owned-agents.json"), agentsPath);

  const result = provisionModelConfigs({ toolRoot, home });
  assert.equal(result.installed.length, 1);
  assert.equal(result.preserved.includes(agentsPath), true);
  assert.equal(lstatSync(agentsPath).isSymbolicLink(), true);
  assert.equal(existsSync(join(home, "user-owned-agents.json")), false);
});
