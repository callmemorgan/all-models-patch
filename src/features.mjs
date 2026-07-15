import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FEATURE_CONFIG_SCHEMA = 1;
export const FEATURE_PACK_SCHEMA = 1;
export const FEATURE_PATCHER_VERSION = 10;

export const FEATURE_GROUPS = Object.freeze([
  Object.freeze({
    id: "discovery",
    name: "Foreign-model discovery",
    description: "Retain real model IDs returned by the configured gateway",
    recipeIds: Object.freeze(["gateway-filter"]),
    requires: Object.freeze([]),
  }),
  Object.freeze({
    id: "pricing",
    name: "List-equivalent pricing",
    description: "Load curated gateway costs through Claude Code's native bootstrap cache",
    recipeIds: Object.freeze(["gateway-pricing-bootstrap"]),
    requires: Object.freeze(["discovery"]),
  }),
  Object.freeze({
    id: "context",
    name: "Context and compaction",
    description: "Use validated per-model context limits and compaction thresholds",
    recipeIds: Object.freeze(["context-resolver", "compact-resolver"]),
    requires: Object.freeze([]),
  }),
  Object.freeze({
    id: "attribution",
    name: "Git attribution",
    description: "Credit the active model in generated commits",
    recipeIds: Object.freeze(["attribution"]),
    requires: Object.freeze([]),
  }),
  Object.freeze({
    id: "set-goal",
    name: "set_goal",
    description: "Expose Claude Code's native goal runtime as a model-callable tool",
    recipeIds: Object.freeze(["goal-tool-name", "goal-tool"]),
    requires: Object.freeze([]),
  }),
]);

export const ALL_FEATURE_IDS = Object.freeze(FEATURE_GROUPS.map((feature) => feature.id));

export function normalizeFeatureSelection(values, groups = FEATURE_GROUPS) {
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

export function featureProfileKey(values, groups = FEATURE_GROUPS) {
  const enabled = normalizeFeatureSelection(values, groups);
  return enabled.length === 0 ? "none" : enabled.join("+");
}

export function enumerateFeatureSelections(groups = FEATURE_GROUPS) {
  if (groups.length > 10) throw new Error("too many feature groups to enumerate safely");
  const selections = [];
  for (let bits = 0; bits < 2 ** groups.length; bits += 1) {
    const candidate = groups.filter((_, index) => bits & (1 << index)).map((group) => group.id);
    try {
      selections.push(normalizeFeatureSelection(candidate, groups));
    } catch (error) {
      if (!/ requires /.test(error.message)) throw error;
    }
  }
  return selections;
}

export function readFeatureConfig(path) {
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (config.schemaVersion !== FEATURE_CONFIG_SCHEMA) throw new Error(`unsupported feature config schema: ${config.schemaVersion}`);
    return Object.freeze({ schemaVersion: FEATURE_CONFIG_SCHEMA, enabled: Object.freeze(normalizeFeatureSelection(config.enabled)) });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function effectiveFeatureConfig(path) {
  const configured = readFeatureConfig(path);
  const enabled = configured?.enabled ?? ALL_FEATURE_IDS;
  return Object.freeze({
    schemaVersion: FEATURE_CONFIG_SCHEMA,
    source: configured ? "configured" : "default",
    profile: enabled.length === ALL_FEATURE_IDS.length ? "all" : "custom",
    enabled: Object.freeze([...enabled]),
    disabled: Object.freeze(ALL_FEATURE_IDS.filter((id) => !enabled.includes(id))),
  });
}

export function writeFeatureConfig(path, enabled) {
  const normalized = normalizeFeatureSelection(enabled);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: FEATURE_CONFIG_SCHEMA, enabled: normalized }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return effectiveFeatureConfig(path);
}

export function featureReport(config) {
  return {
    ...config,
    features: FEATURE_GROUPS.map((feature) => ({
      id: feature.id,
      name: feature.name,
      description: feature.description,
      enabled: config.enabled.includes(feature.id),
      requires: [...feature.requires],
    })),
  };
}
