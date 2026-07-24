import { loadDashboardState, recommendFromState, resolvePresetId, validateRecommendationSettings } from "./dashboard.mjs";

const USAGE = "usage: all-models-patch recommend [--preset <id>] [--weights <json>] [--provider <list>] [--exclude-provider <list>] [--prefer-provider <list>] [--all] [--json]";

const PRESET_ALIASES = {
  fast: "fast-recon",
  tasteful: "taste-polish",
  taste: "taste-polish",
  efficient: "quota-saver",
  cheap: "quota-saver",
  deep: "deep-build",
};

const PROVIDER_ALIASES = {
  agy: "antigravity",
  anthropic: "claude",
  xai: "grok",
  openai: "codex",
  moonshot: "kimi",
};

const PREFERENCE_BONUS = 8;

/**
 * Parse CLI flags for `all-models-patch recommend`.
 * Usage: recommend [--preset <id>] [--weights <json>] [--provider <list>]
 *   [--exclude-provider <list>] [--prefer-provider <list>] [--all] [--json]
 */
export function parseRecommendOptions(argv) {
  const options = {
    preset: null,
    weights: null,
    providers: null,
    excludeProviders: null,
    preferProviders: null,
    all: false,
    json: false,
    bare: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--preset") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--preset requires an id");
      options.preset = value;
      options.bare = false;
      index += 1;
      continue;
    }
    if (arg === "--weights") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--weights requires a JSON object");
      let weights;
      try {
        weights = JSON.parse(value);
      } catch (error) {
        throw new Error(`--weights must be valid JSON: ${error.message}`);
      }
      if (!isPlainObject(weights)) throw new Error("--weights must be a JSON object");
      options.weights = value;
      options.bare = false;
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      options.providers = collectListArg(argv, index, "--provider");
      index += 1;
      continue;
    }
    if (arg === "--exclude-provider") {
      options.excludeProviders = collectListArg(argv, index, "--exclude-provider");
      index += 1;
      continue;
    }
    if (arg === "--prefer-provider") {
      if (options.providers) throw new Error("--prefer-provider is meaningless inside a hard --provider filter");
      options.preferProviders = collectListArg(argv, index, "--prefer-provider");
      index += 1;
      continue;
    }
    throw new Error(`unknown recommend option: ${arg}`);
  }
  if (options.preset && options.weights) {
    throw new Error("--preset and --weights are mutually exclusive");
  }
  return options;
}

function collectListArg(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a comma-separated list`);
  const names = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) throw new Error(`${flag} requires a comma-separated list`);
  return names;
}

export function resolveProviderName(input) {
  if (typeof input !== "string" || !input) return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

export function runRecommend({ toolRoot, paths, now = new Date(), options }) {
  const state = loadDashboardState({ toolRoot, paths, now });

  let settings;
  let presetId;
  if (options.weights) {
    let weights;
    try {
      weights = JSON.parse(options.weights);
    } catch (error) {
      throw new Error(`could not parse --weights JSON: ${error.message}`);
    }
    settings = validateRecommendationSettings({ weights });
    presetId = "custom-weights";
  } else if (options.preset) {
    const preset = resolvePresetId(options.preset, state.presets);
    if (!preset) {
      const ids = state.presets.map((entry) => entry.id).join(", ");
      const aliases = Object.entries(PRESET_ALIASES).map(([alias, id]) => `${alias}→${id}`).join(", ");
      throw new Error(`unknown preset: ${options.preset}. Available: ${ids}. Aliases: ${aliases}`);
    }
    settings = preset.settings;
    presetId = preset.id;
  } else {
    const preset = resolvePresetId("balanced", state.presets);
    settings = preset.settings;
    presetId = preset.id;
  }

  const envelope = recommendFromState(state, settings, now);
  const rosterById = new Map(state.roster.map((profile) => [profile.id, profile]));

  let recommendations = envelope.recommendations;
  let providerFilter = null;
  let providerExclusions = null;
  let providerPreference = null;

  function profileProviders(id) {
    return rosterById.get(id)?.providers ?? [];
  }

  function matchesProviders(id, targets) {
    const providers = profileProviders(id);
    return targets.some((target) => providers.includes(target));
  }

  if (options.providers && options.providers.length > 0) {
    const targets = resolveProviderList(options.providers);
    providerFilter = targets;
    recommendations = recommendations.filter((recommendation) => matchesProviders(recommendation.id, targets));
    if (recommendations.length === 0) {
      const available = rosterProviders(state.roster);
      throw new Error(`no profiles match providers: ${targets.join(", ")}. Available providers: ${available}`);
    }
  }

  if (options.excludeProviders && options.excludeProviders.length > 0) {
    const targets = resolveProviderList(options.excludeProviders);
    providerExclusions = targets;
    const beforeCount = recommendations.length;
    recommendations = recommendations.filter((recommendation) => !matchesProviders(recommendation.id, targets));
    if (recommendations.length === 0) {
      const remaining = rosterProviders(state.roster, targets);
      throw new Error(`--exclude-provider removed all profiles. Remaining providers: ${remaining}`);
    }
    // If the exclusion only dropped ineligible rows, report nothing special; the
    // surviving set is still valid.
  }

  if (options.preferProviders && options.preferProviders.length > 0) {
    const targets = resolveProviderList(options.preferProviders);
    providerPreference = targets;
    // Bias must be visible and bounded, never a silent filter: keep the true
    // weighted score intact, expose the bonus separately, and sort on the sum.
    recommendations = recommendations
      .map((recommendation) => {
        const bonus = matchesProviders(recommendation.id, targets) ? PREFERENCE_BONUS : 0;
        return { ...recommendation, preferenceBonus: bonus };
      })
      .sort((left, right) => {
        const leftKey = (left.score ?? -Infinity) + (left.preferenceBonus ?? 0);
        const rightKey = (right.score ?? -Infinity) + (right.preferenceBonus ?? 0);
        return rightKey - leftKey || (left._originalIndex ?? 0) - (right._originalIndex ?? 0);
      })
      .map((recommendation, index) => ({ ...recommendation, rank: index + 1 }));
  } else {
    recommendations = recommendations.map((recommendation, index) => ({ ...recommendation, rank: index + 1 }));
  }

  const presets = state.presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    whenToUse: preset.whenToUse ?? undefined,
    cues: preset.cues ?? undefined,
    builtin: preset.builtin ?? false,
  }));

  const topId = recommendations.find((recommendation) => recommendation.eligible !== false)?.id ?? null;
  const topProvenance = topId ? (state.roster.find((profile) => profile.id === topId)?.provenance ?? []) : [];

  return {
    generatedAt: envelope.generatedAt,
    settings: envelope.settings,
    recommendations,
    presetId,
    presets,
    providerFilter,
    providerExclusions,
    providerPreference,
    dataSources: state.dataSources,
    topProvenance,
  };
}

function resolveProviderList(names) {
  return [...new Set(names.map(resolveProviderName).filter(Boolean))];
}

function rosterProviders(roster, excluding = []) {
  return [...new Set(roster
    .flatMap((profile) => profile.providers ?? [])
    .filter((provider) => !excluding.includes(provider)))].sort().join(", ");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatRecommendSummary(result, options) {
  const lines = [];

  if (options.bare) {
    lines.push("Presets:");
    for (const preset of result.presets) {
      const cueList = Array.isArray(preset.cues) ? preset.cues.map((cue) => `"${cue}"`).join(", ") : "";
      lines.push(`  ${preset.id} — ${preset.whenToUse ?? ""}${cueList ? ` (cues: ${cueList})` : ""}`);
    }
    lines.push("");
  }

  lines.push(`Preset: ${result.presetId} · generated ${result.generatedAt}`);
  if (result.providerFilter && result.providerFilter.length > 0) {
    lines.push(`Providers: ${result.providerFilter.join(", ")}`);
  }
  if (result.providerExclusions && result.providerExclusions.length > 0) {
    lines.push(`Excluding: ${result.providerExclusions.join(", ")}`);
  }
  if (result.providerPreference && result.providerPreference.length > 0) {
    lines.push(`Preferring: ${result.providerPreference.join(", ")} (+${PREFERENCE_BONUS})`);
  }

  const benchmarkProvenance = result.topProvenance.find((source) => /\bbenchmark\b/i.test(source));
  if (benchmarkProvenance) {
    lines.push(`Provenance: ${benchmarkProvenance}`);
  }

  const quotaSource = result.dataSources?.find((source) => source.name === "Provider quota");
  if (quotaSource) {
    lines.push(`Quota cache: ${quotaSource.updatedAt ?? "unavailable"}`);
  }

  const eligible = result.recommendations.filter((recommendation) => recommendation.eligible !== false);
  const ineligible = result.recommendations.filter((recommendation) => recommendation.eligible === false);

  for (const recommendation of eligible) {
    const topDimensions = (recommendation.dimensions ?? [])
      .slice()
      .sort((left, right) => Math.abs(right.contribution ?? 0) - Math.abs(left.contribution ?? 0))
      .slice(0, 3)
      .map((dimension) => `"${dimension.label} ${dimension.value} (${dimension.source ?? "missing"})"`)
      .join(", ");
    const bonus = recommendation.preferenceBonus ? ` (preferred +${recommendation.preferenceBonus})` : "";
    lines.push(`#${recommendation.rank} ${recommendation.id} ${recommendation.score}${bonus} — ${topDimensions}`);
  }

  for (const recommendation of ineligible) {
    const reasons = Array.isArray(recommendation.reasons) && recommendation.reasons.length > 0
      ? recommendation.reasons.join("; ")
      : "ineligible";
    lines.push(`— ${recommendation.id}: ${reasons}`);
  }

  return `${lines.join("\n")}\n`;
}
