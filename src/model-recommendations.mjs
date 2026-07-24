const DIMENSION_IDS = Object.freeze([
  "aaCoding",
  "aaAgentic",
  "aaIntelligence",
  "taste",
  "speed",
  "reliability",
  "quota",
  "context",
  "coachability",
  "efficiency",
]);

export const DIMENSION_LABELS = Object.freeze({
  aaCoding: "Coding (AA)",
  aaAgentic: "Agentic (AA)",
  aaIntelligence: "Intelligence (AA)",
  taste: "Personal taste",
  speed: "Effective speed",
  reliability: "Reliability",
  quota: "Quota headroom",
  context: "Context runway",
  coachability: "Coachability",
  efficiency: "Cost / quota efficiency",
});

export const DEFAULT_WEIGHTS = Object.freeze({
  aaCoding: 16,
  aaAgentic: 8,
  aaIntelligence: 6,
  taste: 18,
  speed: 14,
  reliability: 12,
  quota: 8,
  context: 8,
  coachability: 5,
  efficiency: 5,
});

const NEUTRAL_VALUE = 50;
export const SPEED_COMPARISON_OUTPUT_TOKENS = 500;
export const CONTEXT_RUNWAY_BASELINE_TOKENS = 100_000;
const CONTEXT_RUNWAY_BASELINE_UTILITY = 40;
const CONTEXT_RUNWAY_POINTS_PER_DOUBLING = 15;
const DEFAULT_FAST_LATENCY_MS = 1_000;
const DEFAULT_SLOW_LATENCY_MS = 60_000;
const DEFAULT_RESET_HORIZON_MS = 24 * 60 * 60 * 1_000;

/**
 * Bad slider values are client input, not a server fault. The dashboard maps an
 * error without statusCode to 500, which hides the message from the caller.
 */
export function invalidWeights(message) {
  const error = new RangeError(message);
  error.statusCode = 400;
  return error;
}

/**
 * Rewrite legacy recommendation weight keys without mutating the input.
 * capability → aaCoding (sum + clamp on collision); publicRating is dropped.
 * normalizeWeights stays strict and does not call this.
 */
export function migrateLegacyWeights(weights) {
  if (!isPlainObject(weights)) return weights;

  const result = { ...weights };
  if (Object.hasOwn(result, "capability")) {
    const legacy = result.capability;
    delete result.capability;
    if (Object.hasOwn(result, "aaCoding")) {
      result.aaCoding = Math.min(100, Number(result.aaCoding) + Number(legacy));
    } else {
      result.aaCoding = legacy;
    }
  }
  if (Object.hasOwn(result, "publicRating")) {
    delete result.publicRating;
  }
  return result;
}

/**
 * Validate slider weights and return fractions that sum to one. Partial inputs
 * override the defaults so old saved presets continue to gain new dimensions.
 */
export function normalizeWeights(weights = DEFAULT_WEIGHTS) {
  if (!isPlainObject(weights)) {
    throw invalidWeights("weights must be an object");
  }

  for (const key of Object.keys(weights)) {
    if (!DIMENSION_IDS.includes(key)) {
      throw invalidWeights(`unknown recommendation weight: ${key}`);
    }
    if (!isFiniteInRange(weights[key], 0, 100)) {
      throw invalidWeights(`${key} weight must be a finite number from 0 to 100`);
    }
  }

  const merged = { ...DEFAULT_WEIGHTS, ...weights };
  const total = DIMENSION_IDS.reduce((sum, id) => sum + merged[id], 0);
  if (total === 0) {
    throw invalidWeights("at least one recommendation weight must be greater than zero");
  }

  return Object.fromEntries(DIMENSION_IDS.map((id) => [id, merged[id] / total]));
}

/**
 * Convert benchmark throughput into a confidence-bearing 0..100 utility.
 * Logarithmic latency makes an improvement from 20s to 10s worth the same as
 * one from 10s to 5s, preventing very high raw token rates from dominating.
 */
export function speedUtility(input = {}) {
  if (!isPlainObject(input)) return unknownUtility("Speed data is unavailable.");

  const {
    ttftMS,
    postFirstTokenTPS,
    fastLatencyMS = DEFAULT_FAST_LATENCY_MS,
    slowLatencyMS = DEFAULT_SLOW_LATENCY_MS,
  } = input;

  if (!isFiniteInRange(ttftMS, 0, Number.MAX_VALUE) ||
      !isFiniteInRange(postFirstTokenTPS, Number.MIN_VALUE, Number.MAX_VALUE) ||
      !isFiniteInRange(fastLatencyMS, Number.MIN_VALUE, Number.MAX_VALUE) ||
      !isFiniteInRange(slowLatencyMS, Number.MIN_VALUE, Number.MAX_VALUE) ||
      fastLatencyMS >= slowLatencyMS) {
    return unknownUtility("Speed data is incomplete or invalid.");
  }

  const effectiveLatencyMS = ttftMS + (SPEED_COMPARISON_OUTPUT_TOKENS / postFirstTokenTPS) * 1_000;
  if (!Number.isFinite(effectiveLatencyMS) || effectiveLatencyMS <= 0) {
    return unknownUtility("Effective latency could not be estimated.");
  }

  const value = clamp(
    100 * (Math.log(slowLatencyMS) - Math.log(effectiveLatencyMS)) /
      (Math.log(slowLatencyMS) - Math.log(fastLatencyMS)),
    0,
    100,
  );

  return {
    value: round(value),
    confidence: 1,
    effectiveLatencyMS: round(effectiveLatencyMS),
    comparisonOutputTokens: SPEED_COMPARISON_OUTPUT_TOKENS,
    // Compatibility for consumers that displayed the old field. This is now
    // always the fixed comparison workload, never a human task estimate.
    expectedOutputTokens: SPEED_COMPARISON_OUTPUT_TOKENS,
    source: "benchmark",
    explanation: `Fixed ${SPEED_COMPARISON_OUTPUT_TOKENS}-token comparison workload is estimated at ${formatMilliseconds(effectiveLatencyMS)} including TTFT; utility uses a logarithmic ${formatMilliseconds(fastLatencyMS)}–${formatMilliseconds(slowLatencyMS)} latency scale.`,
  };
}

/**
 * Score applicable quota providers. Windows constrain one another within a
 * provider, while multiple providers are alternative routes. A reset within
 * the next 24 hours progressively relieves low remaining quota.
 */
export function quotaUtility({ providers, now = Date.now() } = {}) {
  const nowMS = parseTime(now);
  if (nowMS === null) return unknownUtility("Quota snapshot time is invalid.");

  const normalizedProviders = normalizeProviders(providers);
  if (normalizedProviders.length === 0) {
    return unknownUtility("No applicable quota data is available.");
  }

  const providerDetails = normalizedProviders.map(({ id, provider }) => scoreProviderQuota(id, provider, nowMS));
  const usable = providerDetails.filter((detail) => detail.value !== null);
  if (usable.length === 0) {
    return {
      ...unknownUtility("Applicable providers have no usable quota windows."),
      providers: providerDetails,
    };
  }

  usable.sort((left, right) => right.value - left.value || left.id.localeCompare(right.id));
  const selected = usable[0];
  const coverage = usable.length / normalizedProviders.length;
  const confidence = selected.confidence * coverage;

  return {
    value: round(selected.value),
    confidence: round(confidence),
    selectedProvider: selected.id,
    providers: providerDetails,
    source: "live quota",
    explanation: `${selected.id} is the best applicable route at ${formatPercent(selected.value)} quota utility. ${selected.explanation}`,
  };
}

/**
 * Reward usable runway without guessing how much context an autonomous agent
 * will consume. Prefer the configured compaction threshold over the absolute
 * window. Utility starts at 40 for 100k and gains 15 points per doubling,
 * saturating at 100. Compaction makes this a soft advantage, never a gate.
 */
export function contextUtility({ compactAtTokens, contextTokens } = {}) {
  const runwayTokens = isFiniteInRange(compactAtTokens, 1, Number.MAX_SAFE_INTEGER) ?
    compactAtTokens : contextTokens;
  if (!isFiniteInRange(runwayTokens, 1, Number.MAX_SAFE_INTEGER)) {
    return {
      ...unknownUtility("Context runway is unavailable."),
      eligible: true,
    };
  }

  const doublingsFromBaseline = Math.log2(runwayTokens / CONTEXT_RUNWAY_BASELINE_TOKENS);
  const value = clamp(
    CONTEXT_RUNWAY_BASELINE_UTILITY + CONTEXT_RUNWAY_POINTS_PER_DOUBLING * doublingsFromBaseline,
    0,
    100,
  );
  return {
    value: round(value),
    confidence: 1,
    eligible: true,
    source: "context map",
    runwayTokens,
    compactAtTokens: isFiniteInRange(compactAtTokens, 1, Number.MAX_SAFE_INTEGER) ? compactAtTokens : undefined,
    contextTokens: isFiniteInRange(contextTokens, 1, Number.MAX_SAFE_INTEGER) ? contextTokens : undefined,
    baselineTokens: CONTEXT_RUNWAY_BASELINE_TOKENS,
    explanation: `${formatInteger(runwayTokens)} tokens of pre-compaction runway score ${round(value)} on a soft logarithmic curve (40 at 100k, +15 per doubling); no context size is excluded.`,
  };
}

/**
 * Rank eligible profiles using confidence-shrunk dimension values. Unknown
 * evidence is neutral (50 at confidence zero), never an implicit zero.
 */
export function scoreRecommendations(profiles, {
  weights = DEFAULT_WEIGHTS,
  now = Date.now(),
} = {}) {
  if (!Array.isArray(profiles)) {
    throw new TypeError("profiles must be an array");
  }

  const normalizedWeights = normalizeWeights(weights);
  const scored = [];
  const excluded = [];

  profiles.forEach((profile, originalIndex) => {
    if (!isPlainObject(profile)) {
      throw new TypeError(`profile at index ${originalIndex} must be an object`);
    }

    const dimensions = derivedDimensions(profile, { now });
    const contributions = DIMENSION_IDS.map((dimensionId) => {
      const evidence = normalizeDimensionEvidence(dimensions[dimensionId]);
      const weightFraction = normalizedWeights[dimensionId];
      const adjustedValue = NEUTRAL_VALUE + (evidence.value - NEUTRAL_VALUE) * evidence.confidence;
      const contribution = adjustedValue * weightFraction;
      return {
        dimensionId,
        label: DIMENSION_LABELS[dimensionId],
        value: round(evidence.value),
        confidence: round(evidence.confidence),
        adjustedValue: round(adjustedValue),
        weight: round(weightFraction * 100),
        contribution: round(contribution),
        deltaFromNeutral: round((adjustedValue - NEUTRAL_VALUE) * weightFraction),
        source: evidence.source,
        missing: evidence.missing,
      };
    });

    // Ineligible profiles are returned unranked rather than dropped. Omitting
    // them let callers treat "absent from the results" as "eligible", which
    // advertised unusable routes as available.
    const ineligibleDimensions = Object.entries(dimensions)
      .filter(([, evidence]) => isHardIneligibleDimension(evidence))
      .map(([dimensionId]) => dimensionId);
    if (profile.eligible === false || profile.hardEligible === false || ineligibleDimensions.length > 0) {
      const reasons = [...(profile.reasons ?? [])];
      for (const dimensionId of ineligibleDimensions) {
        const reason = `${DIMENSION_LABELS[dimensionId] ?? dimensionId} evidence marks this profile ineligible`;
        if (!reasons.includes(reason)) reasons.push(reason);
      }
      if (reasons.length === 0) reasons.push("profile is marked ineligible");
      excluded.push({
        ...profile,
        eligible: false,
        reasons,
        score: null,
        overallScore: null,
        contributions,
        _originalIndex: originalIndex,
      });
      return;
    }

    const score = round(contributions.reduce((sum, item) => sum + item.contribution, 0));
    scored.push({
      ...profile,
      eligible: true,
      reasons: profile.reasons ?? [],
      score,
      overallScore: score,
      contributions,
      _originalIndex: originalIndex,
    });
  });

  scored.sort((left, right) => right.score - left.score || left._originalIndex - right._originalIndex);
  excluded.sort((left, right) => left._originalIndex - right._originalIndex);
  return [
    ...scored.map(({ _originalIndex, ...profile }, index) => ({ ...profile, rank: index + 1 })),
    ...excluded.map(({ _originalIndex, ...profile }) => ({ ...profile, rank: null })),
  ];
}

function derivedDimensions(profile, { now }) {
  const dimensions = isPlainObject(profile.dimensions) ? { ...profile.dimensions } : {};

  if (dimensions.speed === undefined) {
    const benchmark = firstObject(profile.benchmark, profile.speedMetrics);
    if (benchmark) dimensions.speed = speedUtility(benchmark);
  }
  if (dimensions.quota === undefined) {
    const providers = profile.quotaProviders ?? profile.providers;
    if (providers !== undefined) dimensions.quota = quotaUtility({ providers, now });
  }
  if (dimensions.context === undefined &&
      (profile.compactAtTokens !== undefined || profile.contextTokens !== undefined)) {
    dimensions.context = contextUtility({
      compactAtTokens: profile.compactAtTokens,
      contextTokens: profile.contextTokens,
    });
  }

  return dimensions;
}

function normalizeDimensionEvidence(evidence) {
  if (isFiniteInRange(evidence, 0, 100)) {
    return { value: evidence, confidence: 1, source: undefined, missing: false };
  }
  if (!isPlainObject(evidence) || !isFiniteInRange(evidence.value, 0, 100)) {
    return { value: NEUTRAL_VALUE, confidence: 0, source: undefined, missing: true };
  }

  const confidence = evidence.confidence === undefined ? 1 : evidence.confidence;
  if (!isFiniteInRange(confidence, 0, 1)) {
    return { value: NEUTRAL_VALUE, confidence: 0, source: evidence.source, missing: true };
  }
  return { value: evidence.value, confidence, source: evidence.source, missing: false };
}

function isHardIneligibleDimension(evidence) {
  return isPlainObject(evidence) && (evidence.eligible === false || evidence.hardEligible === false);
}

function scoreProviderQuota(id, provider, nowMS) {
  if (!isPlainObject(provider)) {
    return { id, value: null, confidence: 0, windows: [], explanation: "Provider quota data is invalid." };
  }

  const windows = Array.isArray(provider.windows) ? provider.windows :
    Array.isArray(provider.quotaWindows) ? provider.quotaWindows : [];
  const applicable = windows.filter((window) => !isPlainObject(window) || window.applicable !== false);
  const details = applicable.map((window, index) => scoreQuotaWindow(window, index, nowMS)).filter(Boolean);

  if (details.length === 0) {
    if (provider.state && provider.state !== "available") {
      return {
        id,
        value: 0,
        confidence: 1,
        state: provider.state,
        windows: [],
        explanation: `Provider state is ${provider.state}.`,
      };
    }
    return { id, value: null, confidence: 0, state: provider.state, windows: [], explanation: "No usable windows." };
  }

  details.sort((left, right) => left.value - right.value || left.id.localeCompare(right.id));
  const bottleneck = details[0];
  const coverage = details.length / Math.max(applicable.length, 1);
  return {
    id,
    value: bottleneck.value,
    confidence: bottleneck.confidence * coverage,
    state: provider.state,
    bottleneckWindow: bottleneck.id,
    windows: details,
    explanation: `${bottleneck.label} is the limiting window: ${formatPercent(bottleneck.remainingPercent)} remains${bottleneck.resetInMS === null ? " with no known reset" : ` and resets in ${formatDuration(bottleneck.resetInMS)}`}.`,
  };
}

function scoreQuotaWindow(window, index, nowMS) {
  if (!isPlainObject(window)) return null;
  const remainingPercent = quotaRemainingPercent(window);
  if (remainingPercent === null) return null;

  const resetAtMS = quotaResetAtMS(window, nowMS);
  const resetInMS = resetAtMS === null ? null : Math.max(0, resetAtMS - nowMS);
  const resetRelief = resetInMS === null ? 0 : 1 - clamp(resetInMS / DEFAULT_RESET_HORIZON_MS, 0, 1);
  const value = remainingPercent + (100 - remainingPercent) * resetRelief;
  return {
    id: String(window.id ?? index),
    label: String(window.label ?? window.id ?? `Window ${index + 1}`),
    remainingPercent: round(remainingPercent),
    resetAt: resetAtMS === null ? null : new Date(resetAtMS).toISOString(),
    resetInMS,
    resetRelief: round(resetRelief),
    value: round(value),
    confidence: resetAtMS === null ? 0.8 : 1,
  };
}

function quotaRemainingPercent(window) {
  if (isFiniteInRange(window.remainingPercent, 0, 100)) return window.remainingPercent;
  const used = window.usedPercent ?? window.usagePercent ?? window.usedPercentage;
  if (isFiniteInRange(used, 0, 100)) return 100 - used;
  return null;
}

function quotaResetAtMS(window, nowMS) {
  const absolute = window.resetAt ?? window.resetsAt;
  if (absolute !== undefined) return parseTime(absolute);
  if (isFiniteInRange(window.resetInMS, 0, Number.MAX_VALUE)) return nowMS + window.resetInMS;
  if (isFiniteInRange(window.resetInSeconds, 0, Number.MAX_VALUE)) return nowMS + window.resetInSeconds * 1_000;
  return null;
}

function normalizeProviders(providers) {
  if (Array.isArray(providers)) {
    return providers.map((provider, index) => ({
      id: String(provider?.id ?? provider?.name ?? `provider-${index + 1}`),
      provider,
    }));
  }
  if (isPlainObject(providers)) {
    return Object.entries(providers).map(([id, provider]) => ({ id, provider }));
  }
  return [];
}

function parseTime(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function unknownUtility(explanation) {
  return { value: NEUTRAL_VALUE, confidence: 0, source: undefined, explanation };
}

function firstObject(...values) {
  return values.find(isPlainObject);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value) {
  return `${round(value)}%`;
}

function formatMilliseconds(value) {
  return value < 1_000 ? `${Math.round(value)}ms` : `${round(value / 1_000)}s`;
}

function formatDuration(value) {
  if (value <= 0) return "0m";
  const minutes = Math.ceil(value / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}
