import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { renderDashboardHTML } from "./dashboard-assets.mjs";
import {
  DEFAULT_WEIGHTS,
  contextUtility,
  migrateLegacyWeights,
  normalizeWeights,
  quotaUtility,
  scoreRecommendations,
  speedUtility,
} from "./model-recommendations.mjs";

export const DASHBOARD_SCHEMA_VERSION = 1;
export const DASHBOARD_PRESET_SCHEMA_VERSION = 1;

const MAX_REQUEST_BYTES = 64 * 1024;
const LOOPBACK_HOST = "127.0.0.1";

export function parseDashboardOptions(argv) {
  const options = { port: 0, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--port requires a value");
      if (!/^\d+$/.test(value)) throw new Error("--port must be an integer from 0 through 65535");
      options.port = Number(value);
      if (!Number.isSafeInteger(options.port) || options.port > 65_535) {
        throw new Error("--port must be an integer from 0 through 65535");
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown dashboard option: ${arg}`);
  }
  return options;
}

export async function runDashboard({ toolRoot, paths, version = "local", port = 0, open = true }, dependencies = {}) {
  const deps = {
    createServer,
    makeToken: randomUUID,
    openURL: openBrowser,
    now: () => new Date(),
    ...dependencies,
  };
  const token = deps.makeToken();
  const app = createDashboardApp({
    toolRoot,
    paths,
    token,
    version,
    now: deps.now,
    refreshQuota: () => refreshQuotaCache(paths),
  });
  const server = deps.createServer(app);
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

  await listen(server, port, LOOPBACK_HOST);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("dashboard server did not expose a TCP address");
  const url = `http://${LOOPBACK_HOST}:${address.port}/${encodeURIComponent(token)}/`;
  process.stdout.write(`Model Cockpit: ${url}\n`);
  process.stdout.write("Press Ctrl-C to stop.\n");
  if (open) deps.openURL(url);

  await waitForShutdown(server);
}

async function defaultApplyAaVariant(profile, variantSlug, meta) {
  const module = await import("./aa-ingest.mjs");
  return module.applyAaVariant(profile, variantSlug, meta);
}

export function createDashboardApp({
  toolRoot,
  paths,
  token,
  version = "local",
  now = () => new Date(),
  refreshQuota = null,
  applyVariant = null,
}) {
  if (!toolRoot) throw new Error("dashboard tool root is required");
  if (!paths?.home || !paths?.stateDirectory || !paths?.configDirectory) throw new Error("dashboard paths are incomplete");
  if (!token) throw new Error("dashboard token is required");

  const resolveApplyVariant = applyVariant ?? defaultApplyAaVariant;
  const pagePath = `/${encodeURIComponent(token)}/`;
  let quotaRefreshPromise = null;
  let quotaRefreshedAt = 0;
  const maybeRefreshQuota = async () => {
    if (!refreshQuota || now().getTime() - quotaRefreshedAt < 60_000) return;
    if (!quotaRefreshPromise) {
      quotaRefreshPromise = Promise.resolve(refreshQuota()).finally(() => {
        quotaRefreshedAt = now().getTime();
        quotaRefreshPromise = null;
      });
    }
    await quotaRefreshPromise;
  };
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === pagePath) {
        sendHTML(response, renderDashboardHTML({ token, version }));
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204, securityHeaders());
        response.end();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        sendJSON(response, 404, { error: "not found" });
        return;
      }
      if (request.headers["x-all-models-patch-token"] !== token) {
        sendJSON(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        await maybeRefreshQuota();
        sendJSON(response, 200, loadDashboardState({ toolRoot, paths, now: now() }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/recommend") {
        const body = await readJSONBody(request);
        const state = loadDashboardState({ toolRoot, paths, now: now() });
        sendJSON(response, 200, recommendFromState(state, body, now()));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/aa-variant") {
        const body = await readJSONBody(request);
        const entry = await selectAaVariant({
          toolRoot,
          paths,
          profileName: body?.profile,
          variantSlug: body?.variant,
          now: now(),
          applyVariant: resolveApplyVariant,
        });
        sendJSON(response, 200, entry);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/presets") {
        const body = await readJSONBody(request);
        const preset = saveDashboardPreset(paths, body, now());
        sendJSON(response, 201, preset);
        return;
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/presets/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/presets/".length));
        deleteDashboardPreset(paths, id);
        sendJSON(response, 200, { deleted: id });
        return;
      }
      sendJSON(response, 404, { error: "not found" });
    } catch (error) {
      const status = error.statusCode ?? 500;
      sendJSON(response, status, { error: status === 500 ? "dashboard request failed" : error.message });
      if (status === 500) console.error(`all-models-patch dashboard: ${error.stack ?? error.message}`);
    }
  };
}

export async function refreshQuotaCache(paths, dependencies = {}) {
  const executable = join(paths?.localBin ?? "", "agents-statusline");
  if (!paths?.localBin || !existsSync(executable)) return false;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const timeoutMS = dependencies.timeoutMS ?? 15_000;
  return new Promise((resolvePromise) => {
    let settled = false;
    let timeout = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolvePromise(result);
    };
    let child;
    try {
      child = spawnProcess(executable, ["foreign-usage-refresh"], { stdio: "ignore" });
    } catch {
      finish(false);
      return;
    }
    let escalation = null;
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      // Escalate rather than leaving a helper that ignores SIGTERM running and
      // unreaped; the close listener below stays attached to reap it.
      escalation = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000);
      escalation.unref?.();
      finish(false);
    }, timeoutMS);
    child.once("error", () => finish(false));
    child.once("close", (code) => {
      if (escalation) clearTimeout(escalation);
      finish(code === 0);
    });
  });
}

export function loadDashboardState({ toolRoot, paths, now = new Date() }) {
  const agents = readPreferredJSON(
    join(paths.home, ".cli-proxy-api", "claude-all-agents.json"),
    join(toolRoot, "config", "claude-all-agents.json"),
    "agent roster",
  );
  const contexts = readPreferredJSON(
    join(paths.home, ".cli-proxy-api", "claude-all-contexts.json"),
    join(toolRoot, "config", "claude-all-contexts.json"),
    "context map",
  );
  const metadataPath = join(toolRoot, "config", "model-recommendations.json");
  const metadata = readJSONFile(metadataPath, "recommendation metadata");
  validateDashboardInputs(agents.value, contexts.value, metadata);

  const benchmarkRoot = join(paths.stateDirectory, "benchmarks");
  const benchmarks = loadLatestBenchmarks(benchmarkRoot, agents.value);
  const quotaPath = join(dirname(paths.stateDirectory), "agents-statusline", "foreign-usage.json");
  const quota = loadQuotaCache(quotaPath);
  const profiles = buildRoster({
    agents: agents.value,
    contexts: contexts.value.models,
    metadata: metadata.profiles,
    benchmarks,
    quota,
    now,
  });
  const defaults = { weights: { ...DEFAULT_WEIGHTS } };
  const recommendations = recommendProfiles(profiles, defaults, now);
  const byID = new Map(recommendations.map((item) => [item.id, item]));
  const roster = profiles.map((profile) => ({
    ...profile,
    defaultScore: byID.get(profile.id)?.score ?? null,
    // Fail closed: a profile missing from the scored set is not evidence that
    // it is usable, so it must never default to eligible.
    eligible: byID.get(profile.id)?.eligible ?? false,
    reasons: byID.get(profile.id)?.reasons ?? ["profile was not scored"],
  }));

  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    defaults,
    presets: [...builtInPresets(), ...readDashboardPresets(paths)],
    roster,
    dataSources: [
      sourceDescriptor("Agent roster", agents.path, agents.live, safeMtime(agents.path), paths.home),
      sourceDescriptor("Context map", contexts.path, contexts.live, safeMtime(contexts.path), paths.home),
      sourceDescriptor("Recommendation metadata", "config/model-recommendations.json", false, safeMtime(metadataPath), null),
      sourceDescriptor("Raw response benchmarks", benchmarkRoot, true, latestBenchmarkTime(benchmarks), paths.home),
      sourceDescriptor("Provider quota", quotaPath, true, quota.fetchedAt, paths.home, quota.error),
    ],
  };
}

export function recommendFromState(state, request, now = new Date()) {
  const settings = validateRecommendationSettings({
    weights: request?.weights ?? state.defaults.weights,
  });
  return {
    generatedAt: now.toISOString(),
    settings,
    recommendations: recommendProfiles(state.roster, settings, now),
  };
}

export function recommendProfiles(roster, settings, now = new Date()) {
  const validated = validateRecommendationSettings(settings);
  const candidates = roster.map((profile) => {
    const contextResult = contextUtility({
      contextTokens: profile.context?.contextTokens,
      compactAtTokens: profile.context?.compactAtTokens,
    });
    const dimensions = {
      aaCoding: ratingDimension(profile.ratings?.aaCoding),
      aaAgentic: ratingDimension(profile.ratings?.aaAgentic),
      aaIntelligence: ratingDimension(profile.ratings?.aaIntelligence),
      taste: ratingDimension(profile.ratings?.taste),
      speed: speedDimension(profile.benchmark),
      reliability: reliabilityDimension(profile.benchmark),
      quota: quotaDimension(profile.quota, now),
      context: {
        value: contextResult.value,
        confidence: contextResult.confidence,
        source: contextResult.source ?? profile.context?.source ?? "missing",
        explanation: contextResult.explanation,
      },
      coachability: ratingDimension(profile.ratings?.coachability),
      efficiency: ratingDimension(profile.ratings?.efficiency),
    };
    const reasons = [];
    if (isRouteUnavailable(profile.quota?.state)) reasons.push("all configured provider routes are unavailable or cooling down");
    return {
      id: profile.id,
      eligible: !isRouteUnavailable(profile.quota?.state),
      reasons,
      dimensions,
    };
  });
  return scoreRecommendations(candidates, { weights: validated.weights }).map((recommendation) => {
    const { contributions, ...rest } = recommendation;
    return { ...rest, dimensions: contributions };
  });
}

export function validateRecommendationSettings(settings) {
  const normalizedWeights = normalizeWeights(settings?.weights ?? DEFAULT_WEIGHTS);
  return {
    weights: Object.fromEntries(Object.entries(normalizedWeights).map(([id, weight]) => [id, roundNumber(weight * 100)])),
  };
}

const ACCEPTED_BENCHMARK_FIXTURES = new Set(["raw-v1", "aa-long-v1", "aa-story-v1"]);
// Free-form fixtures rank speed on tokenizer-neutral chars/s; this converts the
// rate back into speedUtility's token-based workload model. Four visible
// characters per token is a neutral cross-provider constant, not any single
// vendor's tokenizer.
const NEUTRAL_CHARS_PER_TOKEN = 4;
const FIXTURE_PREFERENCE = ["aa-story-v1", "aa-long-v1", "raw-v1"];

export function loadLatestBenchmarks(root, agents) {
  const latest = new Map();
  if (!existsSync(root)) return latest;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      const path = join(root, entry.name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
    }
    const path = join(root, entry.name, "summary.json");
    if (!existsSync(path)) continue;
    let summary;
    try {
      summary = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const fixtureId = summary?.fixture?.id;
    if (summary?.schemaVersion !== 1 || !ACCEPTED_BENCHMARK_FIXTURES.has(fixtureId) || !Array.isArray(summary.agents)) continue;
    const completedAt = Date.parse(summary.completedAt);
    if (!Number.isFinite(completedAt)) continue;
    for (const result of summary.agents) {
      if (!Object.hasOwn(agents, result.name) || agents[result.name]?.model !== result.configuredModel) continue;
      const candidate = {
        runID: summary.runID,
        artifact: entry.name,
        completedAt: summary.completedAt,
        fixtureId,
        routes: Array.isArray(result.routes) ? result.routes : [],
        validSamples: finiteCount(result.validSamples),
        measuredSamples: finiteCount(result.measuredSamples),
        formatPasses: finiteCount(result.formatPasses),
        retries: finiteCount(result.retries),
        ttftMS: safeDistribution(result.ttftMS),
        ttfatMS: safeDistribution(result.ttfatMS),
        latencyMS: safeDistribution(result.latencyMS),
        postFirstTokenTPS: safeDistribution(result.postFirstTokenTPS),
        endToEndTPS: safeDistribution(result.endToEndTPS),
        visibleCharactersPerSecond: safeDistribution(result.visibleCharactersPerSecond),
        provisional: finiteCount(result.validSamples) < 3 || finiteCount(result.validSamples) < finiteCount(result.measuredSamples),
      };
      const previous = latest.get(result.name);
      if (previous && !preferBenchmarkCandidate(candidate, previous)) continue;
      latest.set(result.name, candidate);
    }
  }
  return latest;
}

function preferBenchmarkCandidate(candidate, previous) {
  const candidateRank = FIXTURE_PREFERENCE.indexOf(candidate.fixtureId);
  const previousRank = FIXTURE_PREFERENCE.indexOf(previous.fixtureId);
  if (candidateRank !== previousRank) return candidateRank < previousRank;
  return Date.parse(candidate.completedAt) > Date.parse(previous.completedAt);
}

export function loadQuotaCache(path) {
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (!payload || typeof payload !== "object" || typeof payload.providers !== "object") throw new Error("invalid quota cache schema");
    return {
      fetchedAt: validDateString(payload.fetchedAt),
      providers: payload.providers,
      error: null,
    };
  } catch (error) {
    return { fetchedAt: null, providers: {}, error: error.code === "ENOENT" ? "not available" : error.message };
  }
}

export function saveDashboardPreset(paths, input, now = new Date()) {
  const name = String(input?.name ?? "").trim();
  if (!name || name.length > 48 || /[\u0000-\u001f\u007f]/.test(name)) badRequest("preset name must contain 1 through 48 printable characters");
  const settings = validateRecommendationSettings(input?.settings ?? {});
  const document = readPresetDocument(paths);
  const preset = {
    id: randomUUID(),
    name,
    builtin: false,
    settings,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  document.presets.push(preset);
  writePresetDocument(paths, document);
  return preset;
}

export function deleteDashboardPreset(paths, id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) badRequest("invalid preset id");
  const document = readPresetDocument(paths);
  const next = document.presets.filter((preset) => preset.id !== id);
  if (next.length === document.presets.length) {
    const error = new Error("preset not found");
    error.statusCode = 404;
    throw error;
  }
  writePresetDocument(paths, { ...document, presets: next });
}

export function readDashboardPresets(paths) {
  return readPresetDocument(paths).presets.map((preset) => ({
    ...preset,
    settings: validateRecommendationSettings({
      ...preset?.settings,
      weights: migrateLegacyWeights(preset?.settings?.weights),
    }),
    whenToUse: preset?.whenToUse ?? undefined,
  }));
}

export async function selectAaVariant({
  toolRoot,
  paths,
  profileName,
  variantSlug,
  now = new Date(),
  applyVariant = defaultApplyAaVariant,
}) {
  const profile = String(profileName ?? "").trim();
  const variant = String(variantSlug ?? "").trim();
  if (!profile) badRequest("profile is required");
  if (!variant) badRequest("variant is required");

  const metadataPath = join(toolRoot, "config", "model-recommendations.json");
  const metadata = readJSONFile(metadataPath, "recommendation metadata");
  if (!metadata || metadata.schemaVersion !== 1 || !metadata.profiles || typeof metadata.profiles !== "object") {
    throw new Error("dashboard recommendation metadata is invalid");
  }

  const profileData = metadata.profiles[profile];
  if (!profileData || typeof profileData !== "object") badRequest("unknown profile");
  if (!Array.isArray(profileData.aaVariants) || profileData.aaVariants.length === 0) {
    badRequest("profile has no Artificial Analysis variants");
  }
  if (!profileData.aaVariants.some((entry) => entry?.aaSlug === variant)) {
    badRequest("unknown Artificial Analysis variant");
  }

  const updatedProfile = await Promise.resolve(applyVariant(profileData, variant, { now }));
  if (!updatedProfile || typeof updatedProfile !== "object") {
    throw new Error("applyAaVariant must return a profile object");
  }

  const nextDocument = {
    ...metadata,
    profiles: {
      ...metadata.profiles,
      [profile]: updatedProfile,
    },
  };
  writeJSONAtomic(metadataPath, nextDocument);

  const state = loadDashboardState({ toolRoot, paths, now });
  const entry = state.roster.find((item) => item.id === profile);
  if (!entry) badRequest("profile is not in the agent roster");
  return entry;
}

function buildRoster({ agents, contexts, metadata, benchmarks, quota, now }) {
  return Object.entries(agents).map(([id, definition]) => {
    const profileMetadata = metadata[id] ?? emptyMetadata();
    const benchmark = benchmarks.get(id) ?? null;
    const profileQuota = buildProfileQuota(profileMetadata, quota, now);
    const entry = {
      id,
      model: definition.model,
      description: typeof definition.description === "string" ? definition.description : "",
      provider: profileMetadata.providers?.join(" / ") || routeProviders(benchmark).join(" / ") || "unknown",
      providers: profileMetadata.providers ?? routeProviders(benchmark),
      roles: profileMetadata.roles ?? [],
      context: contexts[definition.model] ?? null,
      benchmark,
      quota: profileQuota,
      ratings: profileMetadata.ratings ?? emptyRatings(),
      caveats: profileMetadata.caveats ?? [],
      provenance: buildProvenance(profileMetadata, benchmark, profileQuota),
    };
    const aaVariants = summarizeAaVariants(profileMetadata.aaVariants);
    if (aaVariants) {
      entry.aaVariants = aaVariants;
      entry.selectedAaVariant = typeof profileMetadata.selectedAaVariant === "string"
        ? profileMetadata.selectedAaVariant
        : null;
    }
    return entry;
  });
}

function summarizeAaVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  return variants.map((variant) => ({
    aaSlug: typeof variant?.aaSlug === "string" ? variant.aaSlug : "",
    aaName: typeof variant?.aaName === "string" ? variant.aaName : String(variant?.aaSlug ?? ""),
    artificial_analysis_coding_index: finiteNumberOrNull(variant?.evaluations?.artificial_analysis_coding_index),
    artificial_analysis_agentic_index: finiteNumberOrNull(variant?.evaluations?.artificial_analysis_agentic_index),
    artificial_analysis_intelligence_index: finiteNumberOrNull(variant?.evaluations?.artificial_analysis_intelligence_index),
    median_output_tokens_per_second: finiteNumberOrNull(variant?.performance?.median_output_tokens_per_second),
    median_time_to_first_answer_token_seconds: finiteNumberOrNull(variant?.performance?.median_time_to_first_answer_token_seconds),
  }));
}

function buildProfileQuota(metadata, quota, now) {
  const candidates = [];
  for (const providerID of metadata.providers ?? []) {
    const provider = quota.providers[providerID];
    if (!provider) continue;
    const requestedIDs = metadata.quotaWindowIds?.[providerID] ?? [];
    const windows = (Array.isArray(provider.windows) ? provider.windows : [])
      .filter((window) => requestedIDs.length === 0 || requestedIDs.includes(window.id))
      // A window with no usable usedPercent is unknown, not empty. Clamping it
      // to 0 reported 100% remaining and ranked an exhausted route as the best
      // available one.
      .filter((window) => Number.isFinite(Number(window?.usedPercent)))
      .map((window) => ({
        id: String(window.id ?? ""),
        label: String(window.label ?? window.id ?? "Quota"),
        usedPercent: clampNumber(window.usedPercent, 0, 100),
        remainingPercent: roundNumber(100 - clampNumber(window.usedPercent, 0, 100)),
        resetAt: validDateString(window.resetAt),
      }));
    const state = String(provider.state ?? "unknown");
    const result = quotaUtility({ providers: [{ id: providerID, state, windows }], now });
    candidates.push({ provider: providerID, state, windows, score: result.value, confidence: result.confidence });
  }
  if (candidates.length === 0) {
    return {
      score: null,
      state: quota.error ? "unknown" : "untracked",
      provider: metadata.providers?.join(" / ") || "unknown",
      windows: [],
      fetchedAt: quota.fetchedAt,
      error: quota.error,
    };
  }
  candidates.sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
  const available = candidates.filter((candidate) => candidate.state === "available");
  const selected = available[0] ?? candidates[0];
  return {
    ...selected,
    state: available.length > 0 ? "available" : candidates.every((candidate) => candidate.state === "unavailable") ? "unavailable" : selected.state,
    fetchedAt: quota.fetchedAt,
    alternatives: candidates.slice(1),
    error: quota.error,
  };
}

export function speedDimension(benchmark) {
  const hasTtfat = Number.isFinite(benchmark?.ttfatMS?.p50);
  const latencyMetric = hasTtfat ? "ttfatMS" : "ttftMS";
  const latencyMS = hasTtfat ? benchmark.ttfatMS.p50 : benchmark?.ttftMS?.p50;
  const fixtureId = benchmark?.fixtureId ?? "raw-v1";
  // Provider tokenizers count identical text differently, so cross-model rate
  // comparisons must use chars/s where the fixture provides it; the neutral
  // conversion keeps speedUtility's token-based workload model.
  const charsPerSecond = benchmark?.visibleCharactersPerSecond?.p50;
  const hasChars = Number.isFinite(charsPerSecond) && charsPerSecond > 0;
  const rateMetric = hasChars ? "charsPS" : "tokPS";
  const result = speedUtility({
    ttftMS: latencyMS,
    postFirstTokenTPS: hasChars ? charsPerSecond / NEUTRAL_CHARS_PER_TOKEN : benchmark?.postFirstTokenTPS?.p50,
  });
  const valid = finiteCount(benchmark?.validSamples);
  const measured = finiteCount(benchmark?.measuredSamples);
  return {
    value: result.value,
    confidence: measured > 0 ? Math.min(1, valid / 3) * (valid / measured) : 0,
    source: benchmark ? `${fixtureId} ${latencyMetric}+${rateMetric} ${benchmark.runID}` : "missing",
  };
}

function reliabilityDimension(benchmark) {
  const valid = finiteCount(benchmark?.validSamples);
  const measured = finiteCount(benchmark?.measuredSamples);
  return {
    value: measured > 0 ? roundNumber((valid / measured) * 100) : 50,
    confidence: measured > 0 ? Math.min(1, measured / 5) : 0,
    source: benchmark ? `${benchmark.fixtureId} fixture completion ${valid}/${measured}` : "missing",
  };
}

function quotaDimension(quota, now) {
  const fetchedAt = Date.parse(quota?.fetchedAt);
  const ageMS = Number.isFinite(fetchedAt) ? Math.max(0, now.getTime() - fetchedAt) : Infinity;
  return {
    value: Number.isFinite(quota?.score) ? quota.score : 50,
    confidence: Number.isFinite(quota?.score) ? Math.max(0.2, Math.exp(-ageMS / (30 * 60_000))) : 0,
    source: quota?.provider ? `${quota.provider} subscription windows` : "missing",
  };
}

function ratingDimension(rating) {
  return {
    value: Number.isFinite(rating?.value) ? clampNumber(rating.value, 0, 100) : 50,
    confidence: Number.isFinite(rating?.value) ? clampNumber(rating.confidence, 0, 1) : 0,
    source: String(rating?.source ?? "missing"),
  };
}

function builtInPresets() {
  const preset = (id, name, weights, whenToUse, cues) => ({
    id,
    name,
    builtin: true,
    settings: { weights },
    whenToUse,
    cues,
  });
  return [
    preset("balanced", "Balanced", { ...DEFAULT_WEIGHTS }, "Default blend when no mode is stated.", ["do a balanced job", "just route sensibly"]),
    preset("deep-build", "Deep build", {
      aaCoding: 30, aaAgentic: 6, aaIntelligence: 4, taste: 20, speed: 5, reliability: 15, quota: 5, context: 5, coachability: 5, efficiency: 5,
    }, "Hard implementation or debugging that must be done right; capability outweighs speed and cost.", ["do it right", "this is the hard part", "deep work"]),
    preset("taste-polish", "Taste & polish", {
      aaCoding: 15, aaAgentic: 8, aaIntelligence: 7, taste: 35, speed: 5, reliability: 10, quota: 5, context: 0, coachability: 5, efficiency: 10,
    }, "UI, copy, or API-surface polish where taste and coachability lead.", ["make it tasteful", "polish the UI", "make it pretty"]),
    preset("fast-recon", "Fast recon", {
      aaCoding: 10, aaAgentic: 3, aaIntelligence: 2, taste: 5, speed: 35, reliability: 15, quota: 10, context: 15, coachability: 0, efficiency: 5,
    }, "High-volume sweeps, extraction, and recon where speed and context beat capability.", ["get something out fast", "quick pass", "just scan it"]),
    preset("quota-saver", "Quota saver", {
      aaCoding: 15, aaAgentic: 3, aaIntelligence: 2, taste: 10, speed: 10, reliability: 10, quota: 30, context: 5, coachability: 5, efficiency: 10,
    }, "Cost-sensitive work when premium windows are hot; efficiency and quota lead.", ["be efficient", "keep it cheap", "save quota"]),
  ];
}

export function resolvePresetId(input, presets) {
  if (typeof input !== "string" || !input) return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  const aliases = {
    fast: "fast-recon",
    tasteful: "taste-polish",
    taste: "taste-polish",
    efficient: "quota-saver",
    cheap: "quota-saver",
    deep: "deep-build",
  };
  const targetId = aliases[normalized] ?? normalized;
  for (const preset of presets ?? []) {
    if (preset.id?.toLowerCase() === targetId) return preset;
  }
  for (const preset of presets ?? []) {
    if (preset.name?.toLowerCase() === targetId) return preset;
  }
  return null;
}

function readPreferredJSON(livePath, shippedPath, label) {
  const path = existsSync(livePath) ? livePath : shippedPath;
  return { value: readJSONFile(path, label), path, live: path === livePath };
}

function readJSONFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label} ${path}: ${error.message}`);
  }
}

function validateDashboardInputs(agents, contexts, metadata) {
  if (!agents || Array.isArray(agents) || typeof agents !== "object") throw new Error("dashboard agent roster must be an object");
  if (!contexts || contexts.schemaVersion !== 1 || !contexts.models || typeof contexts.models !== "object") throw new Error("dashboard context map is invalid");
  if (!metadata || metadata.schemaVersion !== 1 || !metadata.profiles || typeof metadata.profiles !== "object") throw new Error("dashboard recommendation metadata is invalid");
  for (const [id, definition] of Object.entries(agents)) {
    if (!definition || typeof definition.model !== "string" || !definition.model.trim()) throw new Error(`dashboard agent ${id} has no model`);
    if (!Object.hasOwn(contexts.models, definition.model)) throw new Error(`dashboard agent ${id} has no context entry for ${definition.model}`);
  }
}

function readPresetDocument(paths) {
  const path = presetPath(paths);
  try {
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (document?.schemaVersion !== DASHBOARD_PRESET_SCHEMA_VERSION || !Array.isArray(document.presets)) throw new Error("unsupported preset schema");
    return document;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: DASHBOARD_PRESET_SCHEMA_VERSION, presets: [] };
    throw new Error(`could not read dashboard presets ${path}: ${error.message}`);
  }
}

function writePresetDocument(paths, document) {
  writeJSONAtomic(presetPath(paths), document, { mode: 0o600, directoryMode: 0o700 });
}

function writeJSONAtomic(path, document, { mode = 0o600, directoryMode = 0o700 } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: directoryMode });
  chmodSync(dirname(path), directoryMode);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode });
  renameSync(temporary, path);
}

function presetPath(paths) {
  return join(paths.configDirectory, "dashboard-presets.json");
}

function sourceDescriptor(name, path, live, updatedAt, relativeRoot, error = null) {
  return {
    name,
    location: relativeRoot && path.startsWith(relativeRoot) ? `~${path.slice(relativeRoot.length)}` : path,
    mode: live ? "live" : "shipped",
    updatedAt: updatedAt || null,
    status: error ? "unavailable" : "available",
    error: error || null,
  };
}

function buildProvenance(metadata, benchmark, quota) {
  const sources = new Set();
  for (const rating of Object.values(metadata.ratings ?? {})) if (rating?.source) sources.add(rating.source);
  if (benchmark) sources.add(`${benchmark.fixtureId} benchmark ${benchmark.runID}`);
  if (quota?.fetchedAt) sources.add(`quota cache ${quota.fetchedAt}`);
  return [...sources];
}

function routeProviders(benchmark) {
  return [...new Set((benchmark?.routes ?? []).map((route) => {
    const provider = String(route).split("/")[0];
    if (provider === "xai") return "grok";
    if (provider === "openai-compatible-ollama") return "ollama";
    return provider;
  }).filter(Boolean))];
}

function isRouteUnavailable(state) {
  return state === "unavailable" || state === "cooldown";
}

function latestBenchmarkTime(benchmarks) {
  let latest = null;
  for (const benchmark of benchmarks.values()) {
    if (!latest || Date.parse(benchmark.completedAt) > Date.parse(latest)) latest = benchmark.completedAt;
  }
  return latest;
}

function emptyMetadata() {
  return { providers: [], quotaWindowIds: {}, roles: [], ratings: emptyRatings(), caveats: [] };
}

function emptyRatings() {
  const missing = () => ({ value: null, confidence: 0, source: "missing" });
  return { capability: missing(), taste: missing(), publicRating: missing(), coachability: missing(), efficiency: missing() };
}

function safeDistribution(value) {
  return {
    count: finiteCount(value?.count),
    p50: finiteNumberOrNull(value?.p50),
    p90: finiteNumberOrNull(value?.p90),
    min: finiteNumberOrNull(value?.min),
    max: finiteNumberOrNull(value?.max),
  };
}

function finiteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function validDateString(value) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function safeMtime(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function clampNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}

function roundNumber(value) {
  return Math.round(value * 100) / 100;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

async function readJSONBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    badRequest("request body must be valid JSON");
  }
}

function sendHTML(response, html) {
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

function sendJSON(response, status, payload) {
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'none'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function openBrowser(url) {
  const child = spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error(`all-models-patch dashboard: could not open browser: ${error.message}`));
  child.unref();
}

function listen(server, port, host) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}

function waitForShutdown(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    const shutdown = () => server.close((error) => error ? rejectPromise(error) : resolvePromise());
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    server.once("close", () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    });
  });
}
