import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  applySupportPack,
  compareVersions,
  selectSupportPack,
  validateSupportCatalog,
  validateSupportPack,
} from "../src/support-pack.mjs";

const pack = JSON.parse(readFileSync(new URL("../support/darwin-arm64/2.1.197.json", import.meta.url), "utf8"));
const goalPack = JSON.parse(readFileSync(new URL("../support/darwin-arm64/2.1.201.json", import.meta.url), "utf8"));
const supersededCurrentPack = JSON.parse(readFileSync(new URL("../support/darwin-arm64/2.1.202.json", import.meta.url), "utf8"));
const latestGoalPack = JSON.parse(readFileSync(new URL("../support/darwin-arm64/2.1.202-p9.json", import.meta.url), "utf8"));
const catalog = JSON.parse(readFileSync(new URL("../support/catalog.json", import.meta.url), "utf8"));
const stable = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.197/claude`;
const goalStable = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.201/claude`;
const latestGoalStable = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.202/claude`;

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
  const historicalEntry = catalog.packs.find((entry) => entry.id === pack.id);
  assert.equal(historicalEntry?.status, "active");
  assert.equal(historicalEntry?.packSha256, "3ecb5dca565fd48da9e62b73a22e5e03018621f09767621ef15af212780955e7");
  assert.equal(
    selectSupportPack(catalog, {
      claudeVersion: "2.1.197",
      platform: "darwin-arm64",
      stockSha256: "0".repeat(64),
    }),
    null,
  );
});

test("rejects two active recipe revisions for the same stock binary", () => {
  const invalid = structuredClone(catalog);
  const entries = invalid.packs.filter((entry) => entry.claudeVersion === "2.1.202");
  for (const entry of entries) entry.status = "active";
  assert.throws(
    () => selectSupportPack(invalid, { claudeVersion: "2.1.202", platform: "darwin-arm64", stockSha256: latestGoalPack.stock.sha256 }),
    /ambiguous active support catalog entry/,
  );
});

test("applies the reviewed 2.1.197 pack reproducibly", { skip: !existsSync(stable) }, () => {
  const stock = readFileSync(stable);
  const result = applySupportPack(stock, pack);
  assert.equal(result.unsignedPatchedSha256, pack.expectedUnsignedPatchedSha256);
  for (const recipe of pack.recipes) {
    assert.equal(result.patched.includes(Buffer.from(recipe.original)), false, recipe.id);
    assert.equal(result.patched.includes(Buffer.from(recipe.replacement)), true, recipe.id);
  }
});

test("applies the reviewed 2.1.201 set_goal pack reproducibly", { skip: !existsSync(goalStable) }, () => {
  const stock = readFileSync(goalStable);
  const result = applySupportPack(stock, goalPack);
  assert.equal(result.unsignedPatchedSha256, goalPack.expectedUnsignedPatchedSha256);
  assert.equal(result.patched.includes(Buffer.from('var YO="set_goal";')), true);
  assert.equal(result.patched.includes(Buffer.from('var YO="TodoWrite";')), false);
  assert.equal(result.patched.includes(Buffer.from('name:YO,maxResultSizeChars:1e5,alwaysLoad:!0')), true);
  assert.equal(result.patched.includes(Buffer.from("ICt(n,t)")), true);
  for (const recipe of goalPack.recipes) {
    assert.equal(result.patched.includes(Buffer.from(recipe.original)), false, recipe.id);
    assert.equal(result.patched.includes(Buffer.from(recipe.replacement)), true, recipe.id);
  }
});

test("applies the reviewed 2.1.202 set_goal pack reproducibly", { skip: !existsSync(latestGoalStable) }, () => {
  const stock = readFileSync(latestGoalStable);
  const result = applySupportPack(stock, latestGoalPack);
  assert.equal(result.unsignedPatchedSha256, latestGoalPack.expectedUnsignedPatchedSha256);
  assert.equal(result.patched.includes(Buffer.from('var nO="set_goal";')), true);
  assert.equal(result.patched.includes(Buffer.from('var nO="TodoWrite";')), false);
  assert.equal(result.patched.includes(Buffer.from("KCt(r,t)")), true);
  assert.equal(result.patched.includes(Buffer.from("ANTHROPIC_AUTH_TOKEN")), true);
  assert.equal(catalog.packs.find((entry) => entry.id === supersededCurrentPack.id)?.status, "revoked");
  for (const recipe of latestGoalPack.recipes) {
    assert.equal(result.patched.includes(Buffer.from(recipe.original)), false, recipe.id);
    assert.equal(result.patched.includes(Buffer.from(recipe.replacement)), true, recipe.id);
  }
});

test("rejects stock mutations and oversized replacements", { skip: !existsSync(stable) }, () => {
  const stock = Buffer.from(readFileSync(stable));
  stock[100] ^= 1;
  assert.throws(() => applySupportPack(stock, pack), /SHA-256 mismatch/);
  const invalid = structuredClone(pack);
  invalid.recipes[0].replacement = `${invalid.recipes[0].original}x`;
  assert.throws(() => validateSupportPack(invalid), /exceeds original length/);
});

test("orders upgrades, current versions, and rollbacks", () => {
  assert.equal(compareVersions("2.1.202", "2.1.201"), 1);
  assert.equal(compareVersions("2.1.201", "2.1.197"), 1);
  assert.equal(compareVersions("2.1.197", "2.1.197"), 0);
  assert.equal(compareVersions("2.1.197", "2.1.201"), -1);
});

test("rejects support-pack paths that escape the signed catalog root", () => {
  const invalid = structuredClone(catalog);
  invalid.packs[0].path = "../credentials.json";
  assert.throws(() => validateSupportCatalog(invalid), /escapes support root/);
});
