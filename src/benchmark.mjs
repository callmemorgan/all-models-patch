import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

export const BENCHMARK_SCHEMA_VERSION = 1;
export const BENCHMARK_FIXTURE_ID = "raw-v1";
export const BENCHMARK_HEADER = "X-Claude-All-Benchmark-ID";
export const DEFAULT_WARMUPS = 1;
export const DEFAULT_RUNS = 3;

export const BENCHMARK_PROMPT = `Produce exactly 256 lines and nothing else.
For each integer from 1 through 256, output one line in ascending order using this exact format:
NNN benchmark response calibration token
Replace NNN with the integer zero-padded to three digits, beginning with 001 and ending with 256.
Do not use a code fence, heading, introduction, conclusion, tool, or commentary.`;

const fixtureHash = createHash("sha256").update(BENCHMARK_PROMPT).digest("hex");

export function parseBenchmarkOptions(argv, paths) {
  const options = {
    agents: null,
    warmups: DEFAULT_WARMUPS,
    runs: DEFAULT_RUNS,
    seed: null,
    output: null,
    json: false,
  };
  const valueOptions = new Set(["--agents", "--warmups", "--runs", "--seed", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (!valueOptions.has(arg)) throw new Error(`unknown benchmark option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    index += 1;
    if (arg === "--agents") {
      const agents = value.split(",").map((item) => item.trim()).filter(Boolean);
      options.agents = agents.length === 1 && agents[0] === "all" ? null : agents;
      if (options.agents?.length === 0) throw new Error("--agents requires at least one agent name");
    } else if (arg === "--warmups") {
      options.warmups = parseCount(value, "--warmups", true);
    } else if (arg === "--runs") {
      options.runs = parseCount(value, "--runs", false);
    } else if (arg === "--seed") {
      options.seed = value;
    } else if (arg === "--output") {
      options.output = resolve(value);
    }
  }
  options.stateDirectory = paths.stateDirectory;
  return options;
}

export async function runBenchmark(options, dependencies = {}) {
  const deps = {
    readFile: readFileSync,
    makeRunID: randomUUID,
    spawnClaude: runClaudeProcess,
    fetch: globalThis.fetch,
    now: () => new Date(),
    clock: () => performance.now(),
    progress: (line) => process.stderr.write(`${line}\n`),
    ...dependencies,
  };
  if (typeof deps.fetch !== "function") throw new Error("benchmark requires fetch support");

  const agentsPath = join(options.home, ".cli-proxy-api", "claude-all-agents.json");
  const keyPath = join(options.home, ".cli-proxy-api", "client-key");
  const launcher = options.launcher ?? join(options.localBin, "claude-all");
  const agentBundle = loadAgentBundle(agentsPath, deps.readFile);
  const selectedAgents = selectAgents(agentBundle, options.agents);
  const clientKey = String(deps.readFile(keyPath, "utf8")).trim();
  if (!clientKey) throw new Error(`proxy credential is empty: ${keyPath}`);

  const runID = deps.makeRunID();
  const seed = options.seed ?? runID;
  const startedAt = deps.now();
  const outputDirectory = options.output ?? join(options.stateDirectory, "benchmarks", `${safeTimestamp(startedAt)}-${runID}`);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const samplesPath = join(outputDirectory, "samples.jsonl");
  const proxyBaseURL = assertLoopbackProxyURL(
    String(options.proxyBaseURL ?? process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, ""),
  );
  await verifyTelemetryEndpoint(proxyBaseURL, clientKey, deps.fetch, deps.makeRunID());
  const sampleStream = createWriteStream(samplesPath, { flags: "wx", mode: 0o600 });
  let streamFailure = null;
  sampleStream.on("error", (error) => { streamFailure ??= error; });

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "claude-all-benchmark-"));
  const samples = [];
  let activeChild = null;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  let aborted = null;
  try {
    const rounds = buildRounds(selectedAgents.map(([name]) => name), options.warmups, options.runs, seed);
    const total = rounds.reduce((count, round) => count + round.agents.length, 0);
    let ordinal = 0;
    for (const round of rounds) {
      for (const agentName of round.agents) {
        if (interrupted) break;
        ordinal += 1;
        const configuredModel = agentBundle[agentName].model;
        const benchmarkID = deps.makeRunID();
        deps.progress(`[${ordinal}/${total}] ${round.phase} ${agentName} (${configuredModel})`);
        let processResult;
        try {
          processResult = await deps.spawnClaude({
            launcher,
            cwd: temporaryDirectory,
            agent: agentName,
            benchmarkID,
            prompt: BENCHMARK_PROMPT,
            environment: process.env,
            clock: deps.clock,
            onChild: (child) => { activeChild = child; },
          });
        } catch (error) {
          activeChild = null;
          aborted = `could not run ${launcher}: ${error.message}`;
          break;
        }
        activeChild = null;
        if (streamFailure) {
          aborted = `could not write ${samplesPath}: ${streamFailure.message}`;
          break;
        }
        let usage;
        if (interrupted) {
          usage = { schema_version: 1, benchmark_id: benchmarkID, records: [], error: "benchmark interrupted" };
        } else {
          try {
            usage = await pollBenchmarkUsage(proxyBaseURL, clientKey, benchmarkID, deps.fetch);
          } catch (error) {
            usage = { schema_version: 1, benchmark_id: benchmarkID, records: [], error: error.message };
          }
        }
        const sample = buildSample({
          runID,
          benchmarkID,
          agentName,
          configuredModel,
          phase: round.phase,
          round: round.number,
          ordinal,
          processResult,
          usage,
          timestamp: deps.now(),
        });
        samples.push(sample);
        try {
          await writeJSONLine(sampleStream, sample);
        } catch (error) {
          aborted = `could not write ${samplesPath}: ${error.message}`;
          break;
        }
      }
      if (interrupted || aborted) break;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    // The stream carries its own error listener, so a close failure is already
    // recorded in streamFailure; never let it mask the partial-result summary.
    await closeStream(sampleStream).catch((error) => { streamFailure ??= error; });
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  if (!aborted && streamFailure) aborted = `could not write ${samplesPath}: ${streamFailure.message}`;

  const summary = summarizeRun({
    runID,
    seed,
    startedAt,
    completedAt: deps.now(),
    outputDirectory,
    options,
    selectedAgents,
    samples,
    interrupted,
    aborted,
  });
  writeFileSync(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  const markdown = formatBenchmarkMarkdown(summary);
  writeFileSync(join(outputDirectory, "summary.md"), `${markdown}\n`, { mode: 0o600 });
  return { summary, markdown, exitCode: summary.exitCode };
}

export function loadAgentBundle(path, readFile = readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(String(readFile(path, "utf8")));
  } catch (error) {
    throw new Error(`could not read agent bundle ${path}: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`agent bundle must be an object: ${path}`);
  for (const [name, definition] of Object.entries(parsed)) {
    if (!name.trim() || !definition || typeof definition !== "object" || typeof definition.model !== "string" || !definition.model.trim()) {
      throw new Error(`agent bundle entry ${JSON.stringify(name)} is missing a model`);
    }
  }
  if (Object.keys(parsed).length === 0) throw new Error(`agent bundle is empty: ${path}`);
  return parsed;
}

export function selectAgents(bundle, requested) {
  const names = requested ?? Object.keys(bundle);
  const seen = new Set();
  const selected = [];
  for (const name of names) {
    if (!Object.hasOwn(bundle, name)) throw new Error(`unknown benchmark agent: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate benchmark agent: ${name}`);
    seen.add(name);
    selected.push([name, bundle[name].model]);
  }
  return selected;
}

export function buildRounds(agentNames, warmups, runs, seed) {
  const random = seededRandom(seed);
  const rounds = [];
  for (let number = 1; number <= warmups; number += 1) {
    rounds.push({ phase: "warmup", number, agents: shuffle(agentNames, random) });
  }
  for (let number = 1; number <= runs; number += 1) {
    rounds.push({ phase: "measured", number, agents: shuffle(agentNames, random) });
  }
  return rounds;
}

export async function runClaudeProcess({ launcher, cwd, agent, benchmarkID, prompt, environment, clock, onChild }) {
  const args = buildClaudeArguments(agent, prompt);
  const env = {
    ...environment,
    ANTHROPIC_CUSTOM_HEADERS: appendBenchmarkHeader(environment.ANTHROPIC_CUSTOM_HEADERS, benchmarkID),
  };
  const started = clock();
  const stream = createStreamAccumulator(started);
  let stderr = "";
  const child = spawn(launcher, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  onChild?.(child);
  child.stdout.on("data", (chunk) => stream.consume(chunk, clock()));
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
  });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => resolvePromise({ code, signal }));
  });
  stream.finish(clock());
  return {
    exitCode: result.code,
    signal: result.signal,
    wallDurationMS: Math.max(0, clock() - started),
    stderr: sanitizeError(stderr),
    ...stream.result(),
  };
}

export function buildClaudeArguments(agent, prompt) {
  return [
    "--bare",
    "-p",
    "--agent", agent,
    "--max-turns", "1",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--permission-mode", "plan",
    "--tools", "",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    prompt,
  ];
}

export function createStreamAccumulator(startedAt) {
  let buffer = "";
  let text = "";
  let firstContentMS = null;
  let lastContentMS = null;
  let finalAssistantText = "";
  let finalModel = "";
  let streamError = "";
  let parseErrors = 0;

  function processLine(line, timestamp) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors += 1;
      return;
    }
    if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
      const delta = String(event.event.delta.text ?? "");
      if (delta) {
        if (firstContentMS === null) firstContentMS = Math.max(0, timestamp - startedAt);
        lastContentMS = Math.max(0, timestamp - startedAt);
        text += delta;
      }
    }
    if (event.type === "assistant" && event.message) {
      finalModel = String(event.message.model ?? finalModel);
      const content = Array.isArray(event.message.content)
        ? event.message.content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("")
        : "";
      if (content) finalAssistantText = content;
    }
    if (event.type === "result" && event.subtype && event.subtype !== "success") {
      const detail = event.error ?? event.result ?? event.subtype;
      streamError = sanitizeError(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
  }

  return {
    consume(chunk, timestamp) {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        processLine(line, timestamp);
      }
    },
    finish(timestamp) {
      if (buffer.trim()) processLine(buffer, timestamp);
      buffer = "";
      if (!text && finalAssistantText) {
        text = finalAssistantText;
        firstContentMS = Math.max(0, timestamp - startedAt);
        lastContentMS = firstContentMS;
      }
    },
    result() {
      const validation = validateFixtureOutput(text);
      return {
        firstContentMS,
        lastContentMS,
        visibleCharacters: [...text].length,
        visibleBytes: Buffer.byteLength(text),
        visibleLines: validation.lineCount,
        formatOK: validation.ok,
        finalModel,
        streamError,
        parseErrors,
      };
    },
  };
}

export function validateFixtureOutput(text) {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = normalized ? normalized.split("\n") : [];
  if (lines.length !== 256) return { ok: false, lineCount: lines.length };
  for (let index = 0; index < lines.length; index += 1) {
    const expected = `${String(index + 1).padStart(3, "0")} benchmark response calibration token`;
    if (lines[index] !== expected) return { ok: false, lineCount: lines.length };
  }
  return { ok: true, lineCount: lines.length };
}

export function buildSample({ runID, benchmarkID, agentName, configuredModel, phase, round, ordinal, processResult, usage, timestamp }) {
  const generated = usage.records.filter((record) => record.generate !== false);
  const successful = generated.filter((record) => !record.failed && Number(record.tokens?.output_tokens) > 0);
  const selected = [...successful].sort((left, right) => Number(right.tokens?.output_tokens ?? 0) - Number(left.tokens?.output_tokens ?? 0))[0]
    ?? generated.at(-1)
    ?? null;
  const outputTokens = Number(selected?.tokens?.output_tokens ?? 0);
  const latencyMS = Number(selected?.latency_ms ?? 0);
  const ttftMS = Number(selected?.ttft_ms ?? 0);
  const decodeWindowMS = latencyMS - ttftMS;
  const visibleWindowMS = processResult.firstContentMS !== null && processResult.lastContentMS !== null
    ? processResult.lastContentMS - processResult.firstContentMS
    : 0;
  const reasons = [];
  if (phase !== "measured") reasons.push("warmup");
  if (processResult.exitCode !== 0) reasons.push("process_failed");
  if (!selected || selected.failed) reasons.push("generation_failed");
  if (outputTokens < 512) reasons.push("short_output");
  if (!(decodeWindowMS > 0)) reasons.push("invalid_timing");
  // A response that does not reproduce the fixture exactly did different work,
  // so its timings are not comparable and must stay out of the distributions.
  if (!processResult.formatOK) reasons.push("format_failed");
  const valid = phase === "measured" && reasons.length === 0;
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runID,
    benchmarkID,
    timestamp: timestamp.toISOString(),
    fixture: { id: BENCHMARK_FIXTURE_ID, sha256: fixtureHash },
    agent: agentName,
    configuredModel,
    phase,
    round,
    ordinal,
    process: {
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      wallDurationMS: roundNumber(processResult.wallDurationMS),
      firstContentMS: nullableRound(processResult.firstContentMS),
      lastContentMS: nullableRound(processResult.lastContentMS),
      finalModel: processResult.finalModel,
      parseErrors: processResult.parseErrors,
      error: processResult.stderr || processResult.streamError || null,
    },
    output: {
      visibleCharacters: processResult.visibleCharacters,
      visibleBytes: processResult.visibleBytes,
      visibleLines: processResult.visibleLines,
      formatOK: processResult.formatOK,
    },
    telemetry: {
      recordCount: generated.length,
      retryCount: generated.filter((record) => record.failed).length,
      attempts: generated,
      selectedAttempt: selected,
      error: usage.error ?? null,
    },
    metrics: {
      ttftMS: selected ? ttftMS : null,
      latencyMS: selected ? latencyMS : null,
      postFirstTokenTPS: decodeWindowMS > 0 ? roundNumber(outputTokens / (decodeWindowMS / 1000)) : null,
      endToEndTPS: processResult.wallDurationMS > 0 ? roundNumber(outputTokens / (processResult.wallDurationMS / 1000)) : null,
      visibleCharactersPerSecond: visibleWindowMS > 0
        ? roundNumber(processResult.visibleCharacters / (visibleWindowMS / 1000))
        : null,
    },
    valid,
    excludedReasons: reasons,
  };
}

export function summarizeRun({ runID, seed, startedAt, completedAt, outputDirectory, options, selectedAgents, samples, interrupted, aborted = null }) {
  const agents = selectedAgents.map(([name, configuredModel]) => {
    const measured = samples.filter((sample) => sample.agent === name && sample.phase === "measured");
    const valid = measured.filter((sample) => sample.valid);
    const routeNames = [...new Set(valid.map((sample) => {
      const record = sample.telemetry.selectedAttempt;
      return [record.provider, record.model].filter(Boolean).join("/");
    }).filter(Boolean))];
    return {
      name,
      configuredModel,
      routes: routeNames,
      measuredSamples: measured.length,
      validSamples: valid.length,
      formatPasses: measured.filter((sample) => sample.output.formatOK).length,
      retries: measured.reduce((count, sample) => count + sample.telemetry.retryCount, 0),
      ttftMS: distribution(valid.map((sample) => sample.metrics.ttftMS)),
      latencyMS: distribution(valid.map((sample) => sample.metrics.latencyMS)),
      postFirstTokenTPS: distribution(valid.map((sample) => sample.metrics.postFirstTokenTPS)),
      endToEndTPS: distribution(valid.map((sample) => sample.metrics.endToEndTPS)),
      visibleCharactersPerSecond: distribution(valid.map((sample) => sample.metrics.visibleCharactersPerSecond)),
    };
  });
  agents.sort((a, b) => (b.postFirstTokenTPS.p50 ?? -1) - (a.postFirstTokenTPS.p50 ?? -1));
  const incomplete = interrupted || Boolean(aborted) || agents.some((agent) => agent.validSamples === 0);
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runID,
    fixture: { id: BENCHMARK_FIXTURE_ID, sha256: fixtureHash },
    seed,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    outputDirectory,
    defaults: { warmups: options.warmups, runs: options.runs, serial: true },
    interrupted,
    aborted,
    sampleCount: samples.length,
    agents,
    exitCode: incomplete ? 2 : 0,
  };
}

export function formatBenchmarkMarkdown(summary) {
  const lines = [
    `# claude-all raw benchmark`,
    "",
    `Run: \`${summary.runID}\`  `,
    `Fixture: \`${summary.fixture.id}\`  `,
    `Samples: ${summary.sampleCount}  `,
    `Artifacts: \`${summary.outputDirectory}\``,
    "",
    "| Agent | Concrete route | Valid | TTFT p50/p90 | Decode tok/s p50/p90 | Wall tok/s p50/p90 | Format | Retries |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const agent of summary.agents) {
    lines.push(`| ${agent.name} | ${agent.routes.join(", ") || "—"} | ${agent.validSamples}/${agent.measuredSamples} | ${formatPair(agent.ttftMS, " ms")} | ${formatPair(agent.postFirstTokenTPS)} | ${formatPair(agent.endToEndTPS)} | ${agent.formatPasses}/${agent.measuredSamples} | ${agent.retries} |`);
  }
  if (summary.interrupted) lines.push("", "Run interrupted; artifacts contain partial results.");
  if (summary.aborted) lines.push("", `Run aborted: ${summary.aborted}. Artifacts contain partial results.`);
  return lines.join("\n");
}

// The proxy is trusted with the client key, so it must be local. Without this
// an inherited ANTHROPIC_BASE_URL would send the credential to any host.
export function assertLoopbackProxyURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`benchmark proxy URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`benchmark proxy URL must use http or https: ${value}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(
      `benchmark proxy URL must be loopback because it receives the proxy client key: ${value}`,
    );
  }
  return value;
}

async function verifyTelemetryEndpoint(baseURL, clientKey, fetchImpl, unknownID) {
  const response = await fetchImpl(`${baseURL}/v1/benchmark/usage/${unknownID}`, {
    headers: { Authorization: `Bearer ${clientKey}` },
  });
  if (response.status !== 404) {
    throw new Error(`benchmark telemetry preflight failed: expected HTTP 404, received ${response.status}`);
  }
  // A proxy without the route answers 404 with an empty body, so a bare status
  // check proves nothing; every sample would then poll the full window and time
  // out. The route's own not-found payload is the signal that it exists.
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const reported = typeof payload?.error === "string" ? payload.error.toLowerCase() : "";
  if (!reported.includes("benchmark usage")) {
    throw new Error(
      `benchmark telemetry endpoint is not implemented by the proxy at ${baseURL}: ` +
      "the unknown-id probe did not return the benchmark usage not-found payload",
    );
  }
}

async function pollBenchmarkUsage(baseURL, clientKey, benchmarkID, fetchImpl) {
  const deadline = performance.now() + 10_000;
  let delayMS = 100;
  while (true) {
    let response = null;
    try {
      response = await fetchImpl(`${baseURL}/v1/benchmark/usage/${benchmarkID}`, {
        headers: { Authorization: `Bearer ${clientKey}` },
      });
    } catch (error) {
      // A reset or refused connection is transient; fall through to the
      // backoff below and keep using the retry window.
      if (performance.now() >= deadline) {
        throw new Error(`benchmark telemetry request failed for ${benchmarkID}: ${error.message}`);
      }
    }
    if (response?.ok) {
      const payload = await response.json();
      if (payload.schema_version !== 1 || payload.benchmark_id !== benchmarkID || !Array.isArray(payload.records)
          || !payload.records.every((record) => record !== null && typeof record === "object")) {
        throw new Error(`invalid benchmark telemetry response for ${benchmarkID}`);
      }
      return payload;
    }
    if (response && response.status !== 404) {
      throw new Error(`benchmark telemetry request failed with HTTP ${response.status}`);
    }
    if (performance.now() >= deadline) throw new Error(`timed out waiting for benchmark telemetry ${benchmarkID}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMS));
    delayMS = Math.min(1000, delayMS * 2);
  }
}

function appendBenchmarkHeader(existing, benchmarkID) {
  const current = String(existing ?? "").trim();
  if (current.toLowerCase().includes(BENCHMARK_HEADER.toLowerCase())) {
    throw new Error(`${BENCHMARK_HEADER} is already present in ANTHROPIC_CUSTOM_HEADERS`);
  }
  const header = `${BENCHMARK_HEADER}: ${benchmarkID}`;
  return current ? `${current}\n${header}` : header;
}

function distribution(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

function nearestRank(sorted, percentile) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function shuffle(values, random) {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

function seededRandom(seed) {
  let state = createHash("sha256").update(String(seed)).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function parseCount(value, name, allowZero) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  const count = Number(value);
  if (!Number.isSafeInteger(count) || (!allowZero && count === 0)) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  return count;
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sanitizeError(stderr) {
  const line = String(stderr).split("\n").map((value) => value.trim()).find(Boolean) ?? "";
  return line.slice(0, 1000);
}

function roundNumber(value) {
  return Math.round(value * 100) / 100;
}

function nullableRound(value) {
  return value === null ? null : roundNumber(value);
}

function formatPair(distributionValue, suffix = "") {
  if (distributionValue.p50 === null) return "—";
  return `${distributionValue.p50}${suffix} / ${distributionValue.p90}${suffix}`;
}

function writeJSONLine(stream, value) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(`${JSON.stringify(value)}\n`, (error) => error ? rejectPromise(error) : resolvePromise());
  });
}

function closeStream(stream) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.on("error", rejectPromise);
    stream.end(resolvePromise);
  });
}
