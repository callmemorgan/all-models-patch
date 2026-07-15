import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALL_FEATURE_IDS,
  effectiveFeatureConfig,
  enumerateFeatureSelections,
  featureProfileKey,
  normalizeFeatureSelection,
  readFeatureConfig,
  writeFeatureConfig,
} from "../src/features.mjs";

test("defaults new consumers to All", () => {
  const path = join(mkdtempSync(join(tmpdir(), "all-models-features-")), "features.json");
  const config = effectiveFeatureConfig(path);
  assert.equal(config.source, "default");
  assert.equal(config.profile, "all");
  assert.deepEqual(config.enabled, ALL_FEATURE_IDS);
});

test("persists a canonical custom feature selection", () => {
  const path = join(mkdtempSync(join(tmpdir(), "all-models-features-")), "features.json");
  writeFeatureConfig(path, ["set-goal", "discovery", "context"]);
  assert.deepEqual(readFeatureConfig(path).enabled, ["discovery", "context", "set-goal"]);
  assert.equal(featureProfileKey(readFeatureConfig(path).enabled), "discovery+context+set-goal");
});

test("enforces pricing's discovery dependency", () => {
  assert.throws(() => normalizeFeatureSelection(["pricing"]), /pricing requires discovery/);
  assert.deepEqual(normalizeFeatureSelection(["discovery", "pricing"]), ["discovery", "pricing"]);
});

test("enumerates all 24 valid feature combinations", () => {
  const selections = enumerateFeatureSelections();
  assert.equal(selections.length, 24);
  assert.equal(new Set(selections.map((selection) => featureProfileKey(selection))).size, 24);
  assert.ok(selections.some((selection) => selection.length === 0));
  assert.ok(selections.some((selection) => selection.length === ALL_FEATURE_IDS.length));
});
