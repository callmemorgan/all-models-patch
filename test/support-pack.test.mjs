import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applySupportPack,
  compareVersions,
  selectSupportPack,
  validateSupportCatalog,
  validateSupportPack,
} from "../src/support-pack.mjs";

const pack = JSON.parse(readFileSync(new URL("../support/darwin-arm64/2.1.197.json", import.meta.url), "utf8"));
const catalog = JSON.parse(readFileSync(new URL("../support/catalog.json", import.meta.url), "utf8"));
const stable = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.197/claude`;

test("validates and selects an exact immutable support pack", () => {
  validateSupportPack(pack);
  validateSupportCatalog(catalog);
  assert.equal(
    selectSupportPack(catalog, {
      claudeVersion: "2.1.197",
      platform: "darwin-arm64",
      stockSha256: pack.stock.sha256,
    })?.id,
    pack.id,
  );
  assert.equal(
    selectSupportPack(catalog, {
      claudeVersion: "2.1.197",
      platform: "darwin-arm64",
      stockSha256: "0".repeat(64),
    }),
    null,
  );
});

test("applies the reviewed 2.1.197 pack reproducibly", () => {
  const stock = readFileSync(stable);
  const result = applySupportPack(stock, pack);
  assert.equal(result.unsignedPatchedSha256, pack.expectedUnsignedPatchedSha256);
  for (const recipe of pack.recipes) {
    assert.equal(result.patched.includes(Buffer.from(recipe.original)), false, recipe.id);
    assert.equal(result.patched.includes(Buffer.from(recipe.replacement)), true, recipe.id);
  }
});

test("rejects stock mutations and oversized replacements", () => {
  const stock = Buffer.from(readFileSync(stable));
  stock[100] ^= 1;
  assert.throws(() => applySupportPack(stock, pack), /SHA-256 mismatch/);
  const invalid = structuredClone(pack);
  invalid.recipes[0].replacement = `${invalid.recipes[0].original}x`;
  assert.throws(() => validateSupportPack(invalid), /exceeds original length/);
});

test("orders upgrades, current versions, and rollbacks", () => {
  assert.equal(compareVersions("2.1.201", "2.1.197"), 1);
  assert.equal(compareVersions("2.1.197", "2.1.197"), 0);
  assert.equal(compareVersions("2.1.197", "2.1.201"), -1);
});
