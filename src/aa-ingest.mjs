import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const AA_ATTRIBUTION = "https://artificialanalysis.ai/";
const AA_SOURCE = "artificialanalysis";
const AA_UNSCORED_SOURCE = "artificialanalysis-unscored";
const EFFICIENCY_SOURCE = "artificialanalysis-cost";

/**
 * Parse CLI flags for `all-models-patch aa-ingest`.
 * Usage: aa-ingest --input <extract.json> [--write]
 */
export function parseAaIngestOptions(argv) {
  const options = { inputPath: null, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    if (arg === "--input") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--input requires a path");
      options.inputPath = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown aa-ingest option: ${arg}`);
  }
  if (!options.inputPath) throw new Error("usage: all-models-patch aa-ingest --input <extract.json> [--write]");
  return options;
}

/**
 * Pick the aaSlug with the highest coding index. Nulls rank last; ties keep first.
 * Preserve an existing selection when that slug still appears in variants.
 */
export function selectAaVariantSlug(variants, existingSelectedSlug = null) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error("variants must be a non-empty array");
  }
  if (existingSelectedSlug != null && variants.some((variant) => variant?.aaSlug === existingSelectedSlug)) {
    return existingSelectedSlug;
  }

  let bestIndex = 0;
  let bestScore = codingIndexOf(variants[0]);
  for (let index = 1; index < variants.length; index += 1) {
    const score = codingIndexOf(variants[index]);
    if (score == null) continue;
    if (bestScore == null || score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return variants[bestIndex].aaSlug;
}

/**
 * Return a NEW profile with selectedAaVariant set and AA ratings / speedMetrics
 * recomputed from that variant. Does not touch efficiency, taste, or coachability.
 */
export function applyAaVariant(profile, variantSlug, meta = {}) {
  if (!isPlainObject(profile)) throw new Error("profile must be an object");
  if (typeof variantSlug !== "string" || !variantSlug) throw new Error("variantSlug is required");

  const variants = Array.isArray(profile.aaVariants) ? profile.aaVariants : [];
  const variant = variants.find((entry) => entry?.aaSlug === variantSlug);
  if (!variant) throw new Error(`AA variant not found on profile: ${variantSlug}`);

  const evaluations = isPlainObject(variant.evaluations) ? variant.evaluations : {};
  const ratings = {
    ...profile.ratings,
    aaCoding: indexRating(evaluations.artificial_analysis_coding_index, variantSlug, meta),
    aaAgentic: indexRating(evaluations.artificial_analysis_agentic_index, variantSlug, meta),
    aaIntelligence: indexRating(evaluations.artificial_analysis_intelligence_index, variantSlug, meta),
  };

  const next = {
    ...profile,
    selectedAaVariant: variantSlug,
    ratings,
  };

  // Drop prior speed metrics so a re-selected unscored/incomplete variant cannot
  // leave stale AA throughput numbers in place.
  delete next.speedMetrics;
  const speedMetrics = speedMetricsFrom(variant.performance);
  if (speedMetrics) next.speedMetrics = speedMetrics;
  return next;
}

/**
 * Cost basis for efficiency: intelligenceIndexCost.total_cost when present,
 * otherwise blended price (3*input + output)/4.
 */
export function variantCostBasis(variant) {
  const totalCost = variant?.intelligenceIndexCost?.total_cost;
  if (isPositiveFinite(totalCost)) {
    return { cost: totalCost, basis: "index-run-cost" };
  }
  const input = variant?.pricing?.price_1m_input_tokens;
  const output = variant?.pricing?.price_1m_output_tokens;
  if (!isPositiveFinite(input) || !isPositiveFinite(output)) {
    throw new Error(`cannot derive cost basis for variant ${variant?.aaSlug ?? "(unknown)"}`);
  }
  return { cost: (3 * input + output) / 4, basis: "blended-price" };
}

/**
 * Compute efficiency ratings for a map of profileName → selected variant.
 * Score is log-scaled between best (lowest cost = 100) and worst (highest = 0).
 */
export function computeEfficiencyRatings(selectedByProfile) {
  const entries = Object.entries(selectedByProfile);
  if (entries.length === 0) return {};

  const priced = entries.map(([name, variant]) => {
    const { cost, basis } = variantCostBasis(variant);
    return { name, cost, basis };
  });

  const costs = priced.map((entry) => entry.cost);
  const bestCost = Math.min(...costs);
  const worstCost = Math.max(...costs);
  const explanation = `log scale ${bestCost} (100) to ${worstCost} (0), 2026 AA data`;

  const ratings = {};
  for (const entry of priced) {
    let value;
    if (priced.length === 1 || bestCost === worstCost) {
      value = 50;
    } else {
      value = round1(
        100 * (Math.log(worstCost) - Math.log(entry.cost)) / (Math.log(worstCost) - Math.log(bestCost)),
      );
    }
    ratings[entry.name] = {
      value,
      confidence: 0.7,
      source: EFFICIENCY_SOURCE,
      basis: entry.basis,
      explanation,
    };
  }
  return ratings;
}

/**
 * Pure transform: merge an AA roster extract into a recommendations document.
 */
export function applyAaIngest(config, extract, { inputPath }) {
  if (!isPlainObject(config) || config.schemaVersion !== 1 || !isPlainObject(config.profiles)) {
    throw new Error("recommendation config is invalid");
  }
  if (!isPlainObject(extract) || !isPlainObject(extract.agents)) {
    throw new Error("AA extract is invalid: expected top-level agents object");
  }

  const meta = {
    indexVersion: extract.intelligenceIndexVersion ?? null,
    fetchedAt: extract.generatedAt ?? null,
  };

  const next = {
    ...config,
    profiles: { ...config.profiles },
  };

  const selectedByProfile = {};
  const summaries = [];

  for (const [name, profile] of Object.entries(config.profiles)) {
    const agent = extract.agents[name];
    const variants = agent?.variants;
    if (!Array.isArray(variants) || variants.length === 0) continue;

    const withVariants = {
      ...profile,
      aaVariants: variants,
    };
    const selectedSlug = selectAaVariantSlug(variants, profile.selectedAaVariant ?? null);
    const applied = applyAaVariant(withVariants, selectedSlug, meta);
    next.profiles[name] = applied;

    const selectedVariant = variants.find((variant) => variant.aaSlug === selectedSlug);
    selectedByProfile[name] = selectedVariant;
    summaries.push({
      name,
      variantCount: variants.length,
      selectedAaVariant: selectedSlug,
      aaCoding: applied.ratings.aaCoding?.value ?? null,
      aaAgentic: applied.ratings.aaAgentic?.value ?? null,
      aaIntelligence: applied.ratings.aaIntelligence?.value ?? null,
    });
  }

  const efficiencyByProfile = computeEfficiencyRatings(selectedByProfile);
  for (const [name, efficiency] of Object.entries(efficiencyByProfile)) {
    const profile = next.profiles[name];
    next.profiles[name] = {
      ...profile,
      ratings: {
        ...profile.ratings,
        efficiency,
      },
    };
    const summary = summaries.find((entry) => entry.name === name);
    if (summary) summary.efficiency = efficiency.value;
  }

  next.aaMeta = {
    intelligenceIndexVersion: extract.intelligenceIndexVersion ?? null,
    fetchedAt: extract.generatedAt ?? null,
    extractPath: inputPath,
    attribution: AA_ATTRIBUTION,
  };

  return { document: next, summaries, meta };
}

export function readRecommendationsDocument(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`recommendation config not found: ${path}`);
    throw new Error(`could not read recommendation config ${path}: ${error.message}`);
  }
}

export function readAaExtract(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`AA extract not found: ${path}`);
    throw new Error(`could not read AA extract ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`AA extract is not valid JSON: ${error.message}`);
  }
}

/**
 * Atomic write: temp file in the same directory, then rename.
 * Mirrors writePresetDocument in dashboard.mjs.
 */
export function writeRecommendationsDocument(path, document) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // directory mode is best-effort when the parent is not owned by us
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, serializeRecommendations(document), { mode: 0o600 });
  renameSync(temporary, path);
}

export function serializeRecommendations(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function formatAaIngestSummary({ summaries, wrote, recommendationsPath }) {
  const lines = [];
  if (summaries.length === 0) {
    lines.push("aa-ingest: no profiles matched the extract");
  } else {
    lines.push(`aa-ingest: ${summaries.length} profile(s) ${wrote ? "updated" : "(dry-run)"}`);
    for (const entry of summaries) {
      lines.push(
        `  ${entry.name}: variants=${entry.variantCount} selected=${entry.selectedAaVariant}`
        + ` coding=${formatIndex(entry.aaCoding)} agentic=${formatIndex(entry.aaAgentic)}`
        + ` intelligence=${formatIndex(entry.aaIntelligence)} efficiency=${formatIndex(entry.efficiency)}`,
      );
    }
  }
  if (wrote) lines.push(`wrote ${recommendationsPath}`);
  else lines.push("dry-run: no files written (pass --write to apply)");
  return `${lines.join("\n")}\n`;
}

export function runAaIngest({ toolRoot, inputPath, write = false }) {
  if (!toolRoot) throw new Error("toolRoot is required");
  if (!inputPath) throw new Error("--input is required");

  const recommendationsPath = join(toolRoot, "config", "model-recommendations.json");
  const config = readRecommendationsDocument(recommendationsPath);
  const extract = readAaExtract(resolve(inputPath));
  const { document, summaries, meta } = applyAaIngest(config, extract, { inputPath });

  if (write) {
    writeRecommendationsDocument(recommendationsPath, document);
  }

  return {
    document,
    summaries,
    meta,
    wrote: write,
    recommendationsPath,
  };
}

function codingIndexOf(variant) {
  const value = variant?.evaluations?.artificial_analysis_coding_index;
  return Number.isFinite(value) ? value : null;
}

function indexRating(value, variantSlug, meta) {
  if (value == null || !Number.isFinite(value)) {
    return {
      value: null,
      confidence: 0,
      source: AA_UNSCORED_SOURCE,
      variant: variantSlug,
    };
  }
  return {
    value,
    confidence: 1,
    source: AA_SOURCE,
    variant: variantSlug,
    indexVersion: meta.indexVersion ?? null,
    fetchedAt: meta.fetchedAt ?? null,
  };
}

function speedMetricsFrom(performance) {
  if (!isPlainObject(performance)) return null;
  const ttftSeconds = performance.median_time_to_first_answer_token_seconds;
  const tps = performance.median_output_tokens_per_second;
  if (ttftSeconds == null || tps == null || !Number.isFinite(ttftSeconds) || !Number.isFinite(tps)) {
    return null;
  }
  return {
    ttftMS: ttftSeconds * 1000,
    postFirstTokenTPS: tps,
    source: AA_SOURCE,
  };
}

function formatIndex(value) {
  if (value == null) return "null";
  return String(value);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
