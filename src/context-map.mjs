import { readFileSync } from "node:fs";

export const CONTEXT_MAP_SCHEMA_VERSION = 1;
const MIN_TOKENS = 100_000;
const MAX_TOKENS = 1_048_576;
const ACTIVE_STATUS = "route-validated";

export function loadContextEnvironment(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlainObject(document) || document.schemaVersion !== CONTEXT_MAP_SCHEMA_VERSION || !isPlainObject(document.models)) {
    throw new Error("context map must contain schemaVersion 1 and a models object");
  }

  const environment = [];
  const warnings = [];
  for (const [model, profile] of Object.entries(document.models)) {
    if (!validModelId(model) || !isPlainObject(profile)) {
      warnings.push(`ignored invalid model entry: ${model}`);
      continue;
    }
    if (profile.status !== ACTIVE_STATUS) continue;
    const context = profile.contextTokens;
    const compact = profile.compactAtTokens;
    if (!Number.isInteger(context) || context < MIN_TOKENS || context > MAX_TOKENS) {
      warnings.push(`ignored ${model}: contextTokens must be an integer from ${MIN_TOKENS} to ${MAX_TOKENS}`);
      continue;
    }
    if (!Number.isInteger(compact) || compact < MIN_TOKENS || compact >= context) {
      warnings.push(`ignored ${model}: compactAtTokens must be an integer below contextTokens`);
      continue;
    }
    environment.push([`CLAUDE_ALL_CONTEXT_${model}`, String(context)]);
    environment.push([`CLAUDE_ALL_COMPACT_${model}`, String(compact)]);
  }
  return { environment, warnings };
}

function validModelId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && !value.includes("=") && !value.includes("\0");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
