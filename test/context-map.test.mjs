import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadContextEnvironment } from "../src/context-map.mjs";

function fixture(value) {
  const path = join(mkdtempSync(join(tmpdir(), "claude-context-map-")), "map.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("exports only route-validated safe profiles", () => {
  const path = fixture({ schemaVersion: 1, models: {
    "gpt-test": { contextTokens: 350000, compactAtTokens: 300000, status: "route-validated" },
    "claude-fable-5": { contextTokens: 1000000, compactAtTokens: 660000, status: "route-validated" },
    guessed: { contextTokens: 900000, compactAtTokens: 800000, status: "unverified" },
  }});
  assert.deepEqual(loadContextEnvironment(path).environment, [
    ["CLAUDE_ALL_CONTEXT_gpt-test", "350000"],
    ["CLAUDE_ALL_COMPACT_gpt-test", "300000"],
    ["CLAUDE_ALL_CONTEXT_claude-fable-5", "1000000"],
    ["CLAUDE_ALL_COMPACT_claude-fable-5", "660000"],
  ]);
});

test("ignores unsafe thresholds", () => {
  const path = fixture({ schemaVersion: 1, models: {
    unsafe: { contextTokens: 300000, compactAtTokens: 300000, status: "route-validated" },
  }});
  const result = loadContextEnvironment(path);
  assert.deepEqual(result.environment, []);
  assert.equal(result.warnings.length, 1);
});

test("rejects unknown schemas", () => {
  const path = fixture({ schemaVersion: 2, models: {} });
  assert.throws(() => loadContextEnvironment(path), /schemaVersion 1/);
});
