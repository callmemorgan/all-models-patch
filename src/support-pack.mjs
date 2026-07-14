import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SUPPORT_PACK_SCHEMA = 1;
export const SUPPORT_CATALOG_SCHEMA = 1;
export const PATCH_ENGINE_SCHEMA = 1;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSha256(path) {
  return sha256(readFileSync(path));
}

export function validateSupportPack(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) throw new Error("support pack must be an object");
  if (pack.schemaVersion !== SUPPORT_PACK_SCHEMA) throw new Error(`unsupported support pack schema: ${pack.schemaVersion}`);
  if (pack.patchEngineSchema !== PATCH_ENGINE_SCHEMA) throw new Error(`unsupported patch engine schema: ${pack.patchEngineSchema}`);
  assertString(pack.id, "support pack id");
  assertVersion(pack.claudeVersion, "Claude version");
  if (pack.platform !== "darwin-arm64") throw new Error(`unsupported support pack platform: ${pack.platform}`);
  if (pack.architecture !== "arm64") throw new Error(`unsupported support pack architecture: ${pack.architecture}`);
  if (!pack.stock || typeof pack.stock !== "object") throw new Error("support pack stock metadata is missing");
  assertSha256(pack.stock.sha256, "stock SHA-256");
  if (!Number.isSafeInteger(pack.stock.size) || pack.stock.size <= 0) throw new Error("stock size must be a positive integer");
  if (pack.stock.appleTeamIdentifier !== "Q6L2SF6YDW") throw new Error("support pack has an unexpected Apple team identifier");
  assertSha256(pack.expectedUnsignedPatchedSha256, "unsigned patched SHA-256");
  if (!Array.isArray(pack.recipes) || pack.recipes.length === 0) throw new Error("support pack has no patch recipes");

  const recipeIds = new Set();
  for (const recipe of pack.recipes) {
    if (!recipe || typeof recipe !== "object") throw new Error("patch recipe must be an object");
    assertString(recipe.id, "patch recipe id");
    if (recipeIds.has(recipe.id)) throw new Error(`duplicate patch recipe: ${recipe.id}`);
    recipeIds.add(recipe.id);
    assertString(recipe.original, `${recipe.id} original bytes`);
    assertString(recipe.replacement, `${recipe.id} replacement bytes`);
    if (Buffer.byteLength(recipe.replacement) > Buffer.byteLength(recipe.original)) {
      throw new Error(`replacement exceeds original length for ${recipe.id}`);
    }
    if (recipe.expectedMatches !== 1) throw new Error(`unsupported expected match count for ${recipe.id}`);
  }
  return pack;
}

export function validateSupportCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("support catalog must be an object");
  if (catalog.schemaVersion !== SUPPORT_CATALOG_SCHEMA) throw new Error(`unsupported support catalog schema: ${catalog.schemaVersion}`);
  if (!Number.isSafeInteger(catalog.releaseSequence) || catalog.releaseSequence < 1) throw new Error("catalog releaseSequence must be positive");
  assertVersion(catalog.managerVersion, "catalog manager version");
  if (!Array.isArray(catalog.packs)) throw new Error("catalog packs must be an array");
  const ids = new Set();
  for (const entry of catalog.packs) {
    assertString(entry.id, "catalog pack id");
    if (ids.has(entry.id)) throw new Error(`duplicate catalog pack: ${entry.id}`);
    ids.add(entry.id);
    assertVersion(entry.claudeVersion, "catalog Claude version");
    if (entry.platform !== "darwin-arm64") throw new Error(`unsupported catalog platform: ${entry.platform}`);
    assertSha256(entry.stockSha256, "catalog stock SHA-256");
    assertSha256(entry.packSha256, "catalog pack SHA-256");
    assertString(entry.path, "catalog pack path");
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new Error(`catalog pack path escapes support root: ${entry.path}`);
    if (entry.status !== "active" && entry.status !== "revoked") throw new Error(`invalid catalog status for ${entry.id}`);
  }
  return catalog;
}

export function selectSupportPack(catalog, { claudeVersion, platform, stockSha256 }) {
  validateSupportCatalog(catalog);
  const matches = catalog.packs.filter(
    (entry) =>
      entry.claudeVersion === claudeVersion &&
      entry.platform === platform &&
      entry.stockSha256 === stockSha256,
  );
  if (matches.length > 1) throw new Error(`ambiguous support catalog entry for Claude ${claudeVersion}`);
  return matches[0] ?? null;
}

export function applySupportPack(binary, rawPack) {
  const pack = validateSupportPack(rawPack);
  if (!Buffer.isBuffer(binary)) throw new Error("stock binary must be a Buffer");
  if (binary.length !== pack.stock.size) throw new Error(`stock size mismatch: got ${binary.length}, expected ${pack.stock.size}`);
  const stockHash = sha256(binary);
  if (stockHash !== pack.stock.sha256) throw new Error(`stock SHA-256 mismatch: got ${stockHash}, expected ${pack.stock.sha256}`);

  const patched = Buffer.from(binary);
  for (const recipe of pack.recipes) replaceUnique(patched, recipe);
  verifyAppliedRecipes(patched, pack);
  const patchedHash = sha256(patched);
  if (patchedHash !== pack.expectedUnsignedPatchedSha256) {
    throw new Error(`unsigned patched SHA-256 mismatch: got ${patchedHash}, expected ${pack.expectedUnsignedPatchedSha256}`);
  }
  return { patched, stockSha256: stockHash, unsignedPatchedSha256: patchedHash };
}

export function verifyAppliedRecipes(binary, rawPack) {
  const pack = validateSupportPack(rawPack);
  const source = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
  for (const recipe of pack.recipes) {
    const original = Buffer.from(recipe.original);
    const replacement = Buffer.from(recipe.replacement);
    if (countBuffer(source, original) !== 0) throw new Error(`original bytes remain for ${recipe.id}`);
    if (countBuffer(source, replacement) !== 1) throw new Error(`patched bytes do not match exactly once for ${recipe.id}`);
  }
}

export function compareVersions(left, right) {
  assertVersion(left, "left version");
  assertVersion(right, "right version");
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function replaceUnique(binary, recipe) {
  const original = Buffer.from(recipe.original);
  const replacement = Buffer.from(recipe.replacement);
  const offset = binary.indexOf(original);
  if (offset < 0 || binary.indexOf(original, offset + 1) >= 0) throw new Error(`patch target is missing or ambiguous for ${recipe.id}`);
  binary.fill(0x20, offset, offset + original.length);
  replacement.copy(binary, offset);
}

function countBuffer(binary, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = binary.indexOf(needle, offset)) >= 0) {
    total += 1;
    offset += needle.length;
  }
  return total;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertVersion(value, label) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${label} must use x.y.z syntax`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be lowercase hexadecimal`);
}
