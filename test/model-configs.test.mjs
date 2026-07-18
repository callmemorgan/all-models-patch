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
