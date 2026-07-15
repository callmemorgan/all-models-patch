import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SUPPORT_PACK_SCHEMA = 2;
export const SUPPORT_CATALOG_SCHEMA = 1;
export const PATCH_ENGINE_SCHEMA = 2;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSha256(path) {
  return sha256(readFileSync(path));
}

export function validateSupportPack(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) throw new Error("support pack must be an object");
  if (pack.schemaVersion !== 1 && pack.schemaVersion !== SUPPORT_PACK_SCHEMA) throw new Error(`unsupported support pack schema: ${pack.schemaVersion}`);
  const expectedEngine = pack.schemaVersion === 1 ? 1 : PATCH_ENGINE_SCHEMA;
  if (pack.patchEngineSchema !== expectedEngine) throw new Error(`unsupported patch engine schema: ${pack.patchEngineSchema}`);
  assertString(pack.id, "support pack id");
  assertVersion(pack.claudeVersion, "Claude version");
  if (pack.platform !== "darwin-arm64") throw new Error(`unsupported support pack platform: ${pack.platform}`);
  if (pack.architecture !== "arm64") throw new Error(`unsupported support pack architecture: ${pack.architecture}`);
  if (!Number.isSafeInteger(pack.patcherVersion) || pack.patcherVersion < 1) throw new Error("support pack patcherVersion must be positive");
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
  if (pack.schemaVersion === 2) validateFeatureProfiles(pack, recipeIds);
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
    if (!Number.isSafeInteger(entry.patcherVersion) || entry.patcherVersion < 1) throw new Error("catalog patcherVersion must be positive");
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
  const active = matches.filter((entry) => entry.status === "active");
  if (active.length > 1) throw new Error(`ambiguous active support catalog entry for Claude ${claudeVersion}`);
  if (active.length === 1) return active[0];
  if (matches.length > 1) return matches.sort((left, right) => right.patcherVersion - left.patcherVersion)[0];
  return matches[0] ?? null;
}

export function resolveSupportPackProfile(rawPack, enabledFeatures) {
  const pack = validateSupportPack(rawPack);
  if (pack.schemaVersion === 1) {
    return Object.freeze({
      configurable: false,
      key: "legacy-all",
      enabledFeatures: null,
      expectedUnsignedPatchedSha256: pack.expectedUnsignedPatchedSha256,
      recipes: Object.freeze([...pack.recipes]),
    });
  }
  const groups = pack.features.groups;
  const enabled = normalizePackSelection(enabledFeatures ?? pack.features.default, groups);
  const key = packFeatureKey(enabled, groups);
  const expected = pack.features.profiles[key];
  if (!expected) throw new Error(`support pack does not authorize feature profile: ${key}`);
  const recipeIds = new Set(groups.filter((group) => enabled.includes(group.id)).flatMap((group) => group.recipeIds));
  return Object.freeze({
    configurable: true,
    key,
    enabledFeatures: Object.freeze(enabled),
    expectedUnsignedPatchedSha256: expected,
    recipes: Object.freeze(pack.recipes.filter((recipe) => recipeIds.has(recipe.id))),
  });
}

export function applySupportPack(binary, rawPack, { enabledFeatures } = {}) {
  const pack = validateSupportPack(rawPack);
  const profile = resolveSupportPackProfile(pack, enabledFeatures);
  if (!Buffer.isBuffer(binary)) throw new Error("stock binary must be a Buffer");
  if (binary.length !== pack.stock.size) throw new Error(`stock size mismatch: got ${binary.length}, expected ${pack.stock.size}`);
  const stockHash = sha256(binary);
  if (stockHash !== pack.stock.sha256) throw new Error(`stock SHA-256 mismatch: got ${stockHash}, expected ${pack.stock.sha256}`);

  const patched = Buffer.from(binary);
  for (const recipe of profile.recipes) replaceUnique(patched, recipe);
  verifyAppliedRecipes(patched, pack, { enabledFeatures: profile.enabledFeatures });
  const patchedHash = sha256(patched);
  if (patchedHash !== profile.expectedUnsignedPatchedSha256) {
    throw new Error(`unsigned patched SHA-256 mismatch: got ${patchedHash}, expected ${profile.expectedUnsignedPatchedSha256}`);
  }
  return {
    patched,
    stockSha256: stockHash,
    unsignedPatchedSha256: patchedHash,
    featureProfile: profile.key,
    enabledFeatures: profile.enabledFeatures,
  };
}

export function verifyAppliedRecipes(binary, rawPack, { enabledFeatures } = {}) {
  const pack = validateSupportPack(rawPack);
  const profile = resolveSupportPackProfile(pack, enabledFeatures);
  const enabledRecipeIds = new Set(profile.recipes.map((recipe) => recipe.id));
  const source = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
  for (const recipe of pack.recipes) {
    const original = Buffer.from(recipe.original);
    const replacement = Buffer.from(recipe.replacement);
    const enabled = enabledRecipeIds.has(recipe.id);
    const originalCount = countBuffer(source, original);
    const replacementCount = countBuffer(source, replacement);
    if (enabled && originalCount !== 0) throw new Error(`original bytes remain for ${recipe.id}`);
    if (enabled && replacementCount !== 1) throw new Error(`patched bytes do not match exactly once for ${recipe.id}`);
    if (!enabled && originalCount !== 1) throw new Error(`disabled recipe original bytes do not match exactly once for ${recipe.id}`);
    if (!enabled && replacementCount !== 0) throw new Error(`disabled recipe replacement is present for ${recipe.id}`);
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

function validateFeatureProfiles(pack, recipeIds) {
  const features = pack.features;
  if (!features || typeof features !== "object" || Array.isArray(features)) throw new Error("support pack features are missing");
  if (features.schemaVersion !== 1) throw new Error(`unsupported feature schema: ${features.schemaVersion}`);
  if (!Array.isArray(features.groups) || features.groups.length === 0) throw new Error("support pack feature groups are missing");
  if (!features.profiles || typeof features.profiles !== "object" || Array.isArray(features.profiles)) throw new Error("support pack feature profiles are missing");
  const groupIds = new Set();
  const assignedRecipes = new Set();
  for (const group of features.groups) {
    assertString(group.id, "feature id");
    if (groupIds.has(group.id)) throw new Error(`duplicate feature group: ${group.id}`);
    groupIds.add(group.id);
    if (!Array.isArray(group.recipeIds) || group.recipeIds.length === 0) throw new Error(`feature ${group.id} has no recipes`);
    if (!Array.isArray(group.requires)) throw new Error(`feature ${group.id} requirements must be an array`);
    for (const recipeId of group.recipeIds) {
      if (!recipeIds.has(recipeId)) throw new Error(`feature ${group.id} references unknown recipe: ${recipeId}`);
      if (assignedRecipes.has(recipeId)) throw new Error(`recipe belongs to multiple feature groups: ${recipeId}`);
      assignedRecipes.add(recipeId);
    }
  }
  if (assignedRecipes.size !== recipeIds.size) throw new Error("every recipe must belong to exactly one feature group");
  for (const group of features.groups) {
    for (const requirement of group.requires) {
      if (!groupIds.has(requirement)) throw new Error(`feature ${group.id} requires unknown feature: ${requirement}`);
      if (requirement === group.id) throw new Error(`feature ${group.id} cannot require itself`);
    }
  }
  normalizePackSelection(features.default, features.groups);
  const expectedKeys = new Set(enumeratePackSelections(features.groups).map((selection) => packFeatureKey(selection, features.groups)));
  const actualKeys = Object.keys(features.profiles);
  if (actualKeys.length !== expectedKeys.size || actualKeys.some((key) => !expectedKeys.has(key))) {
    throw new Error("support pack feature profiles are incomplete or unexpected");
  }
  for (const [key, hash] of Object.entries(features.profiles)) assertSha256(hash, `feature profile ${key} SHA-256`);
  const defaultKey = packFeatureKey(features.default, features.groups);
  if (features.profiles[defaultKey] !== pack.expectedUnsignedPatchedSha256) {
    throw new Error("default feature profile hash does not match support pack output hash");
  }
}

function normalizePackSelection(values, groups) {
  if (!Array.isArray(values)) throw new Error("enabled features must be an array");
  const known = new Map(groups.map((group) => [group.id, group]));
  const enabled = new Set(values);
  for (const value of enabled) if (!known.has(value)) throw new Error(`unknown feature: ${value}`);
  for (const value of enabled) {
    for (const requirement of known.get(value).requires) {
      if (!enabled.has(requirement)) throw new Error(`${value} requires ${requirement}`);
    }
  }
  return groups.map((group) => group.id).filter((id) => enabled.has(id));
}

function packFeatureKey(values, groups) {
  const enabled = normalizePackSelection(values, groups);
  return enabled.length === 0 ? "none" : enabled.join("+");
}

function enumeratePackSelections(groups) {
  if (groups.length > 10) throw new Error("too many support pack features to enumerate safely");
  const selections = [];
  for (let bits = 0; bits < 2 ** groups.length; bits += 1) {
    const candidate = groups.filter((_, index) => bits & (1 << index)).map((group) => group.id);
    try {
      selections.push(normalizePackSelection(candidate, groups));
    } catch (error) {
      if (!/ requires /.test(error.message)) throw error;
    }
  }
  return selections;
}
